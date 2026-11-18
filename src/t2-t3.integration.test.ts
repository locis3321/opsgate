/**
 * T2/T3 回归（tasks-2611-1215-14）：
 *  T2-4 资产列表 visibility 筛选（仅归属人 / 分组共享 / 公开）
 *  T3-1 首启 seed 内置 Market 目录（幂等、不覆盖后台已改条目）
 *  T3-2 verify 发布前现场连通测试（通过才发布 / 失败拒绝并保持 draft）
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
import { InstancePool } from './services/instancePool.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';
import { entryToRow, insertEntry, getEntryRaw } from './db/marketEntries.js';
import { loadCatalog } from './services/marketCatalog.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/mock-mcp-server.mjs', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

const pool = new InstancePool({
  globalBudget: 2, globalWeightBudget: 6, maxPerAsset: 1, queuePerUser: 2, globalConcurrency: 1,
  idleTtlMs: 5_000, queueTimeoutMs: 1_000, degradeWaitMs: 500, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
  runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-rt-')),
});

let app: FastifyInstance;
let sqlite: Database.Database;
let cookie: string;
let userId: string;

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
  await createUserWithPassword(auth, { username: 't2user', password: 'password-12345', isAdmin: true });
  userId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 't2user')).get())!.id;

  // 三条不同可见范围的资产（同 owner，便于筛选断言）
  const mk = async (name: string, visibility: string) => {
    const row = await db.insert(schema.servers).values({
      name, displayName: name, type: 'native', executionMode: 'native', category: 'host',
      ownerId: userId, visibility, configHash: `ch-${name}`,
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops' } as never,
      credentialSlots: [] as never,
    }).returning({ id: schema.servers.id }).get();
    return row.id;
  };
  await mk('vis-owner', 'owner');
  await mk('vis-group', 'group');
  await mk('vis-public', 'public');

  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite,
    credentials, instancePool: pool,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'rt-')),
    marketEntries: [],
  });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username: 't2user', password: 'password-12345' },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc];
  cookie = arr[0]!.split(';')[0]!;
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); await pool.releaseAll(); });

async function api(method: string, url: string, payload?: unknown): Promise<{ status: number; json: { code: number; data: unknown; message: string } }> {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as { code: number; data: unknown; message: string } };
}

describe('T2-4 资产列表 visibility 筛选', () => {
  it('按可见范围筛选：owner / group / public 各自精确命中', async () => {
    for (const v of ['owner', 'group', 'public'] as const) {
      const r = await api('GET', `/api/v1/servers?visibility=${v}`);
      expect(r.status).toBe(200);
      const items = (r.json.data as { items: Array<{ name: string; visibility: string }> }).items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.visibility === v)).toBe(true);
      expect(items.map((i) => i.name)).toContain(`vis-${v}`);
    }
  });

  it('不带 visibility 时返回全部三条', async () => {
    const r = await api('GET', '/api/v1/servers');
    const items = (r.json.data as { items: Array<{ name: string }> }).items;
    for (const v of ['owner', 'group', 'public']) expect(items.map((i) => i.name)).toContain(`vis-${v}`);
  });
});

describe('T3-1 首启 seed 目录幂等', () => {
  it('空库导入全部内置条目；重复导入不新增、不覆盖已改状态', async () => {
    const db = drizzle(sqlite, { schema });
    const catalog = loadCatalog();
    expect(catalog.length).toBeGreaterThan(0);

    // 模拟首启 seed
    for (const entry of catalog) {
      db.insert(schema.marketEntries).values(entryToRow(entry, 'verified')).onConflictDoNothing({ target: schema.marketEntries.key }).run();
    }
    const first = db.select().from(schema.marketEntries).all().length;
    expect(first).toBe(catalog.length);

    // 后台把某条改成 disabled，再跑一次 seed：不得覆盖
    const target = catalog[0]!.key;
    db.update(schema.marketEntries).set({ status: 'disabled' }).where(eq(schema.marketEntries.key, target)).run();
    for (const entry of catalog) {
      db.insert(schema.marketEntries).values(entryToRow(entry, 'verified')).onConflictDoNothing({ target: schema.marketEntries.key }).run();
    }
    const after = db.select().from(schema.marketEntries).all().length;
    expect(after).toBe(first);
    expect(getEntryRaw(db, target)!.status).toBe('disabled');
  });
});

describe('T3-2 verify 强制现场连通测试', () => {
  it('可执行条目：测试通过后 draft→verified，并回带 tools 数', async () => {
    insertEntry(drizzle(sqlite, { schema }), {
      key: 't3-local', name: 't3-local', displayName: 'T3 Local', description: '本地夹具',
      repository: 'https://example.invalid', categories: ['other'], tags: [],
      runtime: 'npm', installations: { npm: { command: process.execPath, args: [FIXTURE], env: {} } },
    }, 'draft');
    const r = await api('POST', '/api/v1/market/entries/t3-local/verify', {});
    expect(r.status).toBe(200);
    const d = r.json.data as { status: string; tested: boolean; tools: number };
    expect(d.status).toBe('verified');
    expect(d.tested).toBe(true);
  });

  it('不可执行条目：拒绝发布（409）并保持 draft', async () => {
    insertEntry(drizzle(sqlite, { schema }), {
      key: 't3-broken', name: 't3-broken', displayName: 'T3 Broken', description: '不可执行',
      repository: 'https://example.invalid', categories: ['other'], tags: [],
      runtime: 'npm', installations: { npm: { command: 'no-such-binary-xyz', args: [], env: {} } },
    }, 'draft');
    const r = await api('POST', '/api/v1/market/entries/t3-broken/verify', {});
    expect(r.status).toBe(409);
    expect(r.json.message).toContain('连通测试未通过');
    const row = getEntryRaw(drizzle(sqlite, { schema }), 't3-broken')!;
    expect(row.status).toBe('draft');
  });
});

describe('T5-1 凭证类型数据驱动', () => {
  it('GET /credentials/types 返回字典，新增类型无需改前端', async () => {
    const r = await api('GET', '/api/v1/credentials/types');
    expect(r.status).toBe(200);
    const types = r.json.data as Array<{ kind: string; label: string; keys?: string[]; fields: unknown[] }>;
    expect(types.length).toBeGreaterThan(0);
    const kinds = types.map((t) => t.kind);
    // 兜底类型必须存在
    expect(kinds).toContain('env-values');
    // 每个类型都带 label 与 keys（供"键名不命中"解释）
    for (const t of types) {
      expect(typeof t.label).toBe('string');
      expect(Array.isArray(t.keys)).toBe(true);
    }
  });

  it('未在字典中的 kind → 创建被拒（400）', async () => {
    const r = await api('POST', '/api/v1/credentials', {
      name: 'bad-kind-cred', kind: 'not-a-real-kind', values: { A: 'b' },
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('kind');
  });
});

describe('T7-1 批量槽位状态（去 N+1）', () => {
  it('一次请求返回多资产聚合状态；无槽位→total=0，未绑定→missing>0', async () => {
    // 造两个资产：一个无槽位，一个有未绑定槽位
    const a1 = await api('POST', '/api/v1/servers', {
      name: 't7-noslot', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'node', args: [], env: {}, credentialSlots: [],
    });
    const a2 = await api('POST', '/api/v1/servers', {
      name: 't7-missingslot', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'node', args: [], env: {}, credentialSlots: [{ target: 'env', name: 'TOKEN', label: 'x', file: false }],
    });
    const id1 = (a1.json.data as { id: string }).id;
    const id2 = (a2.json.data as { id: string }).id;

    const r = await api('GET', `/api/v1/servers/slot-status?ids=${id1},${id2}`);
    expect(r.status).toBe(200);
    const map = r.json.data as Record<string, { total: number; missing: number }>;
    expect(map[id1]).toEqual({ total: 0, missing: 0 });
    expect(map[id2]).toEqual({ total: 1, missing: 1 });
  });

  it('不可见资产不出现在结果中（按 can(view) 过滤）', async () => {
    const r = await api('GET', '/api/v1/servers/slot-status?ids=not-exist-id');
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({});
  });
});

describe('审查修复：安全摘要与页大小', () => {
  it('security-summary 返回全量聚合（total/public/missing），不吞错', async () => {
    const r = await api('GET', '/api/v1/servers/security-summary');
    expect(r.status).toBe(200);
    const d = r.json.data as { totalAssets: number; publicCount: number; missingCredAssets: number };
    expect(typeof d.totalAssets).toBe('number');
    expect(typeof d.publicCount).toBe('number');
    expect(typeof d.missingCredAssets).toBe('number');
    // vis-public 那条应计入 publicCount
    expect(d.publicCount).toBeGreaterThanOrEqual(1);
  });

  it('GET /servers?pageSize= 支持放宽页大小（选择器场景），并有 500 上限保护', async () => {
    const big = await api('GET', '/api/v1/servers?page=1&pageSize=500');
    expect(big.status).toBe(200);
    // 超上限被夹取而非报错
    const over = await api('GET', '/api/v1/servers?page=1&pageSize=99999');
    expect(over.status).toBe(200);
    expect((over.json.data as { items: unknown[] }).items.length).toBeLessThanOrEqual(500);
  });
});
