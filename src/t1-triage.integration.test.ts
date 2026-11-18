/**
 * T1 安全与正确性止血回归（tasks-2611-1215-14）：
 *  1. GET /servers/:id/slots 的 inlineValue 仅归属人/admin 返回明文，其余可见者得 hasInline（掩码）
 *  2. DELETE /slots/:slotName 传 credentialId 时校验一致，绑定已变更 → 409（不误删）
 *  3. POST /servers 创建即绑定 + 直填值，单事务原子落库（同槽位互斥 → 400 且不留半成品）
 *  4. POST /market/instantiate 接收 inlineValues，一次落库（不再依赖二次 PUT）
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
import { CredentialService } from './services/credentials.js';
import { InstancePool } from './services/instancePool.js';
import { buildApp } from './app.js';
import type { CatalogEntry } from './services/marketCatalog.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/mock-mcp-server.mjs', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

/** 实例池只做预热占位：本测试只验落库，不实际拉起子进程 */
const pool = new InstancePool({
  globalBudget: 2, globalWeightBudget: 6, maxPerAsset: 1, queuePerUser: 2, globalConcurrency: 1,
  idleTtlMs: 5_000, queueTimeoutMs: 1_000, degradeWaitMs: 500, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
  runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-rt-')),
});

/** 离线合成目录条目：env 占位符 → 自动识别槽位 */
const SYNTHETIC: CatalogEntry = {
  key: 't1-echo',
  name: 't1-echo',
  displayName: 'T1 Echo MCP',
  description: 'T1 回归用（离线夹具）',
  repository: 'https://example.invalid',
  categories: ['other'],
  tags: [],
  runtime: 'npm',
  slotLabels: { AUTH: '认证口令' },
  installations: { npm: { command: process.execPath, args: [FIXTURE], env: { MY_TOKEN: '${AUTH}' } } },
};

let app: FastifyInstance;
let sqlite: Database.Database;
let ownerCookie: string;
let memberCookie: string;
let ownerId: string;
let memberId: string;
let groupId: string;
let assetId: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'owner', password: 'password-12345', isAdmin: false });
  await createUserWithPassword(auth, { username: 'member', password: 'password-12345', isAdmin: false });
  ownerId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'owner')).get())!.id;
  memberId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'member')).get())!.id;

  // 分组含 owner + member；资产 owner 所有、group 可见
  const g = await db.insert(schema.groups).values({ name: 't1-team' }).returning({ id: schema.groups.id }).get();
  groupId = g.id;
  await db.insert(schema.groupUsers).values([
    { groupId, userId: ownerId },
    { groupId, userId: memberId },
  ]).run();
  const asset = await db
    .insert(schema.servers)
    .values({
      name: 't1-shared-asset', displayName: 'T1 Shared', type: 'stdio', executionMode: 'mcp',
      category: 'other', ownerId, visibility: 'group', configHash: 'ch-t1',
      command: 'node', args: [], env: {},
      credentialSlots: [{ target: 'env', name: 'AUTH', label: '认证', file: false }] as never,
    })
    .returning({ id: schema.servers.id })
    .get();
  assetId = asset.id;
  await db.insert(schema.groupServers).values({ groupId, serverId: assetId }).run();

  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite,
    credentials,
    instancePool: pool,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'rt-')),
    marketEntries: [SYNTHETIC],
  });

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
  ownerCookie = await login('owner');
  memberCookie = await login('member');
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); await pool.releaseAll(); });

interface Json { code: number; data: unknown; message: string }

async function api(method: string, url: string, cookie: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

describe('T1-1 直填值按归属掩码', () => {  it('owner 得明文，成员得 hasInline 且 inlineValue=null', async () => {
    const put = await api('PUT', `/api/v1/servers/${assetId}/slots/AUTH/value`, ownerCookie, { value: 'owner-secret' });
    expect(put.status).toBe(200);

    const ownerView = (await api('GET', `/api/v1/servers/${assetId}/slots`, ownerCookie)).json.data as Array<{ inlineValue: string | null; hasInline?: boolean }>;
    expect(ownerView[0]!.inlineValue).toBe('owner-secret');
    expect(ownerView[0]!.hasInline).toBe(true);

    const memberView = (await api('GET', `/api/v1/servers/${assetId}/slots`, memberCookie)).json.data as Array<{ inlineValue: string | null; hasInline?: boolean }>;
    expect(memberView[0]!.inlineValue).toBeNull();
    expect(memberView[0]!.hasInline).toBe(true);
  });
});

describe('T1-2 解绑按 credentialId 精确匹配', () => {
  it('同槽绑两条 → 用某条自己的 credentialId 解绑只删那一条', async () => {
    const c1 = await api('POST', '/api/v1/credentials', memberCookie, { name: 't1-cred-1', values: { AUTH: 'a' } });
    const c2 = await api('POST', '/api/v1/credentials', memberCookie, { name: 't1-cred-2', values: { AUTH: 'b' } });
    const cid1 = (c1.json.data as { id: string }).id;
    const cid2 = (c2.json.data as { id: string }).id;

    // 一槽多凭证（主键含 credential_id）：同槽同人可以并存两条绑定
    expect((await api('POST', `/api/v1/servers/${assetId}/slots`, memberCookie, { slotName: 'AUTH', credentialId: cid1 })).status).toBe(200);
    expect((await api('POST', `/api/v1/servers/${assetId}/slots`, memberCookie, { slotName: 'AUTH', credentialId: cid2 })).status).toBe(200);
    const before = sqlite.prepare('SELECT credential_id AS cid FROM server_credentials WHERE server_id = ? AND user_id = ?').all(assetId, memberId) as Array<{ cid: string }>;
    expect(before.map((r) => r.cid).sort()).toEqual([cid1, cid2].sort());

    // 解绑 cid1 → 只删 cid1，cid2 保留（不能误删同槽的其他绑定）
    const ok = await api('DELETE', `/api/v1/servers/${assetId}/slots/AUTH?credentialId=${cid1}`, memberCookie);
    expect(ok.status).toBe(200);
    const rows = sqlite.prepare('SELECT credential_id AS cid FROM server_credentials WHERE server_id = ? AND user_id = ?').all(assetId, memberId) as Array<{ cid: string }>;
    expect(rows.map((r) => r.cid)).toEqual([cid2]);
  });
});

describe('T1-3 创建即绑定（POST /servers 单事务）', () => {
  it('同一请求写入凭证绑定 + 直填值，一次落库', async () => {
    const cred = await api('POST', '/api/v1/credentials', ownerCookie, { name: 't1-create-cred', values: { PW: 'p' } });
    const credId = (cred.json.data as { id: string }).id;

    const srv = await api('POST', '/api/v1/servers', ownerCookie, {
      name: 't1-created-kv', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'node', args: [], env: {},
      credentialSlots: [
        { target: 'env', name: 'AUTH', label: '认证', file: false },
        { target: 'env', name: 'PW', label: '口令', file: false },
      ],
      credentialBindings: { AUTH: credId },
      inlineValues: { PW: 'inline-pw' },
    });
    expect(srv.status).toBe(200);
    const sid = (srv.json.data as { id: string }).id;

    const binds = sqlite.prepare('SELECT slot_name AS s, credential_id AS c FROM server_credentials WHERE server_id = ?').all(sid) as Array<{ s: string; c: string }>;
    expect(binds).toEqual([{ s: 'AUTH', c: credId }]);
    const inlines = sqlite.prepare('SELECT slot_name AS s FROM server_slot_values WHERE server_id = ?').all(sid) as Array<{ s: string }>;
    expect(inlines.map((r) => r.s)).toEqual(['PW']);
  });

  it('同槽位既绑凭证又填值 → 400，且不留下半成品资产', async () => {
    const cred = await api('POST', '/api/v1/credentials', ownerCookie, { name: 't1-conflict-cred', values: { AUTH: 'x' } });
    const credId = (cred.json.data as { id: string }).id;
    const before = (sqlite.prepare('SELECT COUNT(*) c FROM servers').get() as { c: number }).c;

    const bad = await api('POST', '/api/v1/servers', ownerCookie, {
      name: 't1-conflict', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'node', args: [], env: {},
      credentialSlots: [{ target: 'env', name: 'AUTH', label: '认证', file: false }],
      credentialBindings: { AUTH: credId },
      inlineValues: { AUTH: 'inline' },
    });
    expect(bad.status).toBe(400);
    const after = (sqlite.prepare('SELECT COUNT(*) c FROM servers').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('绑定他人凭证 → 400（防转授权），不落库', async () => {
    const cred = await api('POST', '/api/v1/credentials', memberCookie, { name: 't1-member-cred', values: { AUTH: 'y' } });
    const credId = (cred.json.data as { id: string }).id;
    const bad = await api('POST', '/api/v1/servers', ownerCookie, {
      name: 't1-foreign-bind', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'node', args: [], env: {},
      credentialSlots: [{ target: 'env', name: 'AUTH', label: '认证', file: false }],
      credentialBindings: { AUTH: credId },
    });
    expect(bad.status).toBe(400);
    const n = (sqlite.prepare("SELECT COUNT(*) c FROM servers WHERE name = 't1-foreign-bind'").get() as { c: number }).c;
    expect(n).toBe(0);
  });
});

describe('T1-4 Market 实例化一次落库直填值', () => {
  it('inlineValues 随 instantiate 写入，无需二次 PUT', async () => {
    const res = await api('POST', '/api/v1/market/instantiate', ownerCookie, {
      pkgName: 't1-echo', name: 't1-echo-asset', inlineValues: { AUTH: 'market-inline' },
    });
    expect(res.status).toBe(200);
    const data = res.json.data as { server: { id: string }; bound: string[]; missingSlots: string[] };
    expect(data.bound).toEqual(['AUTH']);
    expect(data.missingSlots).toEqual([]);
    const rows = sqlite.prepare('SELECT slot_name AS s FROM server_slot_values WHERE server_id = ?').all(data.server.id) as Array<{ s: string }>;
    expect(rows.map((r) => r.s)).toEqual(['AUTH']);
  });

  it('同槽位既传凭证又传直填值 → 400 且不落库', async () => {
    const cred = await api('POST', '/api/v1/credentials', ownerCookie, { name: 't1-market-cred', values: { AUTH: 'z' } });
    const credId = (cred.json.data as { id: string }).id;
    const bad = await api('POST', '/api/v1/market/instantiate', ownerCookie, {
      pkgName: 't1-echo', name: 't1-echo-conflict',
      credentialRefs: { AUTH: credId }, inlineValues: { AUTH: 'both' },
    });
    expect(bad.status).toBe(400);
    const n = (sqlite.prepare("SELECT COUNT(*) c FROM servers WHERE name = 't1-echo-conflict'").get() as { c: number }).c;
    expect(n).toBe(0);
  });
});
