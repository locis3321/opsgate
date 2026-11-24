/**
 * 原生资产连通性测试必须覆盖所有原生品类（2026-11-24 用户实测发现）。
 *
 * 背景：新增 redis / kafka 原生品类后，`POST /servers/:id/test` 对它们返回
 * `400 不支持的原生品类 kafka 连通性测试` —— 因为 `probeHttpNative` 只写了
 * zabbix / rocketmq / nacos 三个分支，redis/kafka 落到最后的兜底 400。
 *
 * 这不是"连不上"，而是**根本没写探活逻辑**。本测试锁定：
 *  - redis / kafka 不再返回 400（品类不支持）
 *  - 连不通的地址返回 502（连接失败）—— 证明真的去连了
 *  - 既无 url 也无槽位地址时，返回明确错误而不是崩
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
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'probe-k-')), 'k'));
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

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }
async function api(method: 'POST' | 'GET', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function createNative(category: string, url?: string, suffix = ''): Promise<string> {
  const r = await api('POST', '/api/v1/servers', {
    name: `probe-${category}${suffix}`,
    type: 'native',
    executionMode: 'native',
    category,
    ...(url ? { url, allowPrivateNetwork: true } : {}),
  });
  if (r.status !== 200) throw new Error(`create ${category} failed: ${r.json.message}`);
  return (r.json.data as { id: string }).id;
}

describe('原生资产连通性测试覆盖所有原生品类', () => {
  it('redis 不再返回「不支持的原生品类」', async () => {
    const id = await createNative('redis', 'redis://127.0.0.1:1/0');
    const r = await api('POST', `/api/v1/servers/${id}/test`, {});
    // 关键断言：不是 400（品类不支持），而是真的去连了（连不上 → 502）
    expect(r.status, `unexpected body: ${JSON.stringify(r.json)}`).not.toBe(400);
    expect(r.json.message).not.toContain('不支持的原生品类');
    expect(r.status).toBe(502);
    expect(r.json.message).toContain('连通性测试失败');
  }, 30_000);

  it('kafka 不再返回「不支持的原生品类」', async () => {
    const id = await createNative('kafka', 'kafka://127.0.0.1:1');
    const r = await api('POST', `/api/v1/servers/${id}/test`, {});
    expect(r.status, `unexpected body: ${JSON.stringify(r.json)}`).not.toBe(400);
    expect(r.json.message).not.toContain('不支持的原生品类');
    expect(r.status).toBe(502);
    expect(r.json.message).toContain('连通性测试失败');
  }, 30_000);

  it('redis 无 url 且无槽位地址 → 明确报错而不是崩', async () => {
    const id = await createNative('redis', undefined, '-nourl');
    const r = await api('POST', `/api/v1/servers/${id}/test`, {});
    expect(r.status).not.toBe(200);
    // 解析器给出的错误应指向"未配置地址"
    expect(r.json.message).toMatch(/未配置|地址/);
  }, 30_000);

  it('kafka 无 url 且无槽位地址 → 明确报错而不是崩', async () => {
    const id = await createNative('kafka', undefined, '-nourl');
    const r = await api('POST', `/api/v1/servers/${id}/test`, {});
    expect(r.status).not.toBe(200);
    expect(r.json.message).toMatch(/未配置|broker/i);
  }, 30_000);
});
