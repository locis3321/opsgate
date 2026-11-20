/**
 * T-标签 集成测试：资产标签的写入口（详情改标签 / 创建带标签 / Market 实例化带标签）
 * 与已存在标签的枚举（供前端"从已有标签选"）。
 *
 * 标签不是独立实体：没有全局标签表，删除 = 从某资产的 tags 数组里移除。
 * 但它不是纯展示：MCP `?tag=` 与 opsgate_select_scope({tag}) 均按精确值匹配，
 * 因此写入侧必须归一（去首尾空白、去空、去重、大小写保持原样）并限制数量/长度。
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
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'tag-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, credentials });

  const aliceId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'alice')).get())!.id;
  await db.insert(schema.servers).values({
    id: 'srv-tag-1', name: 'srv-tag-1', type: 'native', executionMode: 'native', category: 'host',
    ownerId: aliceId, configHash: 'c1', credentialSlots: [], tags: ['prod', 'TKE'],
    hostConn: { host: '127.0.0.1', username: 'root', authSlot: 'AUTH' },
  }).run();
  await db.insert(schema.servers).values({
    id: 'srv-tag-2', name: 'srv-tag-2', type: 'native', executionMode: 'native', category: 'mysql',
    ownerId: aliceId, configHash: 'c2', credentialSlots: [], tags: ['prod', '办公室'],
  }).run();
  await db.insert(schema.servers).values({
    id: 'srv-tag-3', name: 'srv-tag-3', type: 'native', executionMode: 'native', category: 'host',
    ownerId: aliceId, configHash: 'c3', credentialSlots: [], tags: [],
  }).run();

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

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

const tagsOf = async (id: string): Promise<string[]> =>
  ((await api('GET', `/api/v1/servers/${id}`)).json.data as { tags: string[] }).tags;

describe('T-标签：已有标签枚举', { timeout: 15_000 }, () => {
  it('返回可见资产的去重标签（按出现次数降序），不含空值', async () => {
    const r = await api('GET', '/api/v1/servers/tags');
    expect(r.status).toBe(200);
    const rows = r.json.data as Array<{ tag: string; count: number }>;
    const map = new Map(rows.map((x) => [x.tag, x.count]));
    expect(map.get('prod')).toBe(2);
    expect(map.get('TKE')).toBe(1);
    expect(map.get('办公室')).toBe(1);
    expect(rows.some((x) => x.tag.trim() === '')).toBe(false);
    // 降序：prod(2) 必须排在 TKE(1) 之前
    expect(rows.findIndex((x) => x.tag === 'prod')).toBeLessThan(rows.findIndex((x) => x.tag === 'TKE'));
  });
});

describe('T-标签：PATCH 修改标签', { timeout: 15_000 }, () => {
  it('增删标签；空数组 = 清空', async () => {
    const add = await api('PATCH', '/api/v1/servers/srv-tag-3', { tags: ['dev', '办公室'] });
    expect(add.status).toBe(200);
    expect((await tagsOf('srv-tag-3')).sort()).toEqual(['dev', '办公室']);

    const remove = await api('PATCH', '/api/v1/servers/srv-tag-3', { tags: ['办公室'] });
    expect(remove.status).toBe(200);
    expect(await tagsOf('srv-tag-3')).toEqual(['办公室']);

    const clear = await api('PATCH', '/api/v1/servers/srv-tag-3', { tags: [] });
    expect(clear.status).toBe(200);
    expect(await tagsOf('srv-tag-3')).toEqual([]);
  });

  it('归一：去首尾空白、去空串、去重；保留原始大小写', async () => {
    const r = await api('PATCH', '/api/v1/servers/srv-tag-3', { tags: ['  prod  ', '', '   ', 'TKE', 'prod', 'Prod'] });
    expect(r.status).toBe(200);
    const tags = await tagsOf('srv-tag-3');
    // 'prod' 与 'Prod' 是不同值（精确匹配语义），不能被合并；重复的 'prod' 只能留一个
    expect(tags).toEqual(['prod', 'TKE', 'Prod']);
  });

  it('非法输入 → 400：非数组 / 非字符串项 / 超长 / 超数量', async () => {
    const notArray = await api('PATCH', '/api/v1/servers/srv-tag-3', { tags: 'prod' });
    expect(notArray.status).toBe(400);
    const notString = await api('PATCH', '/api/v1/servers/srv-tag-3', { tags: [1] });
    expect(notString.status).toBe(400);
    const tooLong = await api('PATCH', '/api/v1/servers/srv-tag-3', { tags: ['x'.repeat(65)] });
    expect(tooLong.status).toBe(400);
    const tooMany = await api('PATCH', '/api/v1/servers/srv-tag-3', { tags: Array.from({ length: 33 }, (_, i) => `t${i}`) });
    expect(tooMany.status).toBe(400);
  });

  it('非归属人 → 403', async () => {
    const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
    await createUserWithPassword(auth, { username: 'bob', password: 'password-12345', isAdmin: false });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username: 'bob', password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const c = res.headers['set-cookie'];
    const bob = (Array.isArray(c) ? c : [c])[0]!.split(';')[0]!;
    const r = await app.inject({
      method: 'PATCH', url: '/api/v1/servers/srv-tag-1',
      payload: JSON.stringify({ tags: ['hacked'] }),
      headers: { cookie: bob, origin: BASE_URL, 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('T-标签：创建带标签', { timeout: 15_000 }, () => {
  it('POST /servers 带 tags → 落库并归一', async () => {
    const r = await api('POST', '/api/v1/servers', {
      name: 'srv-tag-new', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', username: 'root', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
      tags: [' 新建 ', '新建', ''],
    });
    expect(r.status).toBe(200);
    const id = (r.json.data as { id: string }).id;
    expect(await tagsOf(id)).toEqual(['新建']);
  });

  it('POST /servers 不带 tags → 空数组（不是 null）', async () => {
    const r = await api('POST', '/api/v1/servers', {
      name: 'srv-tag-none', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', username: 'root', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    });
    expect(r.status).toBe(200);
    expect(await tagsOf((r.json.data as { id: string }).id)).toEqual([]);
  });
});
