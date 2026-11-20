/**
 * T1 集成测试：凭证编辑扩展（键集合增删改 / 名称与等级 / referencedKeys）。
 *
 * 覆盖的现存缺陷：
 *  - PATCH values 不重算 valueHint（列表掩码停留在旧值）
 *  - PATCH name 无重名校验（撞 UNIQUE 约束变 500）
 *  - PATCH values 接受空集合（写出无法取值的凭证）
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
let cookie: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 't1-edit-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  const credentials = new CredentialService(sqlite, cryptoKey);
  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, credentials });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username: 'alice', password: 'password-12345' },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const sc = res.headers['set-cookie'];
  cookie = (Array.isArray(sc) ? sc : [sc])[0]!.split(';')[0]!;
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); });

interface Json { code: number; data: unknown; message: string }

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function createCred(values: Record<string, string>, name: string): Promise<string> {
  const r = await api('POST', '/api/v1/credentials', { name, values });
  expect(r.status).toBe(200);
  return (r.json.data as { id: string }).id;
}

describe('T1：凭证键集合编辑', { timeout: 15_000 }, () => {
  it('整份键集合替换：删键 + 加键 + 改值后 reveal 与预期一致', async () => {
    const id = await createCred({ username: 'u1', password: 'p1', host: 'h1' }, 'edit-keys');
    const patch = await api('PATCH', `/api/v1/credentials/${id}`, {
      values: { username: 'u2', password: 'p2-new', database: 'db1' },
    });
    expect(patch.status).toBe(200);
    const reveal = await api('GET', `/api/v1/credentials/${id}/reveal`);
    const values = (reveal.json.data as { values: Record<string, string> }).values;
    expect(Object.keys(values).sort()).toEqual(['database', 'password', 'username']);
    expect(values.password).toBe('p2-new');
    expect(values.host).toBeUndefined();
  });

  it('改值后 valueHint 重算（列表掩码不再是旧值）', async () => {
    const id = await createCred({ password: 'old-pass-AAAA' }, 'edit-hint');
    const before = await api('GET', '/api/v1/credentials');
    const beforeHint = (before.json.data as Array<{ id: string; valueHint: string }>).find((c) => c.id === id)!.valueHint;
    expect(beforeHint).toBe('****AAAA');

    await api('PATCH', `/api/v1/credentials/${id}`, { values: { password: 'new-pass-ZZZZ' } });
    const after = await api('GET', '/api/v1/credentials');
    const afterHint = (after.json.data as Array<{ id: string; valueHint: string }>).find((c) => c.id === id)!.valueHint;
    expect(afterHint).toBe('****ZZZZ');
  });

  it('空 values / 全空串 → 400 且库内不变', async () => {
    const id = await createCred({ password: 'keep-me' }, 'edit-empty');
    const empty = await api('PATCH', `/api/v1/credentials/${id}`, { values: {} });
    expect(empty.status).toBe(400);
    const blank = await api('PATCH', `/api/v1/credentials/${id}`, { values: { password: '   ', other: '' } });
    expect(blank.status).toBe(400);
    const reveal = await api('GET', `/api/v1/credentials/${id}/reveal`);
    expect((reveal.json.data as { values: Record<string, string> }).values.password).toBe('keep-me');
  });

  it('重名 → 400，原名保存不受影响', async () => {
    await createCred({ password: 'a' }, 'take-this-name');
    const id = await createCred({ password: 'b' }, 'rename-me');
    const dup = await api('PATCH', `/api/v1/credentials/${id}`, { name: 'take-this-name' });
    expect(dup.status).toBe(400);
    const d = await api('GET', `/api/v1/credentials/${id}`);
    expect((d.json.data as { name: string }).name).toBe('rename-me');

    const ok = await api('PATCH', `/api/v1/credentials/${id}`, { name: 'renamed-ok' });
    expect(ok.status).toBe(200);
    const d2 = await api('GET', `/api/v1/credentials/${id}`);
    expect((d2.json.data as { name: string }).name).toBe('renamed-ok');
  });

  it('空 name → 400', async () => {
    const id = await createCred({ password: 'x' }, 'empty-name');
    const r = await api('PATCH', `/api/v1/credentials/${id}`, { name: '  ' });
    expect(r.status).toBe(400);
  });
});

describe('T1：referencedKeys（哪些键正被资产槽位取用）', { timeout: 15_000 }, () => {
  it('区分「绑定显式指定键」与「按槽位名匹配」两种绑定', async () => {
    const db = drizzle(sqlite, { schema });
    const aliceId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'alice')).get())!.id;

    const credId = await createCred({ AUTH: 'k', password: 'pw', RABBITMQ_PASSWORD: 'r' }, 'ref-keys');
    // s1：AUTH 槽位不指定键 → 命中同名键 AUTH
    await db.insert(schema.servers).values({
      id: 'srv-ref-1', name: 'srv-ref-1', type: 'native', executionMode: 'native', category: 'host',
      ownerId: aliceId, configHash: 'c1', credentialSlots: [],
    }).run();
    await db.insert(schema.serverCredentials).values({
      serverId: 'srv-ref-1', slotName: 'AUTH', userId: aliceId, credentialId: credId, scope: 'asset', credentialKey: null,
    }).run();
    // s2：RABBITMQ_PASSWORD 槽位显式指定 password 键
    await db.insert(schema.servers).values({
      id: 'srv-ref-2', name: 'srv-ref-2', type: 'native', executionMode: 'native', category: 'mq',
      ownerId: aliceId, configHash: 'c2', credentialSlots: [],
    }).run();
    await db.insert(schema.serverCredentials).values({
      serverId: 'srv-ref-2', slotName: 'RABBITMQ_PASSWORD', userId: aliceId, credentialId: credId, scope: 'asset', credentialKey: 'password',
    }).run();

    const d = await api('GET', `/api/v1/credentials/${credId}`);
    expect(d.status).toBe(200);
    const refKeys = (d.json.data as { referencedKeys: Array<{ key: string; servers: Array<{ serverId: string; slots: string[] }> }> }).referencedKeys;
    const byKey = new Map(refKeys.map((r) => [r.key, r.servers]));
    // AUTH 键被 srv-ref-1 的 AUTH 槽位取用
    expect(byKey.get('AUTH')?.map((s) => s.serverId)).toEqual(['srv-ref-1']);
    expect(byKey.get('AUTH')?.[0]?.slots).toEqual(['AUTH']);
    // password 键被 srv-ref-2 的 RABBITMQ_PASSWORD 槽位取用（显式指定）
    expect(byKey.get('password')?.map((s) => s.serverId)).toEqual(['srv-ref-2']);
    // RABBITMQ_PASSWORD 键本身没有被任何槽位取用（槽位走了显式键）
    expect(byKey.get('RABBITMQ_PASSWORD')).toBeUndefined();
  });
});
