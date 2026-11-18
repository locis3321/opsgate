/**
 * T3（tasks-2611-1829-00）：安全策略三级作用域 + 来源锁定。
 *
 * 用户 2026-11-18 三条要求：
 *  1) 区分全局 / 某资产类型 / 某资产
 *  2) owner 可以设置和开关自己资产的自定义策略
 *  3) 管理员设置的策略，owner 无法关闭和修改
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
import { loadActiveRules, evaluateRules } from './services/guardRules.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let adminCookie: string;
let ownerCookie: string;
let otherCookie: string;
let ownerId: string;
let otherId: string;

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
  await createUserWithPassword(auth, { username: 'owner', password: 'password-12345', isAdmin: false });
  await createUserWithPassword(auth, { username: 'other', password: 'password-12345', isAdmin: false });
  ownerId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'owner')).get())!.id;
  otherId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'other')).get())!.id;

  // owner 两条资产（k8s 与 mysql 各一），other 一条
  await db.insert(schema.servers).values([
    {
      id: 'srv-owner-k8s', name: 'srv-owner-k8s', type: 'native', executionMode: 'native', category: 'k8s',
      ownerId, configHash: 'h1', credentialSlots: [],
    },
    {
      id: 'srv-owner-mysql', name: 'srv-owner-mysql', type: 'native', executionMode: 'native', category: 'mysql',
      ownerId, configHash: 'h2', credentialSlots: [],
    },
    {
      id: 'srv-other-k8s', name: 'srv-other-k8s', type: 'native', executionMode: 'native', category: 'k8s',
      ownerId: otherId, configHash: 'h3', credentialSlots: [],
    },
  ]).run();

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
  ownerCookie = await login('owner');
  otherCookie = await login('other');
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

const baseRule = { kind: 'block', target: 'arg', pattern: '^BLOCKME$' };

describe('T3：作用域引擎', () => {
  it('global 规则对所有资产生效', () => {
    const rules = [{ id: 'g', name: 'g', kind: 'block' as const, target: 'arg' as const, pattern: 'x', priority: 0, scope: 'global' as const }];
    expect(evaluateRules(rules, { tool: 't', args: { a: 'x' }, assetType: 'k8s', assetId: 'any' })).not.toBeNull();
  });

  it('asset_type 规则只对匹配品类生效', () => {
    const rules = [{
      id: 'at', name: 'at', kind: 'block' as const, target: 'arg' as const, pattern: 'x', priority: 0,
      scope: 'asset_type' as const, scopeValue: ['k8s'],
    }];
    expect(evaluateRules(rules, { tool: 't', args: { a: 'x' }, assetType: 'k8s', assetId: 's1' })).not.toBeNull();
    expect(evaluateRules(rules, { tool: 't', args: { a: 'x' }, assetType: 'mysql', assetId: 's1' })).toBeNull();
  });

  it('asset 规则只对指定资产生效；未提供 assetId 时不命中（宁可漏拦不误拦）', () => {
    const rules = [{
      id: 'as', name: 'as', kind: 'block' as const, target: 'arg' as const, pattern: 'x', priority: 0,
      scope: 'asset' as const, scopeValue: ['srv-owner-k8s'],
    }];
    expect(evaluateRules(rules, { tool: 't', args: { a: 'x' }, assetType: 'k8s', assetId: 'srv-owner-k8s' })).not.toBeNull();
    expect(evaluateRules(rules, { tool: 't', args: { a: 'x' }, assetType: 'k8s', assetId: 'srv-other-k8s' })).toBeNull();
    expect(evaluateRules(rules, { tool: 't', args: { a: 'x' }, assetType: 'k8s' })).toBeNull();
  });
});

describe('T3：创建与来源锁定', () => {
  it('admin 可建 global 规则，source=admin', async () => {
    const r = await api('POST', '/api/v1/guard-rules', adminCookie, { ...baseRule, name: 'admin-global', scope: 'global' });
    expect(r.status).toBe(200);
    const row = sqlite.prepare("SELECT source, scope, owner_id FROM guard_rules WHERE name = 'admin-global'").get() as { source: string; scope: string; owner_id: string };
    expect(row.source).toBe('admin');
    expect(row.scope).toBe('global');
  });

  it('admin 可建 asset_type 规则', async () => {
    const r = await api('POST', '/api/v1/guard-rules', adminCookie, {
      ...baseRule, name: 'admin-k8s-type', scope: 'asset_type', scopeValue: ['k8s'],
    });
    expect(r.status).toBe(200);
  });

  it('owner 可为自己资产建 asset 规则，source=owner', async () => {
    const r = await api('POST', '/api/v1/guard-rules', ownerCookie, {
      ...baseRule, name: 'owner-own', scope: 'asset', scopeValue: ['srv-owner-k8s'],
    });
    expect(r.status).toBe(200);
    const row = sqlite.prepare("SELECT source, owner_id FROM guard_rules WHERE name = 'owner-own'").get() as { source: string; owner_id: string };
    expect(row.source).toBe('owner');
    expect(row.owner_id).toBe(ownerId);
  });

  it('owner 建 scope=global 或 asset_type → 403', async () => {
    expect((await api('POST', '/api/v1/guard-rules', ownerCookie, { ...baseRule, name: 'o-global', scope: 'global' })).status).toBe(403);
    expect((await api('POST', '/api/v1/guard-rules', ownerCookie, {
      ...baseRule, name: 'o-type', scope: 'asset_type', scopeValue: ['k8s'],
    })).status).toBe(403);
  });

  it('owner 建指向他人资产的规则 → 400', async () => {
    const r = await api('POST', '/api/v1/guard-rules', ownerCookie, {
      ...baseRule, name: 'o-foreign', scope: 'asset', scopeValue: ['srv-other-k8s'],
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('不属于你');
  });

  it('owner 修改/删除管理员规则 → 403（这就是"管理员设置的 owner 无法关闭和修改"）', async () => {
    const adminRuleId = (sqlite.prepare("SELECT id FROM guard_rules WHERE name = 'admin-global'").get() as { id: string }).id;
    expect((await api('PATCH', `/api/v1/guard-rules/${adminRuleId}`, ownerCookie, { enabled: false })).status).toBe(403);
    expect((await api('DELETE', `/api/v1/guard-rules/${adminRuleId}`, ownerCookie)).status).toBe(403);
    // 管理员自己可以
    expect((await api('PATCH', `/api/v1/guard-rules/${adminRuleId}`, adminCookie, { enabled: false })).status).toBe(200);
  });

  it('owner 可以开关自己的规则', async () => {
    const ownId = (sqlite.prepare("SELECT id FROM guard_rules WHERE name = 'owner-own'").get() as { id: string }).id;
    expect((await api('PATCH', `/api/v1/guard-rules/${ownId}`, ownerCookie, { enabled: false })).status).toBe(200);
    expect((await api('PATCH', `/api/v1/guard-rules/${ownId}`, ownerCookie, { enabled: true })).status).toBe(200);
  });
});

describe('T3：成员视角列表', () => {
  it('owner 看到全局规则但 canManage=false；看到自己的规则 canManage=true', async () => {
    const r = await api('GET', '/api/v1/guard-rules', ownerCookie);
    expect(r.status).toBe(200);
    const rows = r.json.data as Array<{ name: string; canManage: boolean; source: string }>;
    const adminGlobal = rows.find((x) => x.name === 'admin-global');
    expect(adminGlobal).toBeDefined();
    expect(adminGlobal!.canManage).toBe(false);
    expect(adminGlobal!.source).toBe('admin');
    const own = rows.find((x) => x.name === 'owner-own');
    expect(own!.canManage).toBe(true);
  });

  it('other 看不到 owner 的 asset 级规则（作用域不含他的资产）', async () => {
    const r = await api('GET', '/api/v1/guard-rules', otherCookie);
    const rows = r.json.data as Array<{ name: string }>;
    expect(rows.find((x) => x.name === 'owner-own')).toBeUndefined();
  });
});

describe('T3：资产删除清理作用域引用', () => {
  it('删除资产后，指向它的策略被摘除；目标全空则停用', async () => {
    // admin 建一条只指向 srv-owner-mysql 的规则
    await api('POST', '/api/v1/guard-rules', adminCookie, {
      ...baseRule, name: 'tmp-single-target', scope: 'asset', scopeValue: ['srv-owner-mysql'],
    });
    // owner 删自己的资产（admin 也可，这里用 admin 走批量删除排除权限干扰，用单条 DELETE）
    const del = await api('DELETE', '/api/v1/servers/srv-owner-mysql', adminCookie);
    expect(del.status).toBe(200);

    const row = sqlite.prepare("SELECT scope_value, enabled FROM guard_rules WHERE name = 'tmp-single-target'").get() as { scope_value: string | null; enabled: number };
    expect(row.scope_value).toBeNull();
    expect(row.enabled).toBe(0);
  });
});

describe('T3：loadActiveRules 读出新列', () => {
  it('引擎加载的规则带 scope/source', () => {
    const rules = loadActiveRules(sqlite);
    const r = rules.find((x) => x.name === 'admin-k8s-type');
    expect(r).toBeDefined();
    expect(r!.scope).toBe('asset_type');
    expect(r!.scopeValue).toEqual(['k8s']);
    expect(r!.source).toBe('admin');
  });
});

describe('T3：body 匹配维度（2026-11-18 用户需求：不能只匹配入参）', () => {
  it('POST body 规则可入库（target 校验已放开 body）', async () => {
    const r = await api('POST', '/api/v1/guard-rules', adminCookie, {
      name: 'body-rule', kind: 'block', target: 'body', pattern: 'queryBody', scope: 'global',
    });
    expect(r.status).toBe(200);
    const row = sqlite.prepare("SELECT target FROM guard_rules WHERE name = 'body-rule'").get() as { target: string };
    expect(row.target).toBe('body');
    await api('DELETE', `/api/v1/guard-rules/${(r.json.data as { id: string }).id}`, adminCookie);
  });

  it('body 规则命中请求体键名（arg 维度不会）', () => {
    const rules: ReturnType<typeof loadActiveRules> = [{
      id: 'b1', name: 'b1', kind: 'block', target: 'body', pattern: 'queryBody', priority: 0, scope: 'global',
    }];
    const args = { queryBody: { size: 5 } };
    expect(evaluateRules(rules, { tool: 't', args, assetType: 'other' })?.ruleId).toBe('b1');
  });
});
