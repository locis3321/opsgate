/**
 * 原生 Market 条目的「地址可来自槽位」（2026-11-24 用户实测发现）。
 *
 * 用户填了 REDIS_HOST + REDIS_PORT 却被要求"请填写管理 API 地址"——因为
 * `POST /market/instantiate` 对原生条目硬性要求 url。但 redis/kafka 的连接
 * 解析器本来就支持从槽位取地址，两条口径不一致。
 *
 * 本测试锁定：
 *  - redis/kafka 条目：url 留空 + 地址类槽位有值 → 创建成功，且 url 落库为 null
 *  - redis/kafka 条目：url 留空 + 地址槽位也没值 → 400 且提示要填槽位
 *  - 非 redis/kafka 原生条目（zabbix）：url 仍必填
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
import { insertEntry } from './db/marketEntries.js';
import type { CatalogEntry } from './services/marketCatalog.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

const REDIS_ENTRY: CatalogEntry = {
  key: 'test-redis-native',
  name: 'redis',
  displayName: 'Redis 测试条目',
  description: '',
  repository: 'https://example.invalid/redis',
  categories: ['redis'],
  tags: ['redis'],
  runtime: 'npm',
  executionMode: 'native',
  slotLabels: { REDIS_HOST: '地址', REDIS_PORT: '端口', REDIS_PASSWORD: '密码' },
  installations: { npm: {} },
};

const ZABBIX_ENTRY: CatalogEntry = {
  key: 'test-zabbix-native',
  name: 'zabbix',
  displayName: 'Zabbix 测试条目',
  description: '',
  repository: 'https://example.invalid/zabbix',
  categories: ['zabbix'],
  tags: ['zabbix'],
  runtime: 'npm',
  executionMode: 'native',
  slotLabels: { ZABBIX_TOKEN: 'Token' },
  installations: { npm: {} },
};

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
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'mkt-addr-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  insertEntry(db, REDIS_ENTRY, 'verified');
  insertEntry(db, ZABBIX_ENTRY, 'verified');
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

const rowOf = (name: string) => db.select().from(schema.servers).all().find((r) => r.name === name);

describe('原生 Market 条目：地址可来自槽位', () => {
  it('redis：url 留空 + 槽位给地址 → 创建成功，url 落库为 null', async () => {
    const r = await api('POST', '/api/v1/market/instantiate', {
      pkgName: 'test-redis-native',
      name: 'r-slot-addr',
      inlineValues: { REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379', REDIS_PASSWORD: 'p' },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const row = rowOf('r-slot-addr');
    expect(row, '资产未落库').toBeDefined();
    expect(row!.url).toBeNull();
    expect(row!.executionMode).toBe('native');
    expect(row!.category).toBe('redis');
  });

  it('redis：url 留空 + 槽位也没地址 → 400 且提示填槽位', async () => {
    const r = await api('POST', '/api/v1/market/instantiate', {
      pkgName: 'test-redis-native',
      name: 'r-no-addr',
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/REDIS_HOST|地址/);
  });

  it('redis：只给密码槽位（无地址槽位）→ 仍 400（不能建出连不上的资产）', async () => {
    const r = await api('POST', '/api/v1/market/instantiate', {
      pkgName: 'test-redis-native',
      name: 'r-pwd-only',
      inlineValues: { REDIS_PASSWORD: 'p' },
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/REDIS_HOST|地址/);
  });

  it('zabbix（非 redis/kafka）：url 仍必填', async () => {
    const r = await api('POST', '/api/v1/market/instantiate', {
      pkgName: 'test-zabbix-native',
      name: 'z-no-url',
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/管理 API 地址/);
  });

  it('zabbix 填了 url → 创建成功（对照，证明放宽只针对 redis/kafka）', async () => {
    const r = await api('POST', '/api/v1/market/instantiate', {
      pkgName: 'test-zabbix-native',
      name: 'z-with-url',
      url: 'http://127.0.0.1:18080',
      allowPrivateNetwork: true,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(rowOf('z-with-url')!.url).toBe('http://127.0.0.1:18080');
  });
});
