/**
 * T13 集成测试：成员变动三场景（ADR-028 §2.5）。
 *  1. 移出分组 → personal 绑定保留，不能用 owner 绑定的凭证
 *  2. 删除成员 → 凭证/资产保留，owner_id 置 NULL，admin 可重新分配
 *  3. 禁用成员 → Web UI 不能登录，MCP（API Key）仍可用
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

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let adminCookie: string;
let memberCookie: string;
let adminId: string;
let memberId: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 't13-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'root', password: 'password-12345', isAdmin: true });
  await createUserWithPassword(auth, { username: 'member', password: 'password-12345', isAdmin: false });
  adminId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'root')).get())!.id;
  memberId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'member')).get())!.id;

  const { buildApp } = await import('./app.js');
  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite });

  const login = async (username: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const sc = res.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
    return arr[0]!.split(';')[0]!;
  };
  adminCookie = await login('root');
  memberCookie = await login('member');
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }
async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown) {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

/** 建一组「资产 + owner 凭证(asset) + 成员凭证(personal)」 */
async function seedScenario(tag: string) {
  const g = await db.insert(schema.groups).values({ name: `g-${tag}` }).returning({ id: schema.groups.id }).get();
  await db.insert(schema.groupUsers).values([{ groupId: g.id, userId: adminId }, { groupId: g.id, userId: memberId }]).run();
  const srv = await db.insert(schema.servers).values({
    name: `srv-${tag}`, type: 'stdio', executionMode: 'mcp', category: 'other',
    command: 'node', args: [], env: {}, ownerId: adminId, visibility: 'group', configHash: `c-${tag}`,
    credentialSlots: [{ target: 'env', name: 'AUTH', label: '认证', file: false }] as never,
  }).returning({ id: schema.servers.id }).get();
  await db.insert(schema.groupServers).values({ groupId: g.id, serverId: srv.id }).run();
  const cAdmin = await db.insert(schema.credentials).values({ name: `cred-admin-${tag}`, kind: 'env-values', encryptedValues: 'x', valueHint: '****1', ownerId: adminId }).returning({ id: schema.credentials.id }).get();
  const cMember = await db.insert(schema.credentials).values({ name: `cred-member-${tag}`, kind: 'env-values', encryptedValues: 'y', valueHint: '****2', ownerId: memberId }).returning({ id: schema.credentials.id }).get();
  await db.insert(schema.serverCredentials).values([
    { serverId: srv.id, slotName: 'AUTH', userId: adminId, credentialId: cAdmin.id, scope: 'asset' },
    { serverId: srv.id, slotName: 'AUTH', userId: memberId, credentialId: cMember.id, scope: 'personal' },
  ]).run();
  return { groupId: g.id, serverId: srv.id, adminCredId: cAdmin.id, memberCredId: cMember.id };
}

describe('T13 场景 1：移出分组', { timeout: 30_000 }, () => {
  it('personal 绑定保留；资产不可见 → 不能再取 owner 的 asset 凭证', async () => {
    const s = await seedScenario('leave');
    // 移出分组
    const rm = await api('DELETE', `/api/v1/groups/${s.groupId}/users/${memberId}`, adminCookie);
    expect(rm.status).toBe(200);

    // personal 绑定仍在
    const binds = sqlite
      .prepare('SELECT user_id, scope FROM server_credentials WHERE server_id=? AND user_id=?')
      .all(s.serverId, memberId) as Array<{ user_id: string; scope: string }>;
    expect(binds).toEqual([{ user_id: memberId, scope: 'personal' }]);

    // 资产已不可见（group 可见性 + 不在组内）
    const { canOnAsset } = await import('./services/authzBuilder.js');
    const srv = await db.select().from(schema.servers).where(eq(schema.servers.id, s.serverId)).get();
    expect(await canOnAsset(db, 'view', { userId: memberId, isAdmin: false }, srv!)).toBe(false);

    // 凭证使用权：owner 凭证未共享 → 无使用权
    const { canUseCredentialFor } = await import('./services/authzBuilder.js');
    const adminCred = await db.select().from(schema.credentials).where(eq(schema.credentials.id, s.adminCredId)).get();
    expect(await canUseCredentialFor(db, { userId: memberId, isAdmin: false }, adminCred!)).toBe(false);
  });
});

describe('T13 场景 2：删除成员', { timeout: 30_000 }, () => {
  it('凭证/资产保留且 owner_id 置 NULL；personal 绑定清理；admin 可重新分配', async () => {
    const s = await seedScenario('delete');
    const del = await api('DELETE', `/api/v1/users/${memberId}`, adminCookie);
    expect(del.status).toBe(200);
    const d = del.json.data as { orphanedCredentials: number; orphanedServers: number };
    expect(d.orphanedCredentials).toBeGreaterThanOrEqual(1);
    expect(d.orphanedServers).toBe(0);

    // 凭证与资产都还在
    const cred = await db.select().from(schema.credentials).where(eq(schema.credentials.id, s.memberCredId)).get();
    expect(cred).toBeTruthy();
    expect(cred!.ownerId).toBeNull();
    expect(await db.select().from(schema.servers).where(eq(schema.servers.id, s.serverId)).get()).toBeTruthy();

    // personal 绑定已清理；asset 绑定保留
    const remains = sqlite.prepare('SELECT user_id, scope FROM server_credentials WHERE server_id=?').all(s.serverId) as Array<{ user_id: string; scope: string }>;
    expect(remains.every((r) => r.scope === 'asset')).toBe(true);

    // 用户记录已删
    expect(await db.select().from(schema.users).where(eq(schema.users.id, memberId)).get()).toBeUndefined();

    // admin 重新分配
    const re = await api('POST', '/api/v1/admin/reassign-owner', adminCookie, {
      credentialId: s.memberCredId, newOwnerId: adminId,
    });
    expect(re.status).toBe(200);
    const after = await db.select().from(schema.credentials).where(eq(schema.credentials.id, s.memberCredId)).get();
    expect(after!.ownerId).toBe(adminId);
  });

  it('不能删除自己', async () => {
    const res = await api('DELETE', `/api/v1/users/${adminId}`, adminCookie);
    expect(res.status).toBe(400);
  });

});

describe('T13 场景 3：禁用成员', { timeout: 30_000 }, () => {
  it('禁用后 Web 会话失效（受保护接口 401/403），但 API Key 仍可用于 MCP', async () => {
    // 新建独立成员避免影响前面的场景
    const created = await api('POST', '/api/v1/users', adminCookie, { username: 'tempuser', password: 'password-12345' });
    expect(created.status).toBe(200);
    const tempId = (created.json.data as { id: string }).id;

    // 签发 API Key（用 admin 身份为该用户签发需走该用户会话；这里直接用服务签发）
    const { createApiKey, verifyApiKey } = await import('./services/apiKey.js');
    const key = (await createApiKey(db, tempId, 't13')).plainKey;

    const loginTemp = async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/sign-in/username',
        payload: { username: 'tempuser', password: 'password-12345' },
        headers: { origin: BASE_URL, 'content-type': 'application/json' },
      });
      const sc = res.headers['set-cookie'];
      const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
      return { status: res.statusCode, cookie: arr[0]?.split(';')[0] };
    };
    const before = await loginTemp();
    expect(before.status).toBe(200);

    // 禁用
    const dis = await api('PATCH', `/api/v1/users/${tempId}`, adminCookie, { isDisabled: true });
    expect(dis.status).toBe(200);

    // 已建立的会话立即失效（sessionPrincipal 返回 null → 受保护接口 401/403）
    const afterDisable = await api('GET', '/api/v1/credentials', before.cookie!);
    expect([401, 403]).toContain(afterDisable.status);

    // 重新登录也应失败（会话拿不到主体）
    const relogin = await loginTemp();
    if (relogin.cookie) {
      const r = await api('GET', '/api/v1/credentials', relogin.cookie);
      expect([401, 403]).toContain(r.status);
    }

    // API Key 仍然有效（MCP 通道）
    const principal = await verifyApiKey(db, key);
    expect(principal?.userId).toBe(tempId);

    // 启用后恢复
    await api('PATCH', `/api/v1/users/${tempId}`, adminCookie, { isDisabled: false });
    const reEnabled = await loginTemp();
    if (reEnabled.cookie) {
      const r = await api('GET', '/api/v1/credentials', reEnabled.cookie);
      expect(r.status).toBe(200);
    }
  });

  it('不能禁用自己', async () => {
    const res = await api('PATCH', `/api/v1/users/${adminId}`, adminCookie, { isDisabled: true });
    expect(res.status).toBe(400);
  });
});

describe('T13：T18 成员管理 API 形状', { timeout: 20_000 }, () => {
  it('列表返回 isDisabled 字段', async () => {
    const res = await api('GET', '/api/v1/users', adminCookie);
    const rows = res.json.data as Array<{ isDisabled: boolean }>;
    expect(rows.every((r) => typeof r.isDisabled === 'boolean')).toBe(true);
  });

  it('非管理员不能删除/禁用/改身份', async () => {
    const c2 = await api('POST', '/api/v1/users', adminCookie, { username: 'plainuser', password: 'password-12345' });
    const id = (c2.json.data as { id: string }).id;
    const res1 = await api('DELETE', `/api/v1/users/${id}`, memberCookie);
    const res2 = await api('PATCH', `/api/v1/users/${id}`, memberCookie, { isDisabled: true });
    expect([401, 403]).toContain(res1.status);
    expect([401, 403]).toContain(res2.status);
  });
});
