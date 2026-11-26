/**
 * Task 6：发现链路补齐 —— `opsgate_view_asset` 对 CLI 资产返回 `cli` 段。
 *
 * 断言分两层：
 * 1. `buildAssetDetail`（纯函数）：cli 段字段、非 cli 行不出现 cli 段、
 *    以及**只给 env 变量名、不给任何值**（AC-9 / §2 原则 2）；
 * 2. 经 MCP `opsgate_view_asset` 真调用：证明 handler 把 `CliRunner.health` 与执行器
 *    装配状态接进了 cli 段（纯函数层覆盖不到这段连线）。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CredentialService } from './services/credentials.js';
import { InstancePool } from './services/instancePool.js';
import { makeNativeDispatchServices } from './services/nativeDispatch.js';
import { buildAssetDetail, McpEndpoint } from './services/mcpEndpoint.js';
import { CliRunner } from './services/cliRunner.js';
import type { CliHealthStatus } from './services/cliRunner.js';
import { createApiKey } from './services/apiKey.js';
import { createAuth, ensureAuthTables, type Auth } from './services/auth.js';
import { loadNativeTools } from './native/tools/index.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';
/** 刻意可识别的假凭证值：任何出现在详情载荷里都等于泄露 */
const SECRET = 's3cr3t-value-must-not-leak';

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let settings: Settings;
let pool: InstancePool;
let mcp: McpEndpoint;
let auth: Auth;
let adminKey: string;
let adminId: string;
let dataDir: string;
/** 装配进 mcp 的执行器实例：测试用 spy 观察 health 是否被探测 */
let cliRunner: CliRunner;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const key = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 't6-key-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, key);
  pool = new InstancePool({
    globalBudget: 4, globalWeightBudget: 12, maxPerAsset: 2, queuePerUser: 4, globalConcurrency: 2,
    idleTtlMs: 60_000, queueTimeoutMs: 10_000, degradeWaitMs: 3_000, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 't6-rt-')),
  });
  const dispatchServices = makeNativeDispatchServices({ sqlite, db, settings, audit, credentials });
  const nativeRegistry = await loadNativeTools();

  dataDir = mkdtempSync(path.join(tmpdir(), 't6-data-'));
  cliRunner = new CliRunner({
    dataDir,
    runtimeCredsDir: path.join(dataDir, 'rt'),
    baseEnv: { PATH: process.env.PATH ?? '' },
    outputTruncateBytes: () => 4096,
    commandTimeoutMs: () => 5000,
    // 沙箱开关只管执行；cli 段的 runnerAttached 反映"执行器是否装配"（见实现注释）
    sandboxEnabled: () => false,
  });
  const isVisible = (
    asset: { ownerId: string | null; visibility: string },
    principal: { userId: string; isAdmin: boolean },
  ) => principal.isAdmin || asset.ownerId === principal.userId || asset.visibility === 'public';

  mcp = new McpEndpoint({
    db, sqlite, settings, pool, dispatchServices, audit, nativeRegistry,
    runtimeCredsDir: path.join(dataDir, 'rt'), isVisible, cliRunner,
  });

  await db.insert(schema.users).values({ id: 'u-admin', username: 'admin', name: 'admin', isAdmin: true }).run();
  adminId = 'u-admin';

  auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  app = await buildApp({ db, auth, baseUrl: BASE_URL, instancePool: pool, mcp });
  adminKey = (await createApiKey(db, adminId, 't6-cli')).plainKey;
}, 60_000);

afterAll(async () => {
  await app.close();
  await pool.releaseAll();
  sqlite.close();
});

async function mkAsset(over: Record<string, unknown>): Promise<string> {
  const name = over.name as string;
  return (await db.insert(schema.servers).values({
    name, displayName: name, type: 'native', executionMode: 'cli', category: 'other',
    command: process.execPath, args: [] as never, env: {} as never, credentialSlots: [] as never,
    ownerId: adminId, visibility: 'owner', configHash: `ch-${name}`,
    ...over,
  } as never).returning({ id: schema.servers.id }).get()).id;
}

async function rowOf(id: string) {
  return (await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get())!;
}

function rpc(method: string, params: unknown, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function postMcp(body: unknown, sessionId?: string) {
  return await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    payload: JSON.stringify(body),
  });
}

async function initialize(): Promise<string> {
  const res = await postMcp(rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't6-cli', version: '1' },
  }));
  expect(res.statusCode).toBe(200);
  const sc = res.headers['mcp-session-id'];
  return (Array.isArray(sc) ? sc[0] : sc) as string;
}

function textOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
}

interface CliSection {
  bin: string | null;
  envNames: string[];
  runnerAttached: boolean;
  health: CliHealthStatus['status'] | 'unknown';
}

describe('buildAssetDetail：cli 段（纯函数）', () => {
  it('cli 行输出 bin / envNames / runnerAttached / health，且 env 只给变量名', async () => {
    const id = await mkAsset({
      name: 'detail-cli', category: 'k8s', command: 'echo',
      env: { MY_TOKEN: SECRET, TARGET_MODE: 'prod' } as never,
      credentialSlots: [{ target: 'env', name: 'API_TOKEN', label: 'API Token' }] as never,
    });
    const detail = buildAssetDetail(await rowOf(id), new Set(['API_TOKEN']), ['demo'], {
      runnerAttached: true,
      health: 'healthy',
    });
    const cli = detail.cli as CliSection;

    expect(cli.bin).toBe('echo');
    expect([...cli.envNames].sort()).toEqual(['MY_TOKEN', 'TARGET_MODE']);
    expect(cli.runnerAttached).toBe(true);
    expect(cli.health).toBe('healthy');

    // 核心安全断言：载荷里出现任何一个 env 值都算泄露（凭证模板/明文一律不出现）
    const json = JSON.stringify(detail);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('prod');
    // 允许 credentialSlots[].target === 'env'（槽位注入位置），但不得有承载值的 env 字段
    expect(detail).not.toHaveProperty('env');
    expect(Object.keys(detail.cli as CliSection).sort()).toEqual(['bin', 'envNames', 'health', 'runnerAttached']);
  });

  it('执行器未装配 → runnerAttached=false、health=unknown（不伪造 healthy）', async () => {
    const id = await mkAsset({ name: 'detail-cli-norunner', category: 'other', command: 'echo' });
    const detail = buildAssetDetail(await rowOf(id), new Set(), [], undefined);
    expect(detail.cli).toMatchObject({ bin: 'echo', runnerAttached: false, health: 'unknown' });
  });

  it('CLI 资产缺 command → bin 为 null（缺失不伪装成空串）', async () => {
    const id = await mkAsset({ name: 'detail-cli-nocmd', category: 'other', command: null });
    const detail = buildAssetDetail(await rowOf(id), new Set(), [], { runnerAttached: true, health: 'bin-missing' });
    expect(detail.cli).toMatchObject({ bin: null, health: 'bin-missing' });
  });

  it('非 cli 行不出现 cli 段（没有二进制/沙箱这些事实就不给字段）', async () => {
    const id = await mkAsset({ name: 'detail-native', category: 'other', executionMode: 'native', command: null });
    const detail = buildAssetDetail(await rowOf(id), new Set(), [], undefined);
    expect(detail).not.toHaveProperty('cli');
    // 既有字段仍在：envKeys 只给键名
    expect(detail.envKeys).toEqual([]);
  });
});

describe('opsgate_view_asset：cli 段接线', { timeout: 30_000 }, () => {
  it('cli 资产详情带 cli 段：health 来自 CliRunner，载荷不含 env 值', async () => {
    const id = await mkAsset({
      name: 'view-cli', category: 'k8s', command: process.execPath,
      env: { MY_TOKEN: SECRET } as never,
    });
    const sid = await initialize();
    const res = await postMcp(rpc('tools/call', { name: 'opsgate_view_asset', arguments: { asset: id } }), sid);
    const text = textOf(res);
    const detail = JSON.parse(text) as { cli: CliSection };

    expect(detail.cli.bin).toBe(process.execPath);
    expect(detail.cli.envNames).toContain('MY_TOKEN');
    expect(detail.cli.runnerAttached).toBe(true);
    // process.execPath 必然存在且可执行 → healthy（这不是 mock，是真实探测）
    expect(detail.cli.health).toBe('healthy');
    expect(text).not.toContain(SECRET);
    expect(detail).not.toHaveProperty('env');
  });

  it('二进制不存在 → health=bin-missing（健康状态是真探测，不是配置回显）', async () => {
    const id = await mkAsset({ name: 'view-cli-missing', category: 'other', command: 'definitely-not-a-bin-xyz' });
    const sid = await initialize();
    const res = await postMcp(rpc('tools/call', { name: 'opsgate_view_asset', arguments: { asset: id } }), sid);
    const detail = JSON.parse(textOf(res)) as { cli: CliSection };
    expect(detail.cli.health).toBe('bin-missing');
  });

  it('非 cli 资产 view 不触发 health 探测（非 CLI 行本来就无 cli 段，探测是纯白跑开销）', async () => {
    const nativeId = await mkAsset({ name: 'view-native', category: 'other', executionMode: 'native', command: null });
    const cliId = await mkAsset({ name: 'view-cli-spy', category: 'other', command: process.execPath });
    const spy = vi.spyOn(cliRunner, 'health');
    try {
      const sid = await initialize();
      const nativeRes = await postMcp(rpc('tools/call', { name: 'opsgate_view_asset', arguments: { asset: nativeId } }), sid);
      expect(JSON.parse(textOf(nativeRes))).not.toHaveProperty('cli');
      expect(spy).not.toHaveBeenCalled();

      // 正向对照：证明 spy 本身是活的（否则上面的 not.toHaveBeenCalled 毫无意义）
      const cliRes = await postMcp(rpc('tools/call', { name: 'opsgate_view_asset', arguments: { asset: cliId } }), sid);
      expect((JSON.parse(textOf(cliRes)) as { cli: CliSection }).cli.health).toBe('healthy');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('执行器未装配（Task 9 前）：cli 段仍返回，runnerAttached=false / health=unknown', async () => {
    const id = await mkAsset({ name: 'view-cli-norunner', category: 'other', command: 'echo' });
    const noRunner = new McpEndpoint({
      db, sqlite, settings, pool,
      dispatchServices: makeNativeDispatchServices({
        sqlite, db, settings, audit: new AuditService(sqlite, settings), credentials: new CredentialService(sqlite, loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 't6-key2-')), 'k'))),
      }),
      audit: new AuditService(sqlite, settings), nativeRegistry: await loadNativeTools(),
      runtimeCredsDir: path.join(dataDir, 'rt'),
      // CLI 执行器未装配
      isVisible: (asset, principal) => principal.isAdmin || asset.ownerId === principal.userId || asset.visibility === 'public',
    });
    const appNoRunner = await buildApp({ db, auth, baseUrl: BASE_URL, instancePool: pool, mcp: noRunner });
    try {
      const res = await appNoRunner.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: JSON.stringify(rpc('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't6-cli-norunner', version: '1' },
        })),
      });
      const rawSid = res.headers['mcp-session-id'];
      const sid = (Array.isArray(rawSid) ? rawSid[0] : rawSid) as string;
      const call = await appNoRunner.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sid,
        },
        payload: JSON.stringify(rpc('tools/call', { name: 'opsgate_view_asset', arguments: { asset: id } })),
      });
      const detail = JSON.parse(textOf(call)) as { cli: CliSection };
      expect(detail.cli).toMatchObject({ bin: 'echo', runnerAttached: false, health: 'unknown' });
    } finally {
      await appNoRunner.close();
    }
  });
});
