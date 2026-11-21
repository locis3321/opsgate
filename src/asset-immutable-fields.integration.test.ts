/**
 * 形态字段与执行配置**不可修改**（2026-11-21 用户纠正「放太开了」）。
 *
 * 用户原话：新建资产时能调整的只有标签、凭证绑定、信息和名称，编辑也只能编辑这些。
 * 因此 category / executionMode / type / command / args / env / headers 这些字段
 * 在 PATCH 上必须**显式拒绝**，而不是静默忽略——静默忽略会让调用方以为改成功了。
 *
 * 仍可修改的：name / displayName / description / tags / hostConn / url / 安全开关，
 * 那些由 asset-edit.integration.test.ts 覆盖。
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

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'immutable-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, credentials,
    instancePool: { invalidate: () => {}, acquire: async () => { throw new Error('unused'); }, release: async () => {}, releaseAll: async () => {}, prewarm: async () => 0 } as never,
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
const getRow = async (id: string) => (await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get())!;

async function makeMcpStdio(name: string): Promise<string> {
  const r = await api('POST', '/api/v1/servers', {
    name, type: 'stdio', executionMode: 'mcp', category: 'other',
    command: 'node', args: ['server.js'],
  });
  if (r.status !== 200) throw new Error(r.json.message);
  return (r.json.data as { id: string }).id;
}

describe('形态与执行配置创建后不可修改', { timeout: 20_000 }, () => {
  it('category / executionMode / type 全部 400，且不落库', async () => {
    const id = await makeMcpStdio('imm-shape');
    const before = await getRow(id);

    for (const bad of [{ category: 'monitor' }, { executionMode: 'native' }, { type: 'http' }]) {
      const r = await api('PATCH', `/api/v1/servers/${id}`, bad);
      expect(r.status).toBe(400);
      expect(r.json.message).toMatch(/不可修改/);
    }

    const after = await getRow(id);
    expect(after.category).toBe(before.category);
    expect(after.executionMode).toBe(before.executionMode);
    expect(after.type).toBe(before.type);
  });

  it('command / args / env / headers 全部 400，且不落库', async () => {
    const id = await makeMcpStdio('imm-exec');
    const before = await getRow(id);

    for (const bad of [
      { command: 'deno' },
      { args: ['other.js'] },
      { env: { A: '1' } },
      { headers: { 'X-Test': '1' } },
    ]) {
      const r = await api('PATCH', `/api/v1/servers/${id}`, bad);
      expect(r.status).toBe(400);
      expect(r.json.message).toMatch(/不可修改/);
    }

    const after = await getRow(id);
    expect(after.command).toBe(before.command);
    expect(after.args).toEqual(before.args);
    expect(after.env).toEqual(before.env);
  });

  it('混合请求（合法字段 + 非法字段）整批拒绝，合法字段也不生效', async () => {
    const id = await makeMcpStdio('imm-mixed');
    const r = await api('PATCH', `/api/v1/servers/${id}`, { displayName: '想改的名字', category: 'monitor' });
    expect(r.status).toBe(400);
    expect((await getRow(id)).displayName).toBeNull();
  });

  it('允许的字段照常可改（对照，证明拒绝不是一刀切）', async () => {
    const id = await makeMcpStdio('imm-allowed');
    const r = await api('PATCH', `/api/v1/servers/${id}`, { displayName: '显示名', description: '说明', tags: ['a'] });
    expect(r.status).toBe(200);
    const row = await getRow(id);
    expect(row.displayName).toBe('显示名');
    expect(row.description).toBe('说明');
    expect(row.tags).toEqual(['a']);
  });
});
