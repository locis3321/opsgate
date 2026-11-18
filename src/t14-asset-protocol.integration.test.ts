/**
 * 资产协议契约测试（资产页整改 T1）：
 * - servers.type 为传输协议（stdio|http|sse|native），与 category（业务品类）正交
 * - http/sse 必须带 url；stdio 不带 url；sse 不带 command（fail-closed，源头报错）
 * - headers 落库并可回读（此前 POST /servers 丢弃 headers，HTTP/SSE 资产无法带鉴权头）
 * - headers 中的 ref.<凭证名>.<键名> 走与 env/args 同一套校验（存在 + 同主）
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
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CredentialService } from './services/credentials.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';
import { buildPlan, transportOf } from './services/instancePlan.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let cookie: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite,
    credentials, runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'rt-')),
  });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username: 'alice', password: 'password-12345' },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc];
  cookie = arr[0]!.split(';')[0]!;
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); });

interface Json { code: number; data: unknown; message: string }

async function api(method: string, url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

describe('资产传输协议契约（servers.type）', () => {
  it('sse 资产：带 url 落库成功，type=sse，headers 可回读', async () => {
    const r = await api('POST', '/api/v1/servers', {
      name: 'sse-asset-01',
      type: 'sse',
      executionMode: 'mcp',
      category: 'other',
      url: 'http://1.1.1.1:8080/sse',
      headers: { Authorization: 'Bearer abc' },
    });
    expect(r.status).toBe(200);
    const id = (r.json.data as { id: string }).id;
    const got = await api('GET', `/api/v1/servers/${id}`);
    const row = got.json.data as { type: string; headers: Record<string, string> | null };
    expect(row.type).toBe('sse');
    expect(row.headers).toEqual({ Authorization: 'Bearer abc' });
  });

  it('sse 缺 url → 400（fail-closed，不落库）', async () => {
    const r = await api('POST', '/api/v1/servers', {
      name: 'sse-asset-bad', type: 'sse', executionMode: 'mcp', category: 'other',
    });
    expect(r.status).toBe(400);
    const count = sqlite.prepare("SELECT COUNT(*) c FROM servers WHERE name='sse-asset-bad'").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('stdio 带 url → 400；stdio 缺 command 且无 url → 400', async () => {
    const withUrl = await api('POST', '/api/v1/servers', {
      name: 'stdio-bad-01', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'npx', url: 'http://1.1.1.1:8080/x',
    });
    expect(withUrl.status).toBe(400);
    const noCmd = await api('POST', '/api/v1/servers', {
      name: 'stdio-bad-02', type: 'stdio', executionMode: 'mcp', category: 'other',
    });
    expect(noCmd.status).toBe(400);
  });

  it('type 非法值 → 400（枚举收窄到 stdio|http|sse|native）', async () => {
    const r = await api('POST', '/api/v1/servers', {
      name: 'bad-type-01', type: 'websocket', executionMode: 'mcp', category: 'other', url: 'http://1.1.1.1:8080',
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('stdio|http|sse|native');
  });

  it('headers 中的 ref 引用走与 env/args 同一套校验（凭证不存在 → 400）', async () => {
    const r = await api('POST', '/api/v1/servers', {
      name: 'sse-ref-bad', type: 'sse', executionMode: 'mcp', category: 'other',
      url: 'http://1.1.1.1:8080/sse',
      headers: { Authorization: 'ref.no-such-cred.token' },
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('不存在');
  });

  it('headers 中的 ref 引用命中本人凭证 → 通过', async () => {
    const cred = await api('POST', '/api/v1/credentials', { name: 'alice-http-cred', values: { token: 'tk-1' } });
    expect(cred.status).toBe(200);
    const r = await api('POST', '/api/v1/servers', {
      name: 'sse-ref-ok', type: 'sse', executionMode: 'mcp', category: 'other',
      url: 'http://1.1.1.1:8080/sse',
      headers: { Authorization: 'ref.alice-http-cred.token' },
    });
    expect(r.status).toBe(200);
  });
});

describe('传输协议 → 实例计划', () => {
  it('transportOf：type 映射到传输协议', () => {
    expect(transportOf('stdio')).toBe('stdio');
    expect(transportOf('http')).toBe('http');
    expect(transportOf('sse')).toBe('sse');
    expect(transportOf(null)).toBe('stdio');
  });

  it('buildPlan：sse 计划携带 transport=sse；stdio 携带 url → 抛错', () => {
    const base = { id: 'srv-1', configHash: 'h', args: [], env: {}, credentialSlots: [] };
    const sse = buildPlan({ ...base, command: null, url: 'http://1.1.1.1:8080/sse', transport: 'sse' }, [], '/tmp');
    expect(sse.transport).toBe('sse');
    expect(sse.command).toBeNull();
    expect(() => buildPlan({ ...base, command: 'npx', url: 'http://1.1.1.1:8080', transport: 'stdio' }, [], '/tmp')).toThrow();
  });
});
