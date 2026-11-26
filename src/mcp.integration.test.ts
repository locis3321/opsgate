/**
 * T7 MCP 入口集成测试：真实 Fastify + Streamable HTTP transport + mock stdio 派生资产。
 * 覆盖：initialize instructions / tools/list 聚合（发现工具第一位、工具数与资产数无关）/
 * 权限裁剪（AC-34）/ ?group=_all 400（AC-36）/ session 越权 403（AC-8）/ asset -32006（AC-35）/
 * 无元工具（AC-36）/ ?tag= 收窄。
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
import { CredentialService } from './services/credentials.js';
import { InstancePool } from './services/instancePool.js';
import { makeNativeDispatchServices } from './services/nativeDispatch.js';
import { McpEndpoint } from './services/mcpEndpoint.js';
import { createAuth, ensureAuthTables } from './services/auth.js';
import { createApiKey } from './services/apiKey.js';
import { loadNativeTools } from './native/tools/index.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/mock-mcp-server.mjs', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

interface Ctx {
  app: FastifyInstance;
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  adminKey: string;
  memberKey: string;
  mcp: McpEndpoint;
  settings: Settings;
}

let ctx: Ctx;

beforeAll(async () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const key = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-key-')), 'k'));
  const audit = new AuditService(sqlite);
  const credentials = new CredentialService(sqlite, key);
  const pool = new InstancePool({
    globalBudget: 8,
    globalWeightBudget: 24,
    maxPerAsset: 2,
    queuePerUser: 8,
    globalConcurrency: 4,
    idleTtlMs: 60_000,
    queueTimeoutMs: 15_000,
    degradeWaitMs: 3_000,
    prewarmConcurrency: 2,
    prewarmBackoffMs: 600_000,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-rt-')),
  });
  const dispatch = makeNativeDispatchServices({ sqlite, db, settings, audit, credentials });
  const nativeRegistry = await loadNativeTools();
  const isVisible = (
    asset: { ownerId: string; visibility: string },
    principal: { userId: string; isAdmin: boolean },
  ) => principal.isAdmin || asset.ownerId === principal.userId || asset.visibility === 'public';

  // 数据：admin / member + 3 个 mock mcp 资产（other 品类）
  await db
    .insert(schema.users)
    .values([
      { id: 'u-admin', username: 'admin', name: 'admin', isAdmin: true },
      { id: 'u-member', username: 'member', name: 'member', isAdmin: false },
    ])
    .run();
  await db
    .insert(schema.servers)
    .values([
      {
        id: 'mock-1', name: 'mock-1', type: 'stdio', executionMode: 'mcp', category: 'other',
        command: process.execPath, args: [FIXTURE], ownerId: 'u-admin', visibility: 'owner', configHash: 'c1',
      },
      {
        id: 'mock-2', name: 'mock-2', type: 'stdio', executionMode: 'mcp', category: 'other',
        command: process.execPath, args: [FIXTURE], ownerId: 'u-admin', visibility: 'public', configHash: 'c2',
        tags: ['prod'],
      },
      {
        id: 'mock-3', name: 'mock-3', type: 'stdio', executionMode: 'mcp', category: 'other',
        command: process.execPath, args: [FIXTURE], ownerId: 'u-member', visibility: 'owner', configHash: 'c3',
      },
    ])
    .run();

  const mcp = new McpEndpoint({
    db,
    sqlite,
    settings,
    pool,
    dispatchServices: dispatch,
    audit,
    nativeRegistry,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-creds-')),
    isVisible,
  });

  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  const app = await buildApp({ db, auth, baseUrl: BASE_URL, instancePool: pool, mcp });

  const adminKey = (await createApiKey(db, 'u-admin', 't7-admin')).plainKey;
  const memberKey = (await createApiKey(db, 'u-member', 't7-member')).plainKey;
  ctx = { app, db, sqlite, adminKey, memberKey, mcp, settings };
}, 60_000);

afterAll(async () => {
  await ctx.app.close();
  ctx.sqlite.close();
});

function rpc(method: string, params: unknown, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function postMcp(key: string, body: unknown, sessionId?: string, qs = '') {
  return await ctx.app.inject({
    method: 'POST',
    url: `/mcp${qs}`,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    payload: JSON.stringify(body),
  });
}

async function initialize(key: string, qs = ''): Promise<{ sessionId: string; result: Record<string, unknown> }> {
  const res = await postMcp(key, rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't7-test', version: '1' },
  }), undefined, qs);
  expect(res.statusCode).toBe(200);
  const json = (JSON.parse(res.body) as Record<string, unknown>);
  expect(json.id).toBe(1);
  const sc = res.headers['mcp-session-id'];
  if (!sc) console.log('DEBUG-NO-SESSION-ID; headers=', JSON.stringify(res.headers));
  const sessionId = (Array.isArray(sc) ? sc[0] : sc) as string;
  return { sessionId, result: (json.result ?? {}) as Record<string, unknown> };
}

describe('T7 MCP 入口（§5.5）', { timeout: 20_000 }, () => {
  it('AC-33/34 initialize：instructions 动态生成并按权限裁剪', async () => {
    const admin = await initialize(ctx.adminKey, '?category=other');
    const member = await initialize(ctx.memberKey, '?category=other');
    expect(String(admin.result.instructions ?? '')).toContain('other');
    expect(String(member.result.instructions ?? '')).toContain('other');
    // admin 可见全部 3 台（isAdmin 短路）；member 仅 mock-2(public)+mock-3(自有) 2 台（AC-34：互不泄露）
    expect(String(admin.result.instructions ?? '')).toContain('3 台');
    expect(String(member.result.instructions ?? '')).toContain('2 台');
    expect(String(member.result.instructions ?? '')).not.toContain('mock-1');
  });

  it('tools/list：发现工具永远第一位（AC-30），无元工具（AC-36），工具数与资产数无关（AC-29）', async () => {
    const { sessionId } = await initialize(ctx.adminKey, '?category=other');
    const res = await postMcp(ctx.adminKey, rpc('tools/list', {}), sessionId);
    const list = (JSON.parse(res.body) as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(list[0]!.name).toBe('opsgate_list_assets');
    expect(list.map((t: { name: string }) => t.name)).not.toContain('opsgate_call');
    const count = list.length;
    // 增加第三个同品类同实现资产 → 工具数不变
    await ctx.db
      .insert(schema.servers)
      .values({
        id: 'mock-4', name: 'mock-4', type: 'stdio', executionMode: 'mcp', category: 'other',
        command: process.execPath, args: [FIXTURE],
        ownerId: 'u-admin', visibility: 'owner', configHash: 'c4',
      })
      .run();
    const res2 = await postMcp(ctx.adminKey, rpc('tools/list', {}), sessionId);
    const list2 = (JSON.parse(res2.body) as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(list2.length).toBe(count);
    expect(list2.map((t) => t.name)).toContain('other_echo');
  });

  it('AC-36 ?group=_all → 400', async () => {
    const res = await postMcp(ctx.adminKey, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }), undefined, '?group=_all');
    expect(res.statusCode).toBe(400);
  });

  it('AC-8 跨用户 sessionId → 403', async () => {
    const admin = await initialize(ctx.adminKey, '?category=other');
    // member 携带 admin 的 sessionId
    const res = await postMcp(ctx.memberKey, rpc('tools/list', {}), admin.sessionId, '?category=other');
    expect(res.statusCode).toBe(403);
  });

  it('AC-34/35 发现工具按权限裁剪；asset 填错 → -32006', async () => {
    const { sessionId } = await initialize(ctx.memberKey, '?category=other');
    const listed = await postMcp(ctx.memberKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: {} }), sessionId);
    const text = (JSON.parse(listed.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    const assets = JSON.parse(text) as Array<{ id: string; name: string }>;
    expect(assets.map((a) => a.name).sort()).toEqual(['mock-2', 'mock-3']);

    const ghost = await postMcp(ctx.memberKey, rpc('tools/call', { name: 'other_echo', arguments: { asset: 'ghost', message: 'x' } }), sessionId);
    expect(ghost.body).toContain('-32006');
  });

  it('AC-29/30 品类聚合：?category= 只暴露该品类的工具（ADR-032 起品类来自实际数据）', async () => {
    // ADR-032：品类白名单改为动态（servers.category ∪ market.categories），本夹具只有 other 品类，
    // 原生 host 工具随 host 资产一起由「真实数据」决定，不再由硬编码清单决定。
    const { sessionId } = await initialize(ctx.adminKey, '?category=other');
    const list = await postMcp(ctx.adminKey, rpc('tools/list', {}), sessionId);
    const names = (JSON.parse(list.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names[0]).toBe('opsgate_list_assets');
    expect(names).toContain('other_echo');
    // 原生 host 工具不在 other 品类视图里
    expect(names).not.toContain('host_execute_command');
  });

  it('ADR-032 D3：不存在于任何资产的品类 → 400 且列出实际存在的品类', async () => {
    const res = await postMcp(ctx.adminKey, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }), undefined, '?category=elasticsearch');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('elasticsearch');
    expect(res.body).toContain('other');
  });

  it('?tag= 收窄：只有带 prod tag 的资产进入派生遍历', async () => {
    const { sessionId } = await initialize(ctx.adminKey, '?category=other&tag=prod');
    const listed = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: {} }), sessionId, '?category=other&tag=prod');
    const text = (JSON.parse(listed.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    const assets = JSON.parse(text) as Array<{ id: string }>;
    expect(assets.map((a) => a.id)).toEqual(['mock-2']);
  });

  it('preview：返回工具清单/instructions/计数（R1-R8 违规在 violations）', async () => {
    const preview = await ctx.mcp.preview({ group: 'all', category: 'other', principal: { userId: 'u-admin', isAdmin: true } });
    expect(preview.tools[0]!.name).toBe('opsgate_list_assets');
    expect(preview.tools.some((t) => t.name === 'other_echo')).toBe(true);
    expect(preview.count).toBeGreaterThan(1);
    expect(preview.instructions).toContain('other');
    expect(preview.violations).toBeInstanceOf(Array);
    expect(preview.assetCount).toBeGreaterThanOrEqual(2);
  });

  it('AC-36f：mcp.instructions 为空 → 回退内置骨架；非空 → 用设置文本替换骨架', async () => {
    const baseline = await initialize(ctx.adminKey, '?group=all');
    const builtin = String(baseline.result.instructions ?? '');
    expect(builtin).toContain('工作流（必须遵守）');
    expect(builtin).toContain('先 opsgate_list_assets 确认目标资产');
    expect(builtin).not.toContain('管理员补充说明');

    ctx.settings.setCache('mcp.instructions', '## 自定义约定\n- 一切变更先开变更单');
    const custom = String((await initialize(ctx.adminKey, '?group=all')).result.instructions ?? '');
    expect(custom).toContain('一切变更先开变更单');
    // 骨架被替换（不是追加）：内置第 1 条不再出现
    expect(custom).not.toContain('先 opsgate_list_assets 确认目标资产');
    // 动态头仍在（事实信息不可被设置项移除）
    expect(custom).toContain('全部可见资产');
    expect(custom).toContain('本连接共暴露');

    // 留空 = 回退默认（与从未设置一致）
    ctx.settings.setCache('mcp.instructions', '   ');
    const empty = String((await initialize(ctx.adminKey, '?group=all')).result.instructions ?? '');
    expect(empty).toBe(builtin);
  });

  it('preview 与 initialize 的 instructions 完全一致（管理员改完要能对上）', async () => {
    ctx.settings.setCache('mcp.instructions', '## 对齐验证\n- 预览即所见');
    const init = String((await initialize(ctx.adminKey, '?group=all')).result.instructions ?? '');
    const preview = await ctx.mcp.preview({ group: 'all', principal: { userId: 'u-admin', isAdmin: true } });
    expect(preview.instructions).toBe(init);
    ctx.settings.setCache('mcp.instructions', '');
  });

  it('无 Bearer key → 401（AC-7 保持）', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: JSON.stringify(rpc('initialize', {})), headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('单端点 all 模式与探索工具（2026-10-22 用户需求）', { timeout: 20_000 }, () => {
  it('?group=all：跨品类聚合 + 平台工具齐全（list_assets 第一位）', async () => {
    await ctx.db
      .insert(schema.servers)
      .values({
        id: 'mock-mysql', name: 'mock-mysql', type: 'stdio', executionMode: 'mcp', category: 'mysql',
        command: process.execPath, args: [FIXTURE], ownerId: 'u-admin', visibility: 'owner', configHash: 'cm1',
      })
      .run();
    const { sessionId, result } = await initialize(ctx.adminKey, '?group=all');
    expect(String(result.instructions ?? '')).toContain('全部可见资产');
    const res = await postMcp(ctx.adminKey, rpc('tools/list', {}), sessionId);
    const names = (JSON.parse(res.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names[0]).toBe('opsgate_list_assets');
    expect(names).toContain('opsgate_view_asset');
    expect(names).toContain('opsgate_list_groups');
    expect(names).toContain('opsgate_view_group');
    expect(names).toContain('other_echo');
    expect(names).toContain('mysql_echo');
  });

  it('opsgate_view_asset：详情含槽位/分组，不含 env 值；不可见 -32006', async () => {
    await ctx.db.insert(schema.groups).values({ id: 'grp-demo', name: 'demo', description: '演示分组说明（LLM 可见）' }).run();
    await ctx.db.insert(schema.groupServers).values({ groupId: 'grp-demo', serverId: 'mock-2' }).run();
    const { sessionId } = await initialize(ctx.adminKey, '?group=all');
    const call = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_view_asset', arguments: { asset: 'mock-1' } }), sessionId);
    const resJson = JSON.parse(call.body) as { result?: { content: Array<{ text: string }> } };
    const text = resJson.result!.content[0]!.text;
    const detail = JSON.parse(text) as Record<string, unknown>;
    expect(detail.category).toBe('other');
    expect(Array.isArray(detail.envKeys)).toBe(true);
    expect(detail).not.toHaveProperty('env');
    // 权限负例：member 看不到 mock-1（owner=admin，visibility=owner）
    const { sessionId: mSid } = await initialize(ctx.memberKey, '?group=all');
    const deny = await postMcp(ctx.memberKey, rpc('tools/call', { name: 'opsgate_view_asset', arguments: { asset: 'mock-1' } }), mSid);
    expect(JSON.stringify(JSON.parse(deny.body).result ?? '')).toContain('-32006');
  });

  it('opsgate_list_groups / opsgate_view_group：分组说明可见', async () => {
    const { sessionId } = await initialize(ctx.adminKey, '?group=all');
    const lg = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_groups', arguments: {} }), sessionId);
    const lgText = (JSON.parse(lg.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(lgText).toContain('演示分组说明');
    const vg = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_view_group', arguments: { group: 'demo' } }), sessionId);
    const vgJson = JSON.parse(vg.body) as { result: { content: Array<{ text: string }> } };
    expect(vgJson.result.content[0]!.text).toContain('演示分组说明');
    expect(JSON.parse(vgJson.result.content[0]!.text)).toMatchObject({ name: 'demo', memberCount: 0, assetCount: 1 });
  });
});

describe('ADR-030：?group= 按分组实体 / ?category= 按品类', { timeout: 20_000 }, () => {
  it('默认（不传 group）返回全部可见资产，而不是只返回某个品类', async () => {
    const { sessionId, result } = await initialize(ctx.adminKey, '');
    expect(String(result.instructions ?? '')).toContain('全部可见资产');
    const res = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: {} }), sessionId);
    const text = (JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    const assets = JSON.parse(text) as Array<{ name: string; category: string }>;
    // 至少跨两个品类（other + mysql），证明默认不是单品类收窄
    expect(new Set(assets.map((a) => a.category)).size).toBeGreaterThanOrEqual(2);
  });

  it('?group=<分组名> 只返回该分组内的资产（按 group_servers 关联）', async () => {
    await ctx.db.insert(schema.groups).values({ id: 'grp-adr30', name: 'adr30-group', description: 'x' }).run();
    await ctx.db.insert(schema.groupServers).values({ groupId: 'grp-adr30', serverId: 'mock-mysql' }).run();

    const { sessionId } = await initialize(ctx.adminKey, '?group=adr30-group');
    const res = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: {} }), sessionId);
    const assets = JSON.parse((JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as Array<{ name: string }>;
    expect(assets.map((a) => a.name)).toEqual(['mock-mysql']);
  });

  it('?group=<分组 id> 等价于分组名', async () => {
    const { sessionId } = await initialize(ctx.adminKey, '?group=grp-adr30');
    const res = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: {} }), sessionId);
    const assets = JSON.parse((JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as Array<{ name: string }>;
    expect(assets.map((a) => a.name)).toEqual(['mock-mysql']);
  });

  it('?group= 与 ?category= 同时给出取交集', async () => {
    // 组内只有 mysql；再限定 category=other → 空
    const { sessionId } = await initialize(ctx.adminKey, '?group=adr30-group&category=other');
    const res = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: {} }), sessionId);
    const assets = JSON.parse((JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as unknown[];
    expect(assets).toEqual([]);
  });

  it('?category= 单独使用等价于原按品类收窄', async () => {
    const { sessionId } = await initialize(ctx.adminKey, '?category=mysql');
    const res = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: {} }), sessionId);
    const assets = JSON.parse((JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as Array<{ category: string }>;
    expect(assets.every((a) => a.category === 'mysql')).toBe(true);
  });

  it('分组不存在 → 400（不静默返回空）', async () => {
    const res = await postMcp(ctx.adminKey, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }), undefined, '?group=no-such-group');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('不存在');
    expect(res.body).toContain('category');
  });

  it('非法 category → 400（ADR-032：报"品类不存在"并列出实际存在的品类）', async () => {
    const res = await postMcp(ctx.adminKey, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }), undefined, '?category=bogus');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('bogus');
    expect(res.body).toContain('other');
  });
});

describe('ADR-032 单入口 + opsgate_select_scope 分层暴露', { timeout: 30_000 }, () => {
  it('裸 /mcp 初始化只给平台工具（不再派生品类/资产工具）', async () => {
    const { sessionId, result } = await initialize(ctx.adminKey);
    const list = await postMcp(ctx.adminKey, rpc('tools/list', {}), sessionId);
    const names = (JSON.parse(list.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toEqual([
      'opsgate_list_assets',
      'opsgate_view_asset',
      'opsgate_list_groups',
      'opsgate_view_group',
      'opsgate_list_asset_tools',
      'opsgate_invoke',
      'opsgate_select_scope',
    ]);
    expect(names).not.toContain('other_echo');
    // instructions 明确告知发现路径
    expect(String(result.instructions ?? '')).toContain('opsgate_select_scope');
  });

  it('select_scope 替换工具集，并通知客户端重新列工具', async () => {
    const { sessionId } = await initialize(ctx.adminKey);
    const sel = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_select_scope', arguments: { category: 'other' } }), sessionId);
    expect(sel.body).toContain('scope');
    const payload = JSON.parse((JSON.parse(sel.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { tools: number; assets: number };
    // 夹具是共享的（前面的用例会追加同实现资产），这里只断言下限
    expect(payload.assets).toBeGreaterThanOrEqual(3);
    expect(payload.tools).toBeGreaterThan(5);

    const list = await postMcp(ctx.adminKey, rpc('tools/list', {}), sessionId);
    const names = (JSON.parse(list.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toContain('other_echo');
    // 平台工具仍在（select_scope 是替换品类工具，不是替换整个列表）
    expect(names).toContain('opsgate_select_scope');
  });

  it('select_scope 是替换而非累积：切到另一范围后旧工具消失', async () => {
    const { sessionId } = await initialize(ctx.adminKey, '?category=other');
    let names = (JSON.parse((await postMcp(ctx.adminKey, rpc('tools/list', {}), sessionId)).body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toContain('other_echo');
    // 切到 tag=prod（只剩 mock-2），旧品类的工具随之消失
    await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_select_scope', arguments: { category: 'other', tag: 'prod' } }), sessionId);
    names = (JSON.parse((await postMcp(ctx.adminKey, rpc('tools/list', {}), sessionId)).body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    const payload = JSON.parse((JSON.parse((await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: {} }), sessionId)).body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as Array<{ name: string }>;
    expect(payload.map((a) => a.name)).toEqual(['mock-2']);
    // 工具集没有因为上一次 select 而残留两份
    expect(names.filter((n) => n === 'other_echo').length).toBe(1);
  });

  it('select_scope 不带条件 → 报错（防"全部资产"导致工具爆炸）', async () => {
    const { sessionId } = await initialize(ctx.adminKey);
    const res = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_select_scope', arguments: {} }), sessionId);
    expect(res.body).toContain('-32602');
  });

  it('select_scope 不存在的品类 → 报错并列出实际存在的品类', async () => {
    const { sessionId } = await initialize(ctx.adminKey);
    const res = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_select_scope', arguments: { category: 'elasticsearch' } }), sessionId);
    expect(res.body).toContain('-32602');
    expect(res.body).toContain('elasticsearch');
    expect(res.body).toContain('other');
  });

  it('两个会话各自持有工具集：一个 select 不影响另一个（多 agent 隔离）', async () => {
    const a = await initialize(ctx.adminKey);
    const b = await initialize(ctx.adminKey);
    await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_select_scope', arguments: { category: 'other' } }), a.sessionId);
    const namesB = (JSON.parse((await postMcp(ctx.adminKey, rpc('tools/list', {}), b.sessionId)).body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(namesB).not.toContain('other_echo');
    const namesA = (JSON.parse((await postMcp(ctx.adminKey, rpc('tools/list', {}), a.sessionId)).body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(namesA).toContain('other_echo');
  });

  it('成员 select_scope 只覆盖自己可见的资产（越权不变的边界）', async () => {
    const { sessionId } = await initialize(ctx.memberKey);
    const res = await postMcp(ctx.memberKey, rpc('tools/call', { name: 'opsgate_select_scope', arguments: { category: 'other' } }), sessionId);
    const payload = JSON.parse((JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { assets: number };
    // member 只见 mock-2(public) + mock-3(自有)，不见 mock-1
    expect(payload.assets).toBe(2);
  });
});

describe('ADR-033 元工具 opsgate_invoke（不依赖客户端刷新工具目录）', { timeout: 60_000 }, () => {
  const call = (key: string, sessionId: string, name: string, args: Record<string, unknown>) =>
    postMcp(key, rpc('tools/call', { name, arguments: args }), sessionId);

  it('list_asset_tools 返回该资产的工具名与 schema，且 schema 不含 asset 参数', async () => {
    const { sessionId } = await initialize(ctx.adminKey);
    const res = await call(ctx.adminKey, sessionId, 'opsgate_list_asset_tools', { asset: 'mock-1' });
    const payload = JSON.parse((JSON.parse(res.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as {
      asset: { id: string; category: string };
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }>;
    };
    expect(payload.asset.id).toBe('mock-1');
    expect(payload.tools.map((t) => t.name).sort()).toEqual(['boom', 'echo']);
    const echo = payload.tools.find((t) => t.name === 'echo')!;
    expect(Object.keys(echo.inputSchema.properties ?? {})).toEqual(['message']);
    expect(echo.inputSchema.required ?? []).not.toContain('asset');
  });

  it('invoke 走完整链路：规则→审计→实例池→callTool', async () => {
    const { sessionId } = await initialize(ctx.adminKey);
    const res = await call(ctx.adminKey, sessionId, 'opsgate_invoke', {
      asset: 'mock-1',
      tool: 'echo',
      args: { message: 'hello-meta' },
    });
    expect(res.body).toContain('hello-meta');
    expect(res.body).not.toContain('-32002');
  });

  it('invoke 的工具名不属于该资产 → -32601（不开任意透传口）', async () => {
    const { sessionId } = await initialize(ctx.adminKey);
    const res = await call(ctx.adminKey, sessionId, 'opsgate_invoke', {
      asset: 'mock-1',
      tool: 'no_such_tool',
      args: {},
    });
    expect(res.body).toContain('-32601');
    expect(res.body).toContain('opsgate_list_asset_tools');
  });

  it('invoke 不可见资产 → -32006（与不存在同一口径，防探测）', async () => {
    const { sessionId } = await initialize(ctx.memberKey);
    const res = await call(ctx.memberKey, sessionId, 'opsgate_invoke', {
      asset: 'mock-1',
      tool: 'echo',
      args: { message: 'x' },
    });
    expect(res.body).toContain('-32006');
    expect(res.body).not.toContain('mock-1');
  });

  it('invoke 的 args 非对象 → -32602', async () => {
    const { sessionId } = await initialize(ctx.adminKey);
    const res = await call(ctx.adminKey, sessionId, 'opsgate_invoke', {
      asset: 'mock-1',
      tool: 'echo',
      args: 'message=hi',
    });
    expect(res.body).toContain('-32602');
  });

  it('成员自己的资产可通过 invoke 调用（权限按调用者解析）', async () => {
    const { sessionId } = await initialize(ctx.memberKey);
    const res = await call(ctx.memberKey, sessionId, 'opsgate_invoke', {
      asset: 'mock-3',
      tool: 'echo',
      args: { message: 'member-ok' },
    });
    expect(res.body).toContain('member-ok');
  });
});

describe('R1–R8 与社区工具兼容（描述规范化）', { timeout: 60_000 }, () => {
  it('超长描述/无 Use when 的社区工具不会被静默剔除，而是规范化后暴露', async () => {
    // 造一个"社区风格"资产：工具描述必然超 R4/R6（由 mock fixture 的工具描述决定）
    await ctx.db
      .insert(schema.servers)
      .values({
        id: 'mock-longdesc', name: 'mock-longdesc', type: 'stdio', executionMode: 'mcp', category: 'k8s',
        command: process.execPath, args: [FIXTURE], ownerId: 'u-admin', visibility: 'group', configHash: 'cm-longdesc',
      })
      .run();

    const preview = await ctx.mcp.preview({ group: 'all', principal: { userId: 'u-admin', isAdmin: true } });
    // 该资产的派生工具应出现（不被 R4/R6 全剔）
    const names = preview.tools.map((t) => t.name);
    const k8sTools = names.filter((n) => n.startsWith('k8s_'));
    expect(k8sTools.length).toBeGreaterThan(0);

    // 所有暴露工具都要满足 R4（Use when）/R6（≤200）——规范化后不得再违规
    for (const t of preview.tools) {
      if (t.name.startsWith('opsgate_')) continue;
      expect(t.description).toContain('Use when:');
      expect(t.description.length).toBeLessThanOrEqual(200);
    }
    // 不应再出现"描述违规导致剔除"的记录
    const descViolations = preview.violations.filter((v) => v.includes('R4') || v.includes('R6'));
    expect(descViolations).toEqual([]);
  });
});

describe('A1 元工具实时解析（不依赖会话快照）', { timeout: 60_000 }, () => {
  /**
   * 真实缺陷（会话 6e3fb6fa）：会话建立后新建的资产不在 session.aggregate 快照里，
   * list_assets 搜不到、list_asset_tools/invoke 返回 -32006（而 view_asset 查 DB 能读到，两者矛盾），
   * agent 误判为"无权"反复重试。修复：元工具实时查 DB（resolveVisibleAsset），复用 isVisible 不泄露。
   */
  it('会话建立后新建的资产：旧会话 list_assets 能搜到（按 name/displayName），list_asset_tools 能解析', async () => {
    // 1. 先建立会话（此时库里没有新资产）
    const { sessionId } = await initialize(ctx.adminKey, '?group=all');

    // 2. 会话建立后，直接插一个新 cli 资产（模拟"刚建的 kubectl-cli 资产"）
    await ctx.db.insert(schema.servers).values({
      id: 'a1-newassets', name: 'a1-fresh-cli', displayName: 'A1 新建的CLI资产',
      type: 'native', executionMode: 'cli', category: 'other',
      command: 'echo', args: [], env: {}, credentialSlots: [],
      ownerId: 'u-admin', visibility: 'owner', configHash: 'c-a1',
    }).run();

    // 3. 旧会话里 list_assets 按 name 搜 → 必须能搜到（修复前是 []）
    const byName = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_assets', arguments: { search: 'a1-fresh-cli' } }), sessionId);
    const listName = JSON.parse((JSON.parse(byName.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
    expect(listName.map((a: { name: string }) => a.name)).toContain('a1-fresh-cli');
    // 返回含 displayName，便于人对上号
    expect(listName.find((a: { name: string }) => a.name === 'a1-fresh-cli').displayName).toBe('A1 新建的CLI资产');

    // 4. 按 name 直接 list_asset_tools → 必须解析出 other_run（修复前 -32006）
    const toolsRes = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_asset_tools', arguments: { asset: 'a1-fresh-cli' } }), sessionId);
    expect((JSON.parse(toolsRes.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain('other_run');

    // 5. 按 displayName 也能解析（同一 helper）
    const byDisplay = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_asset_tools', arguments: { asset: 'A1 新建的CLI资产' } }), sessionId);
    expect((JSON.parse(byDisplay.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain('other_run');
  });

  it('不存在的资产仍返回 -32006（实时解析不放宽为"任何 ref 都放行"）', async () => {
    const { sessionId } = await initialize(ctx.adminKey, '?group=all');
    const r = await postMcp(ctx.adminKey, rpc('tools/call', { name: 'opsgate_list_asset_tools', arguments: { asset: 'definitely-ghost-asset' } }), sessionId);
    expect((JSON.parse(r.body) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain('-32006');
  });
});
