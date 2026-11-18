/**
 * T6（tasks-2611-1829-00）：API Key 吊销与删除拆分。
 *
 * 用户要求「吊销了的支持删除」。核心约束是**顺序不可逆**：
 *  - 有效 Key 不能直接删（否则审计里的 api_key_id 指向不存在的行）；
 *  - 已吊销的 Key 可以删，删完 MCP 侧仍 401。
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

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';
const PWD = 'password-12345';

let app: FastifyInstance;
let sqlite: Database.Database;
let ownerCookie: string;
let otherCookie: string;

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
  await createUserWithPassword(auth, { username: 'owner', password: PWD, isAdmin: false });
  await createUserWithPassword(auth, { username: 'other', password: PWD, isAdmin: false });

  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite });

  const login = async (username: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password: PWD },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const cookies = res.headers['set-cookie'];
    const sc = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    return sc[0]!.split(';')[0]!;
  };
  ownerCookie = await login('owner');
  otherCookie = await login('other');
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }

async function api(method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function issueKey(name: string): Promise<{ id: string; plainKey: string }> {
  const r = await api('POST', '/api/v1/api-keys', ownerCookie, { name });
  expect(r.status).toBe(200);
  return r.json.data as { id: string; plainKey: string };
}

async function mcpStatus(plainKey: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${plainKey}` } });
  return res.statusCode;
}

describe('T6 API Key 吊销与删除', { timeout: 30_000 }, () => {
  it('有效 Key 直接 DELETE → 400（必须先吊销）', async () => {
    const { id, plainKey } = await issueKey('direct-delete');
    const r = await api('DELETE', `/api/v1/api-keys/${id}`, ownerCookie);
    expect(r.status).toBe(400);
    // 仍然可用
    expect(await mcpStatus(plainKey)).not.toBe(401);
  });

  it('吊销后仍出现在列表里（状态=已吊销）；删除后彻底消失', async () => {
    const { id, plainKey } = await issueKey('revoke-then-delete');

    const rev = await api('POST', `/api/v1/api-keys/${id}/revoke`, ownerCookie);
    expect(rev.status).toBe(200);
    expect((rev.json.data as { revoked: boolean }).revoked).toBe(true);
    expect(await mcpStatus(plainKey)).toBe(401);

    const listed = await api('GET', '/api/v1/api-keys', ownerCookie);
    const rows = listed.json.data as Array<{ id: string; revokedAt: number | null }>;
    const hit = rows.find((r) => r.id === id);
    expect(hit).toBeDefined();
    expect(hit!.revokedAt).not.toBeNull();

    const del = await api('DELETE', `/api/v1/api-keys/${id}`, ownerCookie);
    expect(del.status).toBe(200);
    expect((del.json.data as { deleted: boolean }).deleted).toBe(true);

    const after = await api('GET', '/api/v1/api-keys', ownerCookie);
    expect((after.json.data as Array<{ id: string }>).some((r) => r.id === id)).toBe(false);
    // 已删除的 Key 依然不能用于调用
    expect(await mcpStatus(plainKey)).toBe(401);
  });

  it('他人不能吊销/删除我的 Key → 403', async () => {
    const { id } = await issueKey('foreign-guard');
    const rev = await api('POST', `/api/v1/api-keys/${id}/revoke`, otherCookie);
    expect(rev.status).toBe(403);
    const del = await api('DELETE', `/api/v1/api-keys/${id}`, otherCookie);
    expect(del.status).toBe(403);
  });

  it('不存在的 Key → 404（吊销与删除都是）', async () => {
    expect((await api('POST', '/api/v1/api-keys/no-such/revoke', ownerCookie)).status).toBe(404);
    expect((await api('DELETE', '/api/v1/api-keys/no-such', ownerCookie)).status).toBe(404);
  });
});
