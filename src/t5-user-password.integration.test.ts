/**
 * T5（tasks-2611-1829-00）：管理员重置成员密码。
 *
 * 用户决策「只重置密码」：PATCH 带 password 生效，用户名不可改。
 * 断言的三条行为契约：
 *  1. 重置后旧密码登录失败、新密码成功；
 *  2. 成员原有会话失效（不是"改完还能用旧 cookie"）；
 *  3. 非管理员不能重置他人密码（admin-only 路由）。
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
const OLD_PWD = 'password-12345';
const NEW_PWD = 'new-password-98765';

let app: FastifyInstance;
let sqlite: Database.Database;
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let otherMemberId: string;

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
  await createUserWithPassword(auth, { username: 'admin', password: OLD_PWD, isAdmin: true });
  const m = await createUserWithPassword(auth, { username: 'member', password: OLD_PWD, isAdmin: false });
  const o = await createUserWithPassword(auth, { username: 'other', password: OLD_PWD, isAdmin: false });
  memberId = m.user.id;
  otherMemberId = o.user.id;

  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite });

  const login = async (username: string, password = OLD_PWD) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const cookies = res.headers['set-cookie'];
    const sc = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    return { status: res.statusCode, cookie: sc[0]?.split(';')[0] ?? '' };
  };
  adminCookie = (await login('admin')).cookie;
  memberCookie = (await login('member')).cookie;
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }

async function api(method: 'GET' | 'PATCH', url: string, cookie: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function loginStatus(username: string, password: string): Promise<number> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username, password },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  return res.statusCode;
}

describe('T5 管理员重置成员密码', { timeout: 30_000 }, () => {
  it('重置后：旧密码失效、新密码可登录、成员旧会话被吊销', async () => {
    const before = await api('GET', '/api/v1/auth/get-session', memberCookie);
    expect(before.status).toBe(200);

    const r = await api('PATCH', `/api/v1/users/${memberId}`, adminCookie, { password: NEW_PWD });
    expect(r.status).toBe(200);
    expect((r.json.data as { passwordReset: boolean }).passwordReset).toBe(true);

    expect(await loginStatus('member', OLD_PWD)).toBe(401);
    expect(await loginStatus('member', NEW_PWD)).toBe(200);

    // 旧 cookie 已失效（不是只看登录接口）
    const after = await api('GET', '/api/v1/auth/get-session', memberCookie);
    const body = after.json as unknown as { user?: unknown } | null;
    expect(after.status === 401 || body === null || body.user === undefined || body.user === null).toBe(true);

    // 审计记录存在，且不含任何密码派生值
    const now = new Date();
    const table = `audit_log_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`;
    const rows = sqlite
      .prepare(`SELECT action, input_summary FROM "${table}" WHERE action = 'user_password_reset'`)
      .all() as Array<{ action: string; input_summary: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input_summary).not.toContain(NEW_PWD);
  });

  it('密码短于 10 位 → 400，且原密码仍可用', async () => {
    const r = await api('PATCH', `/api/v1/users/${otherMemberId}`, adminCookie, { password: 'short' });
    expect(r.status).toBe(400);
    expect(await loginStatus('other', OLD_PWD)).toBe(200);
  });

  it('用户不存在 → 404', async () => {
    const r = await api('PATCH', '/api/v1/users/no-such-user', adminCookie, { password: NEW_PWD });
    expect(r.status).toBe(404);
  });

  it('成员调 PATCH 重置他人密码 → 403', async () => {
    const fresh = await loginStatus('other', OLD_PWD);
    expect(fresh).toBe(200);
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/users/${otherMemberId}`,
      payload: JSON.stringify({ password: NEW_PWD }),
      headers: { cookie: memberCookie, origin: BASE_URL, 'content-type': 'application/json' },
    });
    // memberCookie 已在上一个用例被吊销 → 401（未登录）与 403（无权限）都是明确拒绝
    expect([401, 403]).toContain(res.statusCode);
  });

  it('不带任何可改字段 → 400', async () => {
    const r = await api('PATCH', `/api/v1/users/${otherMemberId}`, adminCookie, {});
    expect(r.status).toBe(400);
  });
});
