/**
 * 回归测试：资产创建后修改连接参数与执行配置。
 *
 * 用户反馈（2026-11-20）：`tke-vm-32-6-tencentos-host-32-6` 端口填成 222（应为 22322），
 * 创建完成后没有任何 UI 入口能改 —— 此前 PATCH 只开放 authPassSlot。
 *
 * 本文件锁定第 1 批（连接参数）与第 2 批（执行配置 + 资产名）的关键行为：
 *  - 连接参数可改，且改后**清空 hostFingerprint**（换了目标旧指纹无效）并回收实例
 *  - 执行配置可改，且 env/args 里的 ref.<凭证>.<键> 重新校验
 *  - 资产名可改，但必须查重（name 有 UNIQUE 约束）
 *  - 非法输入显式 400，不静默忽略
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
let cookie: string;

const invalidated = new Set<string>();

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'asset-edit-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, credentials,
    instancePool: { invalidate: (k: string) => { invalidated.add(k); }, acquire: async () => { throw new Error('unused'); }, release: async () => {}, releaseAll: async () => {}, prewarm: async () => 0 } as never,
  });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username: 'alice', password: 'password-12345' },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const c = res.headers['set-cookie'];
  cookie = (Array.isArray(c) ? c : [c])[0]!.split(';')[0]!;
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); });

interface Json { code: number; data: unknown; message: string }

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function makeHost(id: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api('POST', '/api/v1/servers', {
    name: id, type: 'native', executionMode: 'native', category: 'host',
    hostConn: { host: '10.0.0.9', port: 22, username: 'root', authSlot: 'AUTH', hostFingerprint: 'SHA256:old' },
    credentialSlots: [{ target: 'env', name: 'AUTH', label: 'SSH', file: true }],
    ...extra,
  });
  if (r.status !== 200) throw new Error(`create ${id} failed: ${r.json.message}`);
  return (r.json.data as { id: string }).id;
}

const getRow = async (id: string) =>
  (await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get())!;

describe('连接参数可修改（第 1 批）', { timeout: 20_000 }, () => {
  it('改 port → 落库，且清空 hostFingerprint（旧指纹已失效）', async () => {
    const id = await makeHost('host-port');
    invalidated.clear();

    const r = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { port: 22322 } });
    expect(r.status).toBe(200);

    const row = await getRow(id);
    const hc = row.hostConn as Record<string, unknown>;
    expect(hc.port).toBe(22322);
    expect(hc.host).toBe('10.0.0.9');           // 未传的字段保持
    expect(hc.username).toBe('root');
    expect(hc.hostFingerprint).toBeUndefined(); // 关键：换了连接目标，旧指纹必须清掉
    expect(invalidated.size).toBeGreaterThan(0);
  });

  it('只改 username 不触碰指纹（同主机，指纹仍有效）', async () => {
    const id = await makeHost('host-user');
    const r = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { username: 'deploy' } });
    expect(r.status).toBe(200);
    const hc = (await getRow(id)).hostConn as Record<string, unknown>;
    expect(hc.username).toBe('deploy');
    expect(hc.hostFingerprint).toBe('SHA256:old');
  });

  it('改 host → 清指纹；非法 port / 空 host → 400', async () => {
    const id = await makeHost('host-host');
    const ok = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { host: '10.0.0.10' } });
    expect(ok.status).toBe(200);
    expect(((await getRow(id)).hostConn as Record<string, unknown>).hostFingerprint).toBeUndefined();

    const badPort = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { port: 0 } });
    expect(badPort.status).toBe(400);
    const badPort2 = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { port: 70000 } });
    expect(badPort2.status).toBe(400);
    const emptyHost = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { host: '  ' } });
    expect(emptyHost.status).toBe(400);
  });

  it('authSlot 必须是已声明的槽位', async () => {
    const id = await makeHost('host-authslot');
    const bad = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { authSlot: 'NOT_DECLARED' } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain('未声明');
  });

  it('非原生 host 资产不接受连接参数', async () => {
    const srv = await api('POST', '/api/v1/servers', {
      name: 'srv-mcp-x', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'node', args: ['-e', ''],
    });
    const id = (srv.json.data as { id: string }).id;
    const r = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { port: 22 } });
    expect(r.status).toBe(400);
  });
});

describe('资产名可修改（第 2 批）', { timeout: 20_000 }, () => {
  async function makeMcp(id: string): Promise<string> {
    const r = await api('POST', '/api/v1/servers', {
      name: id, type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'node', args: ['server.js'], env: { A: '1' },
    });
    return (r.json.data as { id: string }).id;
  }

  it('执行配置（command/args/env）已改为不可修改 → 400', async () => {
    const id = await makeMcp('mcp-cmd');
    const r = await api('PATCH', `/api/v1/servers/${id}`, {
      command: 'node', args: ['new.js'], env: { B: '2' },
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/不可修改/);
  });

  it('改 name → 落库；与既有资产重名 → 400', async () => {
    await makeMcp('taken-name');
    const id = await makeMcp('rename-me');
    const dup = await api('PATCH', `/api/v1/servers/${id}`, { name: 'taken-name' });
    expect(dup.status).toBe(400);
    expect(dup.json.message).toContain('已存在');

    const ok = await api('PATCH', `/api/v1/servers/${id}`, { name: 'renamed-ok' });
    expect(ok.status).toBe(200);
    expect((await getRow(id)).name).toBe('renamed-ok');
  });

  it('name 非法（非 DNS-1123）→ 400', async () => {
    const id = await makeMcp('bad-name');
    const r = await api('PATCH', `/api/v1/servers/${id}`, { name: '含中文 Name' });
    expect(r.status).toBe(400);
  });
});
