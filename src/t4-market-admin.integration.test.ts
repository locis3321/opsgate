/**
 * T4 集成测试：Market 条目管理 API（ADR-029）。
 * 覆盖权限（admin-only）、增删改、状态机、删除引用保护、字段校验。
 * 连通性测试端点单独验证（需要真实拉起子进程）。
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
import { insertEntry } from './db/marketEntries.js';
import type { CatalogEntry } from './services/marketCatalog.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/mock-mcp-server.mjs', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let adminCookie: string;
let userCookie: string;

const pool = new InstancePool({
  globalBudget: 4, globalWeightBudget: 12, maxPerAsset: 2, queuePerUser: 4, globalConcurrency: 2,
  idleTtlMs: 60_000, queueTimeoutMs: 5_000, degradeWaitMs: 3_000, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
  runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-rt-')),
});

const SAMPLE_ENTRY: CatalogEntry = {
  key: 'test-fs-mcp',
  name: 'test-fs-mcp',
  displayName: 'Test FS MCP',
  description: '文件系统 MCP（测试用）',
  repository: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem',
  categories: ['other'],
  tags: ['filesystem'],
  runtime: 'npm',
  slotLabels: { FS_ROOT: '根路径' },
  installations: {
    npm: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@0.6.2', '/tmp'],
      env: { FS_ROOT: '/tmp' },
    },
  },
};

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

  // 引用保护用例：一个资产挂在该条目下
  const aliceId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'alice')).get())!.id;
  insertEntry(db, SAMPLE_ENTRY, 'verified');
  await db
    .insert(schema.servers)
    .values({
      id: 'srv-ref', name: 'srv-ref', type: 'stdio', executionMode: 'mcp', category: 'other',
      ownerId: aliceId, configHash: 'c-ref', credentialSlots: [], marketKey: SAMPLE_ENTRY.key,
    })
    .run();

  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite,
    instancePool: pool,
    credentials: new CredentialService(sqlite, cryptoKey),
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'rt-')),
  });
  const login = async (username: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/username',
      payload: { username, password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const sc = res.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
    return arr[0]!.split(';')[0]!;
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

describe('T4：权限（admin-only）', { timeout: 20_000 }, () => {
  it('非管理员全部管理端点均 403', async () => {
    for (const [m, u] of [
      ['GET', '/api/v1/market/entries'],
      ['POST', '/api/v1/market/entries'],
      ['PATCH', `/api/v1/market/entries/${SAMPLE_ENTRY.key}`],
      ['DELETE', `/api/v1/market/entries/${SAMPLE_ENTRY.key}`],
      ['POST', `/api/v1/market/entries/${SAMPLE_ENTRY.key}/verify`],
      ['POST', `/api/v1/market/entries/${SAMPLE_ENTRY.key}/disable`],
      ['POST', `/api/v1/market/entries/${SAMPLE_ENTRY.key}/enable`],
    ] as const) {
      const res = await api(m as never, u, userCookie, m === 'GET' ? undefined : {});
      expect(res.status, `${m} ${u}`).toBe(403);
    }
  });

  it('未登录返回 401/403（default-deny）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/market/entries' });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('T4：增删改', { timeout: 20_000 }, () => {
  it('POST 新增 → 201，默认 draft，列表可见', async () => {
    const created = await api('POST', '/api/v1/market/entries', adminCookie, {
      ...SAMPLE_ENTRY,
      key: 'new-entry',
      name: 'new-entry',
    });
    expect(created.status).toBe(201);
    expect((created.json.data as { status: string }).status).toBe('draft');

    const list = await api('GET', '/api/v1/market/entries', adminCookie);
    expect(list.status).toBe(200);
    const items = list.json.data as Array<{ key: string; status: string }>;
    expect(items.find((i) => i.key === 'new-entry')?.status).toBe('draft');
  });

  it('POST 重复 key → 409', async () => {
    const dup = await api('POST', '/api/v1/market/entries', adminCookie, {
      ...SAMPLE_ENTRY,
      key: 'new-entry',
      name: 'new-entry',
    });
    expect(dup.status).toBe(409);
  });

  it('POST 缺少必填 / 非法 runtime → 400', async () => {
    const noName = await api('POST', '/api/v1/market/entries', adminCookie, {
      ...SAMPLE_ENTRY,
      key: 'bad-1',
      name: undefined,
    });
    expect(noName.status).toBe(400);

    const badRuntime = await api('POST', '/api/v1/market/entries', adminCookie, {
      ...SAMPLE_ENTRY,
      key: 'bad-2',
      name: 'bad-2',
      runtime: 'docker',
    });
    expect(badRuntime.status).toBe(400);
    expect(badRuntime.json.message).toContain('runtime');
  });

  it('POST runtime 分支缺失 → 400（installations 无对应 runtime 配置）', async () => {
    const res = await api('POST', '/api/v1/market/entries', adminCookie, {
      ...SAMPLE_ENTRY,
      key: 'bad-3',
      name: 'bad-3',
      runtime: 'pypi',
    });
    expect(res.status).toBe(400);
    expect(res.json.message).toContain('installations');
  });

  it('PATCH 部分更新，未传字段保持原值', async () => {
    const patch = await api('PATCH', '/api/v1/market/entries/new-entry', adminCookie, {
      description: '改过的描述',
    });
    expect(patch.status).toBe(200);

    const got = await api('GET', '/api/v1/market/entries/new-entry', adminCookie);
    const d = got.json.data as { description: string; displayName: string; categories: string[] };
    expect(d.description).toBe('改过的描述');
    expect(d.displayName).toBe(SAMPLE_ENTRY.displayName);
    expect(d.categories).toEqual(SAMPLE_ENTRY.categories);
  });

  it('PATCH 试图改 status → 400（必须走专用端点）', async () => {
    const res = await api('PATCH', '/api/v1/market/entries/new-entry', adminCookie, { status: 'verified' });
    expect(res.status).toBe(400);
    expect(res.json.message).toContain('/verify');
  });

  it('PATCH 改 key → 400', async () => {
    const res = await api('PATCH', '/api/v1/market/entries/new-entry', adminCookie, { key: 'other-key' });
    expect(res.status).toBe(400);
  });

  it('GET 不存在的条目 → 404', async () => {
    const res = await api('GET', '/api/v1/market/entries/nope', adminCookie);
    expect(res.status).toBe(404);
  });
});

describe('T4：状态机', { timeout: 60_000 }, () => {
  /**
   * T3 起 verify 改为"发布前现场连通测试"：必须先能拉起并 listTools 才允许 draft→verified。
   * 这里面向成员目录里真实可执行的 fixture 条目建一个 draft，验证两条路径。
   */
  const LOCAL = {
    key: 'local-verify-entry',
    displayName: 'Local Verify Entry',
  };
  const localInstallations = {
    npm: { command: process.execPath, args: [FIXTURE], env: {} },
  };

  it('新增本地可执行条目（draft）', async () => {
    const created = await api('POST', '/api/v1/market/entries', adminCookie, {
      key: LOCAL.key,
      name: LOCAL.key,
      displayName: LOCAL.displayName,
      description: '本地 fixture 条目（发布前测试用）',
      repository: 'https://example.invalid',
      categories: ['other'],
      tags: [],
      runtime: 'npm',
      installations: localInstallations,
    });
    expect(created.status).toBe(201);
    expect((created.json.data as { status: string }).status).toBe('draft');
  });

  it('draft → verify → verified（现场连通测试通过）', async () => {
    const res = await api('POST', `/api/v1/market/entries/${LOCAL.key}/verify`, adminCookie, {});
    expect(res.status).toBe(200);
    const data = res.json.data as { status: string; tested: boolean; tools: number };
    expect(data.status).toBe('verified');
    expect(data.tested).toBe(true);
    expect(data.tools).toBeGreaterThan(0);
  });

  it('verify 时现场测试失败 → 409 且状态保持 draft', async () => {
    const badKey = 'unreachable-entry';
    const created = await api('POST', '/api/v1/market/entries', adminCookie, {
      key: badKey,
      name: badKey,
      displayName: 'Unreachable',
      description: '不可执行的命令（测试拒绝发布）',
      repository: 'https://example.invalid',
      categories: ['other'],
      tags: [],
      runtime: 'npm',
      installations: { npm: { command: 'definitely-not-a-real-command-xyz', args: [], env: {} } },
    });
    expect(created.status).toBe(201);
    const res = await api('POST', `/api/v1/market/entries/${badKey}/verify`, adminCookie, {});
    expect(res.status).toBe(409);
    expect(res.json.message).toContain('连通测试未通过');
    const list = await api('GET', '/api/v1/market/entries', adminCookie);
    expect((list.json.data as Array<{ key: string; status: string }>).find((i) => i.key === badKey)?.status).toBe('draft');
  });

  it('verified → disable → disabled', async () => {
    const res = await api('POST', `/api/v1/market/entries/${LOCAL.key}/disable`, adminCookie, {});
    expect(res.status).toBe(200);
    expect((res.json.data as { status: string }).status).toBe('disabled');
  });

  it('disabled 条目从成员目录消失，管理员管理列表仍可见', async () => {
    const memberList = await api('GET', '/api/v1/market/catalog', userCookie);
    const keys = (memberList.json.data as { items: Array<{ key: string }> }).items.map((i) => i.key);
    expect(keys).not.toContain(LOCAL.key);

    const adminList = await api('GET', '/api/v1/market/entries', adminCookie);
    expect((adminList.json.data as Array<{ key: string }>).some((i) => i.key === LOCAL.key)).toBe(true);
  });

  it('disabled → enable → verified', async () => {
    const res = await api('POST', `/api/v1/market/entries/${LOCAL.key}/enable`, adminCookie, {});
    expect(res.status).toBe(200);
    expect((res.json.data as { status: string }).status).toBe('verified');
  });

  it('非法转移：verified 上再 verify → 409', async () => {
    const res = await api('POST', `/api/v1/market/entries/${LOCAL.key}/verify`, adminCookie, {});
    expect(res.status).toBe(409);
  });

  it('非法转移：verified 上 enable → 409', async () => {
    const res = await api('POST', `/api/v1/market/entries/${LOCAL.key}/enable`, adminCookie, {});
    expect(res.status).toBe(409);
  });
});

describe('T4：删除引用保护', { timeout: 20_000 }, () => {
  it('被资产引用的条目 DELETE → 409，并提示改用停用', async () => {
    const res = await api('DELETE', `/api/v1/market/entries/${SAMPLE_ENTRY.key}`, adminCookie);
    expect(res.status).toBe(409);
    expect(res.json.message).toContain('停用');
  });

  it('无引用的条目 DELETE → 200，随后 404', async () => {
    const del = await api('DELETE', '/api/v1/market/entries/new-entry', adminCookie);
    expect(del.status).toBe(200);
    const got = await api('GET', '/api/v1/market/entries/new-entry', adminCookie);
    expect(got.status).toBe(404);
  });

  it('被引用条目即使停用也不可删除（引用仍在）', async () => {
    await api('POST', `/api/v1/market/entries/${SAMPLE_ENTRY.key}/disable`, adminCookie, {});
    const res = await api('DELETE', `/api/v1/market/entries/${SAMPLE_ENTRY.key}`, adminCookie);
    expect(res.status).toBe(409);
  });
});

describe('T4：连通性测试端点', { timeout: 60_000 }, () => {
  it('可执行条目 → ok:true + tools 数；不可执行条目 → ok:false + error', async () => {
    const FIXTURE = fileURLToPath(new URL('../test/fixtures/mock-mcp-server.mjs', import.meta.url));
    const good = await api('POST', '/api/v1/market/entries', adminCookie, {
      key: 'probe-ok',
      name: 'probe-ok',
      displayName: 'Probe OK',
      description: '本地 fixture',
      repository: 'https://example.invalid',
      categories: ['other'],
      tags: [],
      runtime: 'npm',
      installations: { npm: { command: process.execPath, args: [FIXTURE], env: {} } },
    });
    expect(good.status).toBe(201);

    const ok = await api('POST', '/api/v1/market/entries/probe-ok/test', adminCookie, {});
    expect(ok.status).toBe(200);
    const okData = ok.json.data as { ok: boolean; tools?: number };
    expect(okData.ok).toBe(true);
    expect(okData.tools).toBeGreaterThan(0);

    const bad = await api('POST', '/api/v1/market/entries', adminCookie, {
      key: 'probe-bad',
      name: 'probe-bad',
      displayName: 'Probe Bad',
      description: '不存在的命令',
      repository: 'https://example.invalid',
      categories: ['other'],
      tags: [],
      runtime: 'npm',
      installations: { npm: { command: 'definitely-not-a-command-xyz', args: [], env: {} } },
    });
    expect(bad.status).toBe(201);

    const fail = await api('POST', '/api/v1/market/entries/probe-bad/test', adminCookie, {});
    expect(fail.status).toBe(200);
    const failData = fail.json.data as { ok: boolean; error?: string };
    expect(failData.ok).toBe(false);
    expect(failData.error).toBeTruthy();
  });
});

describe('T4：管理列表字段', { timeout: 20_000 }, () => {
  it('列表含 assetCount 与状态字段', async () => {
    const res = await api('GET', '/api/v1/market/entries', adminCookie);
    const items = res.json.data as Array<{ key: string; assetCount: number; status: string }>;
    const ref = items.find((i) => i.key === SAMPLE_ENTRY.key)!;
    expect(ref.assetCount).toBe(1);
    expect(ref.status).toBe('disabled');
  });

  it('按 status / category 过滤', async () => {
    const byStatus = await api('GET', '/api/v1/market/entries?status=disabled', adminCookie);
    const st = (byStatus.json.data as Array<{ status: string }>).every((i) => i.status === 'disabled');
    expect(st).toBe(true);

    const byCat = await api('GET', '/api/v1/market/entries?category=other', adminCookie);
    const keys = (byCat.json.data as Array<{ key: string }>).map((i) => i.key);
    expect(keys).toContain(SAMPLE_ENTRY.key);
  });
});

describe('T4：编辑安装配置后 versionPinned 同步重算', { timeout: 20_000 }, () => {
  it('PATCH installations 改版本 → versionPinned 跟着变（否则升级提示会误报）', async () => {
    const created = await api('POST', '/api/v1/market/entries', adminCookie, {
      ...SAMPLE_ENTRY,
      key: 'ver-sync',
      name: 'ver-sync',
      installations: { npm: { command: 'npx', args: ['-y', 'pkg@1.0.0'], env: {} } },
    });
    expect(created.status).toBe(201);

    const before = await api('GET', '/api/v1/market/entries/ver-sync', adminCookie);
    expect((before.json.data as { versionPinned: string }).versionPinned).toBe('1.0.0');

    // 只改 installations（未显式传 versionPinned）
    const patched = await api('PATCH', '/api/v1/market/entries/ver-sync', adminCookie, {
      installations: { npm: { command: 'npx', args: ['-y', 'pkg@2.3.4'], env: {} } },
    });
    expect(patched.status).toBe(200);

    const after = await api('GET', '/api/v1/market/entries/ver-sync', adminCookie);
    expect((after.json.data as { versionPinned: string }).versionPinned).toBe('2.3.4');
  });

  it('显式传 versionPinned 优先于自动解析', async () => {
    const res = await api('PATCH', '/api/v1/market/entries/ver-sync', adminCookie, {
      installations: { npm: { command: 'npx', args: ['-y', 'pkg@3.0.0'], env: {} } },
      versionPinned: '9.9.9',
    });
    expect(res.status).toBe(200);
    const got = await api('GET', '/api/v1/market/entries/ver-sync', adminCookie);
    expect((got.json.data as { versionPinned: string }).versionPinned).toBe('9.9.9');
  });

  it('未改 installations 时不动 versionPinned', async () => {
    await api('PATCH', '/api/v1/market/entries/ver-sync', adminCookie, { description: '只改描述' });
    const got = await api('GET', '/api/v1/market/entries/ver-sync', adminCookie);
    expect((got.json.data as { versionPinned: string }).versionPinned).toBe('9.9.9');
  });
});
