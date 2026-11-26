/**
 * Task 4 集成：CLI 工具的聚合与调用分发（设计说明 §3.3 / §4.2）。
 *
 * 本文件的核心是**分支顺序**：`toolsOfAsset` 与 `invokeOnAsset` 里 cli 必须判在 native 之前。
 * 若顺序写反，一个 category=redis 的 CLI 资产会拿到原生进程内工具
 * （redis_command / redis_info / redis_slowlog），等于绕开"CLI 只能跑配置的那个二进制"的边界。
 *
 * 断言策略（计划里的方案 A）：聚合断言直接调 `toolsOfAsset`（最小 deps，注入**真实**原生注册表
 * ——空注册表会让"错走 native 分支"也返回空集合，断言就失去鉴别力）；真执行走 buildApp + MCP。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
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
import { CredentialService } from './services/credentials.js';
import { InstancePool } from './services/instancePool.js';
import { makeNativeDispatchServices } from './services/nativeDispatch.js';
import { McpEndpoint } from './services/mcpEndpoint.js';
import { toolsOfAsset, type AggregationDeps } from './services/toolAggregation.js';
import { CliRunner, CliConfigError } from './services/cliRunner.js';
import { createApiKey } from './services/apiKey.js';
import { createAuth, ensureAuthTables, type Auth } from './services/auth.js';
import { loadNativeTools } from './native/tools/index.js';
import { registerConnector } from './native/connectors/index.js';
import { dispatchNativeTool, type DispatchServices } from './framework/dispatch.js';
import { auditTableName } from './db/audit.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let settings: Settings;
let pool: InstancePool;
let nativeRegistry: Awaited<ReturnType<typeof loadNativeTools>>;
let aggregationDeps: AggregationDeps;
let adminKey: string;
let adminId: string;
let mcp: McpEndpoint;
let dispatch: DispatchServices;
let auth: Auth;
let isVisible: (
  asset: { ownerId: string | null; visibility: string },
  principal: { userId: string; isAdmin: boolean },
) => boolean;
let dataDir: string;
let auditService: AuditService;
/** 执行器与凭证服务提到模块作用域：AC-87/88/89 的行为断言要读 stats 与写直填值 */
let cliRunner: CliRunner;
let credentialsSv: CredentialService;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 't4-key-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  auditService = audit;
  const credentials = new CredentialService(sqlite, cryptoKey);
  credentialsSv = credentials;
  pool = new InstancePool({
    globalBudget: 4, globalWeightBudget: 12, maxPerAsset: 2, queuePerUser: 4, globalConcurrency: 2,
    idleTtlMs: 60_000, queueTimeoutMs: 10_000, degradeWaitMs: 3_000, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 't4-rt-')),
  });
  const dispatchServices = makeNativeDispatchServices({ sqlite, db, settings, audit, credentials });
  dispatch = dispatchServices;
  nativeRegistry = await loadNativeTools();

  dataDir = mkdtempSync(path.join(tmpdir(), 't4-data-'));
  cliRunner = new CliRunner({
    dataDir,
    runtimeCredsDir: path.join(dataDir, 'rt'),
    baseEnv: { PATH: process.env.PATH ?? '' },
    outputTruncateBytes: () => 4096,
    commandTimeoutMs: () => 5000,
    sandboxEnabled: () => false,
  });
  isVisible = (
    asset: { ownerId: string | null; visibility: string },
    principal: { userId: string; isAdmin: boolean },
  ) => principal.isAdmin || asset.ownerId === principal.userId || asset.visibility === 'public';

  mcp = new McpEndpoint({
    db, sqlite, settings, pool, dispatchServices, audit, nativeRegistry,
    runtimeCredsDir: path.join(dataDir, 'rt'), isVisible, cliRunner,
  });

  aggregationDeps = {
    db,
    settings,
    pool,
    nativeRegistry,
    isVisible,
    runtimeCredsDir: path.join(dataDir, 'rt'),
    resolveSlots: () => [],
    resolveRef: () => '',
  };

  await db.insert(schema.users).values({ id: 'u-admin', username: 'admin', name: 'admin', isAdmin: true }).run();
  adminId = 'u-admin';

  auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  app = await buildApp({ db, auth, baseUrl: BASE_URL, instancePool: pool, mcp });
  adminKey = (await createApiKey(db, adminId, 't4-cli')).plainKey;
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
    clientInfo: { name: 't4-cli', version: '1' },
  }));
  expect(res.statusCode).toBe(200);
  const sc = res.headers['mcp-session-id'];
  return (Array.isArray(sc) ? sc[0] : sc) as string;
}

/** 取 tools/call 结果里的 text 载荷 */
function textOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
}

async function callTool(sessionId: string, name: string, args: Record<string, unknown>) {
  return await postMcp(rpc('tools/call', { name, arguments: args }), sessionId);
}

describe('分支顺序：cli 先于 native（越权防护）', { timeout: 20_000 }, () => {
  it('方案 A：redis 品类 CLI 资产的工具集恰为 [redis_run]（走错 native 分支会拿到 redis_command）', async () => {
    const id = await mkAsset({ name: 'cli-redis', category: 'redis', command: 'redis-cli' });
    const { tools } = await toolsOfAsset(aggregationDeps, id, { userId: adminId, isAdmin: true });
    expect(tools.map((t) => t.name)).toEqual(['redis_run']);
    // schema 由聚合层注入 asset（框架参数，不属于 CLI argv）
    expect(tools[0]!.inputSchema.required).toEqual(['argv', 'asset']);
    // 描述必须满足 R4/R6，否则工具会在 aggregateTools 的 fail-safe 阶段被剔除
    expect(tools[0]!.description).toContain('Use when:');
    expect(tools[0]!.description.length).toBeLessThanOrEqual(200);
  });

  it('对照组：redis 品类 native 资产仍走原生工具集（cli 分支没有吞掉 native）', async () => {
    const id = await mkAsset({ name: 'native-redis', category: 'redis', executionMode: 'native' });
    const { tools } = await toolsOfAsset(aggregationDeps, id, { userId: adminId, isAdmin: true });
    const names = tools.map((t) => t.name);
    expect(names).toContain('redis_command');
    expect(names).not.toContain('redis_run');
  });

  it('opsgate_list_asset_tools 与直接聚合同口径：只有 redis_run', async () => {
    const id = await mkAsset({ name: 'cli-redis-e2e', category: 'redis', command: 'redis-cli' });
    const sid = await initialize();
    const payload = JSON.parse(textOf(await callTool(sid, 'opsgate_list_asset_tools', { asset: id }))) as {
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
    };
    expect(payload.tools.map((t) => t.name)).toEqual(['redis_run']);
    // 元工具层去掉 asset（已提到外层），只留 argv
    expect(Object.keys(payload.tools[0]!.inputSchema.properties ?? {})).toEqual(['argv']);
  });

  it('opsgate_list_assets 的资产项带 executionMode（cli 可被发现链路识别）', async () => {
    const id = await mkAsset({ name: 'cli-list', category: 'k8s', command: 'kubectl' });
    const sid = await initialize();
    const listed = JSON.parse(textOf(await callTool(sid, 'opsgate_list_assets', {}))) as Array<{
      id: string;
      executionMode: string;
    }>;
    expect(listed.find((a) => a.id === id)!.executionMode).toBe('cli');
  });
});

describe('调用分发：cli 分支真执行与拒绝路径', { timeout: 30_000 }, () => {
  it('redis_run 经 opsgate_invoke 走 CliRunner 返回真实 stdout', async () => {
    const id = await mkAsset({ name: 'cli-exec', category: 'redis', command: process.execPath });
    const sid = await initialize();
    const res = await callTool(sid, 'opsgate_invoke', {
      asset: id,
      tool: 'redis_run',
      args: { argv: ['-e', 'process.stdout.write("cli-ok")'] },
    });
    const text = textOf(res);
    // 错误路径的载荷统一是 "[<code>] ..."；成功载荷是 JSON
    expect(text.startsWith('[')).toBe(false);
    expect(text).toContain('cli-ok');
    // exitCode 0 原样回传（不把非零/超时伪装成成功）
    expect(text).toContain('"exitCode":0');
  });

  it('cli 资产上调用原生 redis_command → -32601（工具名不属于该资产）', async () => {
    const id = await mkAsset({ name: 'cli-nocmd', category: 'redis', command: process.execPath });
    const sid = await initialize();
    const res = await callTool(sid, 'opsgate_invoke', {
      asset: id,
      tool: 'redis_command',
      args: { argv: ['PING'] },
    });
    expect(textOf(res)).toContain('-32601');
  });

  it('argv 缺失 / 空数组 / 含非字符串 → -32602（不经 shell，也不猜）', async () => {
    const id = await mkAsset({ name: 'cli-badargv', category: 'redis', command: process.execPath });
    const sid = await initialize();
    for (const argv of [undefined, [], ['-e', 1]]) {
      const res = await callTool(sid, 'opsgate_invoke', { asset: id, tool: 'redis_run', args: { argv } });
      expect(textOf(res)).toContain('-32602');
    }
  });

  it('非零退出码原样返回（stderr 与 exitCode 都交给调用方判断）', async () => {
    const id = await mkAsset({ name: 'cli-exit3', category: 'redis', command: process.execPath });
    const sid = await initialize();
    const res = await callTool(sid, 'opsgate_invoke', {
      asset: id,
      tool: 'redis_run',
      args: { argv: ['-e', 'process.stderr.write("boom");process.exit(3)'] },
    });
    const text = textOf(res);
    expect(text).toContain('boom');
    expect(text).toContain('"exitCode":3');
  });
});

/** 该资产在当月审计表里的记录（表可能尚未建立 → 空集，不伪造） */
function auditRowsFor(assetId: string): Array<{ tool: string | null; status: string | null }> {
  const table = auditTableName();
  const exists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return [];
  return sqlite.prepare(`SELECT tool, status FROM ${table} WHERE server_id = ?`).all(assetId) as Array<{
    tool: string | null;
    status: string | null;
  }>;
}

/** 该资产在当月审计表里的完整记录（AC-88 要读 input_summary / risk / error_message） */
function auditFullRowsFor(assetId: string): Array<{
  tool: string | null;
  status: string | null;
  risk: string | null;
  input_summary: string | null;
  output_summary: string | null;
  error_message: string | null;
}> {
  const table = auditTableName();
  const exists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return [];
  return sqlite
    .prepare(`SELECT tool, status, risk, input_summary, output_summary, error_message FROM ${table} WHERE server_id = ?`)
    .all(assetId) as Array<{
      tool: string | null;
      status: string | null;
      risk: string | null;
      input_summary: string | null;
      output_summary: string | null;
      error_message: string | null;
    }>;
}

/**
 * 临时把 `process.platform` 伪装成指定值（用例结束还原）。
 *
 * 用途：`isSandboxAvailable()` 对非 Linux 直接返回 false，不 spawn bwrap。
 * 平台判定是生产事实，测试不改生产代码去迁就开发机（与 cli-create.integration.test.ts 同做法）。
 */
async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** runtime-creds 下现存 run 目录数（目录可能尚未创建 → 0，不代表任何执行状态） */
function countRunDirs(): number {
  const dir = path.join(dataDir, 'rt');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).length;
}

/**
 * C-1 回归（审查发现）：CLI 资产不得经同品类原生工具执行。
 *
 * 这是**执行路径**级别的收口，与发现阶段（tools/list 过滤、opsgate_invoke 白名单）互不替代：
 * 直调 `dispatchNativeTool` 就等于绕开了所有发现阶段的过滤，因此断言必须落在这一层。
 * 用一个会记录调用的假 redis connector 证明"若闸门失效，execute 真的会跑"。
 */
describe('C-1：原生 dispatch 挡住 CLI 资产（越权回归）', { timeout: 20_000 }, () => {
  it('直接 dispatchNativeTool(redis.command) 指向 cli 资产 → -32006，connector 未 acquire、审计无记录', async () => {
    const id = await mkAsset({ name: 'cli-redis-crossmode', category: 'redis', command: 'redis-cli' });
    const def = nativeRegistry.find((t) => t.id === 'redis.command');
    expect(def).toBeTruthy();

    // 假 connector：若闸门缺失，acquire + command 都会被执行
    const calls = { acquire: 0, command: 0, release: 0 };
    registerConnector({
      type: 'redis',
      acquire: async () => {
        calls.acquire++;
        return { command: async () => { calls.command++; return 'PONG'; } };
      },
      release: () => { calls.release++; },
      invalidate: () => undefined,
      stats: () => ({ active: 0, idle: 0, total: 0 }),
    });

    const out = await dispatchNativeTool(
      def!,
      { asset: id, command: 'PING' },
      { userId: adminId, isAdmin: true },
      dispatch,
    );

    expect(out.ok).toBe(false);
    expect(out.code).toBe(-32006);
    expect(out.message).toContain('不支持本工具族调用');
    // 越权面证据：连接没建立、命令没发、审计也没留下"看起来成功"的记录
    expect(calls).toEqual({ acquire: 0, command: 0, release: 0 });
    expect(auditRowsFor(id)).toEqual([]);
  });

  it('对照：同品类 native 资产仍可经原生 dispatch 正常执行（闸门只拦 cli）', async () => {
    const id = await mkAsset({ name: 'native-redis-crossmode', category: 'redis', executionMode: 'native' });
    const def = nativeRegistry.find((t) => t.id === 'redis.command');
    const calls = { command: 0 };
    registerConnector({
      type: 'redis',
      acquire: async () => ({ command: async () => { calls.command++; return 'PONG'; } }),
      release: () => undefined,
      invalidate: () => undefined,
      stats: () => ({ active: 0, idle: 0, total: 0 }),
    });

    const out = await dispatchNativeTool(
      def!,
      { asset: id, command: 'PING' },
      { userId: adminId, isAdmin: true },
      dispatch,
    );
    expect(out.ok).toBe(true);
    expect(calls.command).toBe(1);
    expect(auditRowsFor(id).some((r) => r.status === 'success')).toBe(true);
  });

  it('resolveAsset 不再把 cli 归一成 native（闸门的判据来源）', async () => {
    const id = await mkAsset({ name: 'cli-resolve-mode', category: 'k8s', command: 'kubectl' });
    const view = await dispatch.resolveAsset(id, { userId: adminId, isAdmin: true });
    expect(view?.executionMode).toBe('cli');
  });
});

describe('I-1：cliRunner 未装配 → 显式失败且不退回 native/derived', { timeout: 20_000 }, () => {
  it('未传 cliRunner 时 opsgate_invoke 调 k8s_run → 500，且无任何原生/派生审计记录', async () => {
    const id = await mkAsset({ name: 'cli-no-runner', category: 'k8s', command: 'kubectl' });
    const mcpNoRunner = new McpEndpoint({
      db, sqlite, settings, pool, dispatchServices: dispatch, audit: auditService, nativeRegistry,
      runtimeCredsDir: path.join(dataDir, 'rt'), isVisible,
    });
    const appNoRunner = await buildApp({ db, auth, baseUrl: BASE_URL, instancePool: pool, mcp: mcpNoRunner });
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
          clientInfo: { name: 't4-cli-norunner', version: '1' },
        })),
      });
      expect(res.statusCode).toBe(200);
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
        payload: JSON.stringify(rpc('tools/call', {
          name: 'opsgate_invoke',
          arguments: { asset: id, tool: 'k8s_run', args: { argv: ['get', 'pods'] } },
        })),
      });
      const text = textOf(call);
      expect(text).toContain('[500]');
      expect(text).toContain('CLI 执行器未启用');
      // 关键：没有落到 native / derived 分支（否则会留下 tool_call 审计，或直接执行成功）
      expect(text.startsWith('[')).toBe(true);
      const rows = auditRowsFor(id);
      expect(rows.filter((r) => r.status === 'success')).toEqual([]);
      expect(rows.filter((r) => (r.tool ?? '').startsWith('native:') || (r.tool ?? '').startsWith('derived:'))).toEqual([]);
    } finally {
      await appNoRunner.close();
    }
  });
});

describe('I-2：CLI 资产缺 command → 不冒协议级 -32603', { timeout: 20_000 }, () => {  it('toolsOfAsset 把 cliExposedTool 的抛错收成 violations，不向上抛', async () => {
    const id = await mkAsset({ name: 'cli-no-command', category: 'k8s', command: null });
    const { tools, violations } = await toolsOfAsset(aggregationDeps, id, { userId: adminId, isAdmin: true });
    expect(tools).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`cli:${id}:`);
    expect(violations[0]).toContain('未配置二进制');
  });

  it('opsgate_list_asset_tools 返回 -32006 + 原因（不是 -32603 协议错误）', async () => {
    const id = await mkAsset({ name: 'cli-no-command-e2e', category: 'k8s', command: null });
    const sid = await initialize();
    const res = await callTool(sid, 'opsgate_list_asset_tools', { asset: id });
    const text = textOf(res);
    expect(text).toContain('[-32006]');
    expect(text).toContain('未配置二进制');
    expect(text).not.toContain('-32603');
  });

  it('opsgate_invoke 调 k8s_run 时同样是可读的 -32601（工具集为空），不是 -32603', async () => {
    const id = await mkAsset({ name: 'cli-no-command-invoke', category: 'k8s', command: null });
    const sid = await initialize();
    const res = await callTool(sid, 'opsgate_invoke', {
      asset: id,
      tool: 'k8s_run',
      args: { argv: ['get', 'pods'] },
    });
    const text = textOf(res);
    expect(text).toContain('[-32601]');
    expect(text).not.toContain('-32603');
  });
});


/**
 * AC-87 / AC-88 / AC-89 的**行为断言**（此前只有静态/单元覆盖）：
 * 这些验收项描述的是"执行路径上发生了什么"，只能经 /mcp 真调用 + 查审计/SQLite 证明。
 *
 * 三条用例都不依赖真实 bwrap（Windows 开发机也能跑）：
 *  - AC-87 用 `sandboxEnabled: () => true` + 非 Linux 平台伪装，让 `isSandboxAvailable()` 直接 false；
 *  - AC-88 的 block 规则是本文件临时插的一条（migrate 不播内置规则）；
 *  - AC-89 的成功用例用 `process.execPath` 跑 node，跨平台。
 */
describe('AC-87：沙箱要求启用但不可用 → 拒绝执行且不 spawn', { timeout: 30_000 }, () => {
  it('exec 抛配置类错误、stats().active 为 0、runtime-creds 无残留目录', async () => {
    const sandboxRunner = new CliRunner({
      dataDir,
      runtimeCredsDir: path.join(dataDir, 'rt'),
      baseEnv: { PATH: process.env.PATH ?? '' },
      outputTruncateBytes: () => 4096,
      commandTimeoutMs: () => 5000,
      // 「要求沙箱」：与 server.ts 生产装配同一份取值，可用性由平台判定
      sandboxEnabled: () => true,
    });
    const mcpSandbox = new McpEndpoint({
      db, sqlite, settings, pool, dispatchServices: dispatch, audit: auditService, nativeRegistry,
      runtimeCredsDir: path.join(dataDir, 'rt'), isVisible, cliRunner: sandboxRunner,
    });
    const appSandbox = await buildApp({ db, auth, baseUrl: BASE_URL, instancePool: pool, mcp: mcpSandbox });
    try {
      const id = await mkAsset({ name: 'cli-sandbox-required', category: 'k8s', command: process.execPath });
      const init = await appSandbox.inject({
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
          clientInfo: { name: 't4-cli-sandbox', version: '1' },
        })),
      });
      const rawSid = init.headers['mcp-session-id'];
      const sid = (Array.isArray(rawSid) ? rawSid[0] : rawSid) as string;

      const credsDirBefore = countRunDirs();
      const totalBefore = sandboxRunner.stats().total;
      // 非 Linux → isSandboxAvailable() 直接 false，不 spawn bwrap（开发机无需装 bwrap）
      const call = await withPlatform('win32', async () => await appSandbox.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sid,
        },
        payload: JSON.stringify(rpc('tools/call', {
          name: 'opsgate_invoke',
          arguments: { asset: id, tool: 'k8s_run', args: { argv: ['get', 'pods'] } },
        })),
      }));
      const text = textOf(call);
      // 错误必须是可读的 CLI 配置错误，而不是"看起来成功了"
      expect(text.startsWith('[')).toBe(true);
      expect(text).toContain('bwrap');
      expect(text).toContain('不可重试');
      // 关键：不能落进 -32002（"实例忙，缩小范围重试"）——那会让 agent 死循环重试
      expect(text).toContain('[-32008]');
      expect(text).not.toContain('-32002');
      // 未启动进程 + 未留下任何运行期凭证目录（fail-closed 且零污染）
      expect(sandboxRunner.stats().active).toBe(0);
      expect(sandboxRunner.stats().total).toBe(totalBefore);
      expect(countRunDirs()).toBe(credsDirBefore);
    } finally {
      await appSandbox.close();
    }
  });

  it('normalizeError：CliConfigError → -32008，普通错误仍 -32002（共享映射不外溢）', () => {
    // CLI 配置类错误（bwrap 缺失 / command 缺失 / 槽位未绑定 / 槽位名非法）是永久错误
    const cfg = dispatch.normalizeError(new CliConfigError('bwrap 不可用'));
    expect(cfg.code).toBe(-32008);
    expect(cfg.message).toContain('不可重试');
    expect(cfg.message).toContain('bwrap');
    // 回归：其它 -32002 路径（瞬时忙/超时/未知错误）语义不变
    const busy = dispatch.normalizeError(new Error('实例池排队超时'));
    expect(busy.code).toBe(-32002);
    const notCli = dispatch.normalizeError('plain string failure');
    expect(notCli.code).toBe(-32002);
  });
});

describe('AC-88：argv 命中 kind=block 规则 → -32004 且不 spawn', { timeout: 30_000 }, () => {
  it('opsgate_invoke 返回 -32004，runner 的 total 计数不增（进程没起）', async () => {
    // 临时规则：与本文件其它用例互不影响（id 唯一，用例末清理）
    const ruleId = 'gr-test-block-metadata';
    sqlite
      .prepare(
        `INSERT INTO guard_rules (id, name, kind, target, pattern, enabled, priority, locked, builtin, source, scope)
         VALUES (?, ?, 'block', 'arg', ?, 1, 5000, 0, 0, 'admin', 'global')`,
      )
      .run(ruleId, '测试：云元数据地址', '169\\.254\\.169\\.254');
    try {
      const id = await mkAsset({ name: 'cli-block-argv', category: 'k8s', command: process.execPath });
      const sid = await initialize();
      const totalBefore = cliRunner.stats().total;
      const res = await callTool(sid, 'opsgate_invoke', {
        asset: id,
        tool: 'k8s_run',
        // argv 逐元素进 arg 维度：第二元素就是元数据地址
        args: { argv: ['--server', 'http://169.254.169.254/latest/meta-data/'] },
      });
      const text = textOf(res);
      expect(text).toContain('[-32004]');
      expect(text).toContain('云元数据地址');
      // 关键：进程没起（total 是 CliRunner 里"本人 spawn 计数"，不增即证明未执行）
      expect(cliRunner.stats().total).toBe(totalBefore);
      expect(cliRunner.stats().active).toBe(0);
      // 审计留下 blocked 记录（拒绝要可追溯，但不得是 success）
      const rows = auditFullRowsFor(id);
      expect(rows.some((r) => r.status === 'blocked')).toBe(true);
      expect(rows.filter((r) => r.status === 'success')).toEqual([]);
    } finally {
      sqlite.prepare('DELETE FROM guard_rules WHERE id = ?').run(ruleId);
    }
  });
});

describe('AC-89：成功调用的审计形状与凭证不外泄', { timeout: 30_000 }, () => {
  it('审计 tool 以 cli: 开头、input_summary 含 argv、且不含注入的凭证值', async () => {
    const fakeToken = 'tok-cli-audit-7f3a91';
    const id = await mkAsset({
      name: 'cli-audit-shape',
      category: 'other',
      command: process.execPath,
      // env 模板把槽位渲染进子进程环境（凭证只经 env，不进 argv）
      env: { DEMO_TOKEN: '${DEMO_TOKEN}' } as never,
      credentialSlots: [{ target: 'env', name: 'DEMO_TOKEN', label: '演示 Token', file: false }] as never,
    });
    // 直填值走凭证服务加密落库：与创建路径的 inlineValues 同一条写入
    credentialsSv.setSlotValue(id, 'DEMO_TOKEN', fakeToken, adminId);

    const sid = await initialize();
    const res = await callTool(sid, 'opsgate_invoke', {
      asset: id,
      tool: 'other_run',
      args: { argv: ['-e', 'process.stdout.write("argv-ok:" + (process.env.DEMO_TOKEN === "x" ? "x" : "set"))'] },
    });
    const text = textOf(res);
    expect(text).not.toMatch(/^\[/);
    expect(text).toContain('argv-ok:set');

    const rows = auditFullRowsFor(id);
    expect(rows.length).toBeGreaterThan(0);
    const success = rows.filter((r) => r.status === 'success');
    expect(success).toHaveLength(1);
    const row = success[0]!;
    // 规则名带 cli:<assetId>: 前缀（与 native:/derived: 区分，便于按执行方式聚合）
    expect(row.tool).toBe(`cli:${id}:other_run`);
    // argv 全文进审计（无凭证在 argv 里，故无需额外脱敏）
    expect(row.input_summary).toContain('argv-ok');
    expect(row.input_summary).toContain('"argv"');
    // 凭证值不得出现在审计任何字段里（入参摘要 / 输出摘要 / 错误信息）
    for (const field of [row.input_summary, row.output_summary, row.error_message]) {
      expect(field ?? '').not.toContain(fakeToken);
    }
  });
});
