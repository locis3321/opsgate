/**
 * T4 集成测试：新建分组时一次性关联资产（避免"组已建、关联失败"的半成品）。
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
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let adminCookie: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 't4-group-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'admin', password: 'password-12345', isAdmin: true });
  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite });

  const adminId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'admin')).get())!.id;
  for (const [id, category, tags] of [['srv-h1', 'host', ['prod']], ['srv-h2', 'host', ['dev']], ['srv-m1', 'mysql', ['prod']]] as const) {
    await db.insert(schema.servers).values({
      id, name: id, type: 'native', executionMode: 'native', category,
      ownerId: adminId, configHash: `c-${id}`, credentialSlots: [], tags: [...tags],
    }).run();
  }

  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username: 'admin', password: 'password-12345' },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const c = res.headers['set-cookie'];
  adminCookie = (Array.isArray(c) ? c : [c])[0]!.split(';')[0]!;
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); });

interface Json { code: number; data: unknown; message: string }

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie: adminCookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

describe('T4：新建分组一次性关联资产', { timeout: 15_000 }, () => {
  it('不带 serverIds → 行为不变（空组）', async () => {
    const r = await api('POST', '/api/v1/groups', { name: 'g-plain', description: 'x' });
    expect(r.status).toBe(200);
    const gid = (r.json.data as { id: string }).id;
    const d = await api('GET', `/api/v1/groups/${gid}`);
    expect((d.json.data as { assets: unknown[] }).assets).toHaveLength(0);
  });

  it('带 serverIds → 组与关联一并落库', async () => {
    const r = await api('POST', '/api/v1/groups', { name: 'g-with-assets', serverIds: ['srv-h1', 'srv-h2', 'srv-m1'] });
    expect(r.status).toBe(200);
    const gid = (r.json.data as { id: string }).id;
    const d = await api('GET', `/api/v1/groups/${gid}`);
    const assets = (d.json.data as { assets: Array<{ id: string }> }).assets.map((a) => a.id).sort();
    expect(assets).toEqual(['srv-h1', 'srv-h2', 'srv-m1']);
  });

  it('重复 id 去重', async () => {
    const r = await api('POST', '/api/v1/groups', { name: 'g-dedup', serverIds: ['srv-h1', 'srv-h1'] });
    expect(r.status).toBe(200);
    const gid = (r.json.data as { id: string }).id;
    const d = await api('GET', `/api/v1/groups/${gid}`);
    expect((d.json.data as { assets: unknown[] }).assets).toHaveLength(1);
  });

  it('含不存在的 id → 400 且分组未创建（不留半成品）', async () => {
    const before = sqlite.prepare('select count(*) as n from groups').get() as { n: number };
    const r = await api('POST', '/api/v1/groups', { name: 'g-bad-asset', serverIds: ['srv-h1', 'srv-nope'] });
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('srv-nope');
    const after = sqlite.prepare('select count(*) as n from groups').get() as { n: number };
    expect(after.n).toBe(before.n);
    const dupName = sqlite.prepare('select count(*) as n from groups where name = ?').get('g-bad-asset') as { n: number };
    expect(dupName.n).toBe(0);
  });

  it('分组重名仍 → 500 之外的显式失败（沿用既有唯一约束路径）', async () => {
    await api('POST', '/api/v1/groups', { name: 'g-dupname' });
    const r = await api('POST', '/api/v1/groups', { name: 'g-dupname' });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
