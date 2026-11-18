/**
 * T13 集成测试：分组子页面支撑 API（KV 元信息 + 资产/成员增删）。
 * 覆盖 group_metadata 表读写、DELETE 关联端点、GET 详情扩展 metadata 字段。
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
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';
import { eq } from 'drizzle-orm';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let adminCookie: string;
let userCookie: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);

  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'admin', password: 'password-12345', isAdmin: true });
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });

  const aliceId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'alice')).get())!.id;
  await db.insert(schema.servers).values({
    id: 'srv-a', name: 'srv-a', type: 'native', executionMode: 'native', category: 'host',
    ownerId: aliceId, configHash: 'c1', credentialSlots: [],
  }).run();
  await db.insert(schema.servers).values({
    id: 'srv-b', name: 'srv-b', type: 'native', executionMode: 'native', category: 'mysql',
    ownerId: aliceId, configHash: 'c2', credentialSlots: [],
  }).run();

  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite });

  const login = async (username: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const cookies = res.headers['set-cookie'];
    const sc = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    return sc[0]!.split(';')[0]!;
  };
  adminCookie = await login('admin');
  userCookie = await login('alice');
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }

async function api(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: {
      cookie,
      origin: BASE_URL,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function createGroup(name: string): Promise<string> {
  const res = await api('POST', '/api/v1/groups', adminCookie, { name });
  expect(res.status).toBe(200);
  return (res.json.data as { id: string }).id;
}

describe('T13：分组 KV 元信息', { timeout: 15_000 }, () => {
  it('PUT 批量写入 KV → GET 返回，且 GET 详情含 metadata 字段', async () => {
    const gid = await createGroup('grp-kv');
    const put = await api('PUT', `/api/v1/groups/${gid}/metadata`, adminCookie, {
      items: [{ key: 'env', value: 'production' }, { key: 'region', value: 'cn-hangzhou' }],
    });
    expect(put.status).toBe(200);

    const list = await api('GET', `/api/v1/groups/${gid}/metadata`, adminCookie);
    expect(list.status).toBe(200);
    const rows = list.json.data as Array<{ key: string; value: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.key === 'env')?.value).toBe('production');

    const detail = await api('GET', `/api/v1/groups/${gid}`, adminCookie);
    const data = detail.json.data as { metadata: Array<{ key: string; value: string }> };
    expect(Array.isArray(data.metadata)).toBe(true);
    expect(data.metadata).toHaveLength(2);
  });

  it('key 不限格式（含空格/中文/斜杠）均可写入与读取', async () => {
    const gid = await createGroup('grp-keyfmt');
    const keys = ['a b', '中文键', 'a/b/c', '  ', 'k=1&x=2'];
    const items = keys.map((k) => ({ key: k, value: 'v' }));
    const put = await api('PUT', `/api/v1/groups/${gid}/metadata`, adminCookie, { items });
    expect(put.status).toBe(200);
    const list = await api('GET', `/api/v1/groups/${gid}/metadata`, adminCookie);
    const rows = list.json.data as Array<{ key: string }>;
    expect(rows).toHaveLength(keys.length);
  });

  it('空 key 被拒（400）；value 非字符串被拒（400）', async () => {
    const gid = await createGroup('grp-invalid');
    const badKey = await api('PUT', `/api/v1/groups/${gid}/metadata`, adminCookie, { items: [{ key: '', value: 'v' }] });
    expect(badKey.status).toBe(400);
    const badValue = await api('PUT', `/api/v1/groups/${gid}/metadata`, adminCookie, { items: [{ key: 'k', value: 123 }] });
    expect(badValue.status).toBe(400);
    const empty = await api('PUT', `/api/v1/groups/${gid}/metadata`, adminCookie, { items: [] });
    expect(empty.status).toBe(400);
  });

  it('同名 key 重复写入为覆盖（upsert）而非新增', async () => {
    const gid = await createGroup('grp-upsert');
    await api('PUT', `/api/v1/groups/${gid}/metadata`, adminCookie, { items: [{ key: 'env', value: 'dev' }] });
    await api('PUT', `/api/v1/groups/${gid}/metadata`, adminCookie, { items: [{ key: 'env', value: 'prod' }] });
    const list = await api('GET', `/api/v1/groups/${gid}/metadata`, adminCookie);
    const rows = list.json.data as Array<{ key: string; value: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('prod');
  });

  it('DELETE metadata（query key）→ 404 再删（幂等语义：不存在即 404）', async () => {
    const gid = await createGroup('grp-del');
    await api('PUT', `/api/v1/groups/${gid}/metadata`, adminCookie, { items: [{ key: 'env', value: 'x' }] });
    const del = await api('DELETE', `/api/v1/groups/${gid}/metadata?key=env`, adminCookie);
    expect(del.status).toBe(200);
    const again = await api('DELETE', `/api/v1/groups/${gid}/metadata?key=env`, adminCookie);
    expect(again.status).toBe(404);
  });

  it('非管理员写 KV → 403；未登录 → 401', async () => {
    const gid = await createGroup('grp-authz');
    const denied = await api('PUT', `/api/v1/groups/${gid}/metadata`, userCookie, { items: [{ key: 'a', value: 'b' }] });
    expect(denied.status).toBe(403);
    const anon = await api('PUT', `/api/v1/groups/${gid}/metadata`, '', { items: [{ key: 'a', value: 'b' }] });
    expect(anon.status).toBe(401);
  });
});

describe('T13：分组资产/成员增删', { timeout: 15_000 }, () => {
  it('POST 添加资产后 DELETE 移除资产', async () => {
    const gid = await createGroup('grp-assets');
    const add = await api('POST', `/api/v1/groups/${gid}/servers`, adminCookie, { serverIds: ['srv-a', 'srv-b'] });
    expect(add.status).toBe(200);

    const detail = await api('GET', `/api/v1/groups/${gid}`, adminCookie);
    const d1 = detail.json.data as { assets: Array<{ id: string }>; serverIds: string[] };
    expect(d1.assets).toHaveLength(2);
    expect(d1.serverIds.sort()).toEqual(['srv-a', 'srv-b']);

    const del = await api('DELETE', `/api/v1/groups/${gid}/servers/srv-a`, adminCookie);
    expect(del.status).toBe(200);

    const detail2 = await api('GET', `/api/v1/groups/${gid}`, adminCookie);
    const d2 = detail2.json.data as { assets: Array<{ id: string }>; serverIds: string[] };
    expect(d2.assets.map((a) => a.id)).toEqual(['srv-b']);

    const delAgain = await api('DELETE', `/api/v1/groups/${gid}/servers/srv-a`, adminCookie);
    expect(delAgain.status).toBe(404);
  });

  it('POST 添加成员后 DELETE 移除成员', async () => {
    const gid = await createGroup('grp-members');
    const alice = (await sqlite.prepare('select id from users where username = ?').get('alice') as { id: string }).id;
    const add = await api('POST', `/api/v1/groups/${gid}/users`, adminCookie, { userIds: [alice] });
    expect(add.status).toBe(200);

    const detail = await api('GET', `/api/v1/groups/${gid}`, adminCookie);
    const d1 = detail.json.data as { members: Array<{ id: string; username: string }> };
    expect(d1.members).toHaveLength(1);
    expect(d1.members[0]!.username).toBe('alice');

    const del = await api('DELETE', `/api/v1/groups/${gid}/users/${alice}`, adminCookie);
    expect(del.status).toBe(200);

    const detail2 = await api('GET', `/api/v1/groups/${gid}`, adminCookie);
    const d2 = detail2.json.data as { members: Array<{ id: string }> };
    expect(d2.members).toHaveLength(0);

    const delAgain = await api('DELETE', `/api/v1/groups/${gid}/users/${alice}`, adminCookie);
    expect(delAgain.status).toBe(404);
  });

  it('删除不存在分组上的关联 → 404', async () => {
    const del = await api('DELETE', '/api/v1/groups/grp-nope/servers/srv-a', adminCookie);
    expect(del.status).toBe(404);
  });

  it('非管理员移除资产/成员 → 403', async () => {
    const gid = await createGroup('grp-denied');
    const del = await api('DELETE', `/api/v1/groups/${gid}/servers/srv-a`, userCookie);
    expect(del.status).toBe(403);
  });
});
