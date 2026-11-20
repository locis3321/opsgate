/**
 * T3 集成测试：批量信任主机指纹的分类与权限边界。
 * 不真连 SSH：只覆盖「跳过 / 无权 / 不存在 / ids 校验」这些不依赖网络的分支。
 * 真实握手由 T5 的浏览器实测覆盖。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CredentialService } from './services/credentials.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let aliceCookie: string;
let bobCookie: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 't3-trust-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  await createUserWithPassword(auth, { username: 'bob', password: 'password-12345', isAdmin: false });
  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, credentials });

  const aliceId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'alice')).get())!.id;
  // alice 的 host（有 authSlot，但槽位未绑凭证 → 计入 failed）
  await db.insert(schema.servers).values({
    id: 'host-unbound', name: 'host-unbound', type: 'native', executionMode: 'native', category: 'host',
    ownerId: aliceId, configHash: 'c1', credentialSlots: [],
    hostConn: { host: '127.0.0.1', port: 22, username: 'root', authSlot: 'AUTH' },
  }).run();
  // alice 的 mysql（mcp 模式）→ skipped
  await db.insert(schema.servers).values({
    id: 'mysql-mcp', name: 'mysql-mcp', type: 'stdio', executionMode: 'mcp', category: 'mysql',
    ownerId: aliceId, configHash: 'c2', credentialSlots: [],
  }).run();
  // alice 的 host 但无 authSlot → skipped
  await db.insert(schema.servers).values({
    id: 'host-noauth', name: 'host-noauth', type: 'native', executionMode: 'native', category: 'host',
    ownerId: aliceId, configHash: 'c3', credentialSlots: [],
    hostConn: { host: '127.0.0.1', port: 22, username: 'root' },
  }).run();

  const login = async (username: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const c = res.headers['set-cookie'];
    return (Array.isArray(c) ? c : [c])[0]!.split(';')[0]!;
  };
  aliceCookie = await login('alice');
  bobCookie = await login('bob');
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); });

interface Json { code: number; data: unknown; message: string }

async function api(cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

interface BatchResult {
  succeeded: Array<{ id: string; name: string; fingerprint: string }>;
  failed: Array<{ id: string; name: string; reason: string }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
}

describe('T3：批量信任主机指纹', { timeout: 30_000 }, () => {
  it('非主机 / 缺 authSlot → skipped；未绑凭证 → failed；互不影响', async () => {
    const r = await api(aliceCookie, 'POST', '/api/v1/servers/ssh/trust-fingerprint-batch', {
      ids: ['mysql-mcp', 'host-noauth', 'host-unbound'],
    });
    expect(r.status).toBe(200);
    const d = r.json.data as BatchResult;
    expect(d.succeeded).toHaveLength(0);
    expect(d.skipped.map((s) => s.id).sort()).toEqual(['host-noauth', 'mysql-mcp']);
    expect(d.failed.map((f) => f.id)).toEqual(['host-unbound']);
    expect(d.failed[0]!.reason).toContain('槽位未绑定');
    // 分类互斥：同一 id 不出现在两个桶里
    const all = [...d.succeeded, ...d.skipped, ...d.failed].map((x) => x.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('他人资产 / 不存在的 id → failed 且不中断其它项', async () => {
    const r = await api(bobCookie, 'POST', '/api/v1/servers/ssh/trust-fingerprint-batch', {
      ids: ['host-unbound', 'no-such-server', 'mysql-mcp'],
    });
    expect(r.status).toBe(200);
    const d = r.json.data as BatchResult;
    const failedIds = d.failed.map((f) => f.id).sort();
    expect(failedIds).toEqual(['host-unbound', 'mysql-mcp', 'no-such-server']);
    expect(d.failed.find((f) => f.id === 'host-unbound')!.reason).toContain('无权操作');
    // bob 对 mysql-mcp 也无权 → 计入 failed（不是 skipped：权限先于类型判定）
    expect(d.failed.find((f) => f.id === 'mysql-mcp')!.reason).toContain('无权操作');
  });

  it('权限先于类型判定：他人资产即便是 mcp 也计入 failed（非 skipped）', async () => {
    // 见上一条：bob 对 alice 的 mysql-mcp 得到「无权操作」而非「非原生执行」，
    // 说明批量路径先校验归属，不会借 skipped 的措辞泄露"这台是什么类型"。
    const r = await api(bobCookie, 'POST', '/api/v1/servers/ssh/trust-fingerprint-batch', { ids: ['mysql-mcp'] });
    const d = r.json.data as BatchResult;
    expect(d.failed).toHaveLength(1);
    expect(d.skipped).toHaveLength(0);
    expect(d.failed[0]!.reason).toContain('无权操作');
  });

  it('空 ids → 400；去重与上限', async () => {
    const empty = await api(aliceCookie, 'POST', '/api/v1/servers/ssh/trust-fingerprint-batch', { ids: [] });
    expect(empty.status).toBe(400);
    const bad = await api(aliceCookie, 'POST', '/api/v1/servers/ssh/trust-fingerprint-batch', { ids: [1, 2] });
    expect(bad.status).toBe(400);

    // 重复 id 只处理一次
    const dup = await api(aliceCookie, 'POST', '/api/v1/servers/ssh/trust-fingerprint-batch', {
      ids: ['mysql-mcp', 'mysql-mcp'],
    });
    const d = dup.json.data as BatchResult;
    expect(d.skipped).toHaveLength(1);
  });

  it('单台端点：非原生 → 400；未绑凭证 → 400', async () => {
    const nonHost = await api(aliceCookie, 'POST', '/api/v1/servers/mysql-mcp/ssh/trust-fingerprint');
    expect(nonHost.status).toBe(400);
    const unbound = await api(aliceCookie, 'POST', '/api/v1/servers/host-unbound/ssh/trust-fingerprint');
    expect(unbound.status).toBe(400);
    expect(unbound.json.message).toContain('槽位未绑定');
  });
});
