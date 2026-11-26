/**
 * MCP 入口端点（§5.5 / ADR-021 + 约束 1 session 归属）：
 * - Streamable HTTP（SDK StreamableHTTPServerTransport，Node 适配）；
 * - sessionId = sha256(userId:group)（确定性）：owner 校验 = 客户端回传的 session 必须等于该值 → 越权 403（AC-8）；
 * - initialize.instructions 按连接动态生成（按权限/分组裁剪，零分发-AC-33/34）；
 * - tools/list 来自聚合层（原生+派生+发现工具）；发现工具永远第一位；
 * - tools/call：原生走 dispatchNativeTool（框架链），派生走"解析资产→can/rules→write-ahead→实例池→callTool→回填"；
 * - ?group=_all → 400（AC-36）；无 group 默认 all（跨品类全部可见资产）。
 * - ?group=<category> 按**品类**收窄（历史设计：非分组实体，见 ADR-026 实现态校正）。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as schema from '../db/schema.js';
import { canOnAsset } from './authzBuilder.js';
import type { Settings } from '../config/settings.js';
import type { AssetView, NativeToolDefinition } from '../framework/types.js';
import { dispatchNativeTool, type DispatchServices } from '../framework/dispatch.js';
import { runGuarded } from '../framework/dispatchCore.js';
import type { InstancePool } from './instancePool.js';
import { buildPlan, transportOf } from './instancePlan.js';
import { loadActiveRules, evaluateRules } from './guardRules.js';
import {
  aggregateTools,
  listKnownCategories,
  toolsOfAsset,
  TooManyToolsError,
  type AggregateResult,
  type AggregationDeps,
  type ExposedTool,
} from './toolAggregation.js';
import type { AuditService } from './audit.js';
import type { CliRunner, CliAssetView, CliHealthStatus } from './cliRunner.js';

/**
 * 无 ?group= 时的默认视图 = all（全部可见资产）。
 *
 * 为什么不是 host：早期默认 'host' 会让「没写 group 的客户端」只看到 category=host 的资产，
 * 而这台部署上通常一个都没有 → 表现为"MCP 连上了但资产为空"。默认值必须是
 * "能看到我全部可见资产"，收窄应为调用方显式指定。
 */
const GROUP_DEFAULT = 'all';

export function expectedSessionId(userId: string, group: string): string {
  return createHash('sha256').update(`${userId}:${group}`).digest('hex');
}

type ServerRow = typeof schema.servers.$inferSelect;

/**
 * CLI 段（`opsgate_view_asset` 的 `cli` 字段）：只给变量名不给值。
 *
 * `envNames` 刻意与 `envKeys` 同源只取键：CLI 的 env 模板里可能直接写着明文或 `${SLOT}`
 * 占位，值一旦外泄等于把凭证交给任何能 view 的调用方（AC-9）。
 */
export interface AssetCliSection {
  bin: string | null;
  envNames: string[];
  /**
   * 执行器是否装配（`CliRunner` 是否注入端点）。字段名必须说清这一点：
   * 早先叫 `sandboxEnabled`，但它的值来自"runner 是否存在"，与 bwrap 开关（`CliRunner`
   * 的 `sandboxEnabled()` 设置，恒为要求态）不是一回事——名不副实会让调用方误读成"沙箱已开"。
   * 沙箱事实由 `health === 'sandbox-unavailable'` 表达。
   */
  runnerAttached: boolean;
  /**
   * `unknown` 是探测之外的额外取值（执行器未装配 / 非 CLI 行不该有探测结果），
   * 与 `CliHealthStatus['status']` 分开表达：词表由 cliRunner 单一持有，拼错能被编译拦住。
   */
  health: CliHealthStatus['status'] | 'unknown';
}

/** 由调用方（handler）提供的运行期事实：执行器是否装配、健康探测结果。 */
export interface AssetCliSectionInput {
  runnerAttached: boolean;
  health: CliHealthStatus['status'] | 'unknown';
}

/**
 * `servers` 行 → CLI 执行视图（invoke / view / 运行时观测共用，避免多处字段映射漂移）。
 * 二进制取自 `servers.command`（D10 复用列）。
 */
export function toCliAssetView(row: ServerRow): CliAssetView {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    ownerId: row.ownerId,
    executionMode: 'cli',
    command: row.command,
    url: row.url,
    env: (row.env ?? null) as Record<string, unknown> | null,
    args: (row.args ?? null) as unknown[] | null,
    credentialSlots: (row.credentialSlots ?? []) as AssetView['credentialSlots'],
    configHash: row.configHash,
  };
}

/**
 * `opsgate_view_asset` 详情载荷的唯一构造点（纯函数，便于不启 MCP 会话地断言）。
 *
 * `cli` 段只在 `executionMode === 'cli'` 时出现：非 CLI 资产没有二进制/沙箱这些事实，
 * 给空段会让调用方以为"字段存在但值为空"。`cli` 入参缺省（执行器未装配）时
 * health 给 `unknown`，不伪造成 `healthy`（§2 原则 2/5）。
 */
export function buildAssetDetail(
  row: ServerRow,
  bound: ReadonlySet<string>,
  groupNames: readonly string[],
  cli?: AssetCliSectionInput,
): Record<string, unknown> {
  const slots = ((row.credentialSlots ?? []) as Array<{ name: string; target?: string; file?: boolean }>).map((s) => ({
    name: s.name,
    target: s.target ?? 'env',
    file: !!s.file,
    bound: bound.has(s.name),
  }));
  const envKeys = Object.keys((row.env ?? {}) as Record<string, unknown>);
  const detail: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    category: row.category,
    type: row.type,
    executionMode: row.executionMode,
    visibility: row.visibility,
    tags: row.tags,
    enabled: row.enabled,
    marketKey: row.marketKey,
    url: row.url ?? null,
    groups: [...groupNames],
    hostConn: row.hostConn ?? null, // 仅 host/port/username/槽位名，无密钥
    envKeys,
    argsCount: Array.isArray(row.args) ? (row.args as unknown[]).length : 0,
    credentialSlots: slots,
    unboundSlots: slots.filter((s) => !s.bound).map((s) => s.name),
  };
  if (row.executionMode === 'cli') {
    const section: AssetCliSection = {
      bin: row.command ?? null,
      // 只给键名：值可能是明文或 ${SLOT} 模板，任何情况下都不下发
      envNames: envKeys,
      runnerAttached: cli?.runnerAttached ?? false,
      health: cli?.health ?? 'unknown',
    };
    detail.cli = section;
  }
  return detail;
}

export interface McpEndpointDeps {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database;
  settings: Settings;
  pool: InstancePool;
  dispatchServices: DispatchServices;
  audit: AuditService;
  nativeRegistry: NativeToolDefinition[];
  runtimeCredsDir: string;
  isVisible(asset: { ownerId: string; visibility: string }, principal: { userId: string; isAdmin: boolean }): boolean | Promise<boolean>;
  /** CLI 一次性进程执行器（Task 9 装配）；缺省时 CLI 资产拒绝调用，不降级为其它执行方式 */
  cliRunner?: CliRunner;
}

interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport;
  principal: { userId: string; isAdmin: boolean };
  ownerUserId: string;
  group: string;
  /** 当前工具集对应的范围（ADR-032：opsgate_select_scope 会替换它，不累积） */
  scope: { group: string; category?: string; tag?: string };
  /** 当前工具集快照：只有本 session 可见，多 agent 并行互不影响 */
  aggregate: AggregateResult;
  lastUsed: number;
}

export class McpEndpoint {
  private sessions = new Map<string, Session>();

  constructor(private readonly deps: McpEndpointDeps) {}

  private aggregationDeps(): AggregationDeps {
    const d = this.deps;
    return {
      db: d.db,
      settings: d.settings,
      pool: d.pool,
      nativeRegistry: d.nativeRegistry,
      isVisible: d.isVisible,
      runtimeCredsDir: d.runtimeCredsDir,
      resolveSlots: (serverId, slotNames, userId) => d.dispatchServices.resolveSlotValues(serverId, slotNames, userId),
      resolveRef: (ref) => {
        const v = d.dispatchServices.resolveRefValue(ref.name, ref.key);
        if (v === null) throw new Error(`凭证引用 ref.${ref.name}.${ref.key} 不存在或键缺失（fail-closed）`);
        return v;
      },
      /** ADR-028 §2.4：调用者在某资产上可用的凭证 = 自己绑的（personal）+ owner 绑定/共享的（asset）。
       *  其他成员的 personal 绑定不可见——那是成员的私有选择。 */
      availableCredentials: (serverId, userId, isAdmin) =>
        listAvailableCredentials(d.db, serverId, userId, isAdmin),
    };
  }

  /**
   * 实时解析元工具的 asset 引用（id / name / displayName）——**查 DB，不用会话快照**。
   *
   * 为什么不用 `session.aggregate.assets`：那是会话建立时的快照。会话建立**之后**新建的资产
   * 不在快照里，导致 list_asset_tools / invoke 对它们永远返回 -32006（而 view_asset 查 DB 能读到，
   * 两者矛盾），agent 会误判成"无权"并反复重试，直到重连或 select_scope 才恢复（真实会话 6e3fb6fa 验证）。
   * 可见性判定与聚合层同源（`deps.isVisible`），不泄露、不放宽。
   */
  private async resolveVisibleAsset(
    ref: string,
    principal: { userId: string; isAdmin: boolean },
  ): Promise<typeof schema.servers.$inferSelect | null> {
    const table = schema.servers;
    let row = await this.deps.db.select().from(table).where(eq(table.id, ref)).get();
    if (!row) row = await this.deps.db.select().from(table).where(eq(table.name, ref)).get();
    if (!row) row = await this.deps.db.select().from(table).where(eq(table.displayName, ref)).get();
    if (!row || !row.enabled) return null;
    if (!(await this.deps.isVisible({ ownerId: row.ownerId ?? '', visibility: row.visibility }, principal))) return null;
    return row;
  }

  /** GET / POST / DELETE /mcp */
  async handle(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const principal = req.principal!;
    const query = req.query as { group?: string; category?: string; tag?: string };
    const group = query.group ?? GROUP_DEFAULT;
    if (group === '_all') {
      return reply.code(400).send({ code: 400, data: null, message: '_all 已废弃；不传 group 即全部可见资产（ADR-030）' });
    }
    // ADR-030：分组不存在 → 400（不静默返回空，避免与"分组内无资产"混淆）
    if (group !== 'all') {
      const grp = await this.deps.db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, group)).get()
        ?? await this.deps.db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, group)).get();
      if (!grp) {
        return reply.code(400).send({ code: 400, data: null, message: `分组 "${group}" 不存在（?group= 现按分组实体过滤；按品类请用 ?category=）` });
      }
    }
    const category = query.category;
    if (category) {
      // ADR-032：品类来自实际数据，不再用硬编码白名单（否则新品类只能走分组入口，而分组先撞工具上限）
      const known = await listKnownCategories(this.deps.db);
      if (!known.includes(category)) {
        return reply.code(400).send({ code: 400, data: null, message: `品类 "${category}" 不存在（现有：${known.join('/')}）` });
      }
    }
    const tag = query.tag;
    const sid = req.headers['mcp-session-id'];
    const existing = typeof sid === 'string' ? this.sessions.get(sid) : undefined;

    // AC-8：sessionId 属主校验——会话存在但属主不符 → 403；未知会话 → 404（规范）
    if (existing) {
      if (existing.ownerUserId !== principal.userId) {
        return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
      }
      existing.lastUsed = Date.now();
      reply.hijack();
      try {
        await existing.transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        process.stderr.write(`[mcp] handleRequest 失败: ${err instanceof Error ? err.message : String(err)}
`);
        if (!reply.raw.writableEnded) reply.raw.end();
      }
      return undefined;
    }
    if (sid) {
      return reply.code(404).send({ code: 404, data: null, message: '未知 MCP 会话' });
    }

    // 新连接（initialize）：按该 principal 动态生成 instructions 与工具
    //
    // ADR-032 单入口分层暴露：URL 未显式收窄时**只给平台工具**，保证裸 `/mcp` 的工具数恒定
    // 且远低于 tools.list_max（否则资产/品类增长一次就 500）。带 ?group= /?category= /?tag=
    // 的客户端视为"初始化就要这个视图"，直接聚合该范围——仍然是同一个入口、同一套范式。
    const explicitScope = query.group !== undefined || category !== undefined || tag !== undefined;
    const scope = { group, ...(category ? { category } : {}), ...(tag ? { tag } : {}) };
    const aggregate = await aggregateTools(this.aggregationDeps(), {
      ...scope,
      principal,
      platformOnly: !explicitScope,
    });
    // 用聚合层产出的文本，不再本地重算：预览端点与真实下发必须是同一份（管理员改完要能对上）
    const instructions = aggregate.instructions;
    const server = new Server(
      { name: 'opsgate-gateway', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      // 真实 HTTP 下 Node wrapper 写响应时机晚于 handleRequest 返回——不能用"事后读头"注册会话；
      // 用会话初始化回调（在 initialize 处理内同步触发，无竞态；真实 listener 与 app.inject 一致）
      onsessioninitialized: (sessionId: string) => {
        this.sessions.set(sessionId, createdRef);
      },
    });
    const createdRef: Session = { server, transport, principal, ownerUserId: principal.userId, group, scope, aggregate, lastUsed: Date.now() };
    // 每次 tools/list 都读 session 的当前工具集：opsgate_select_scope 替换后客户端重列即生效
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: createdRef.aggregate.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const params = request.params as unknown as { name: string; arguments?: Record<string, unknown> };
      return await this.callTool(createdRef, createdRef.aggregate, params.name, params.arguments ?? {});
    });
    await server.connect(transport);

    reply.hijack();
    try {
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      process.stderr.write(`[mcp] handleRequest 失败: ${err instanceof Error ? err.message : String(err)}
`);
      if (!reply.raw.writableEnded) reply.raw.end();
      return undefined;
    }
    return undefined;
  }

  async closeSession(userId: string, group: string): Promise<void> {
    for (const [sid, s] of [...this.sessions]) {
      if (s.ownerUserId === userId && s.group === group) {
        try {
          await s.transport.close();
        } catch {
          // 已关闭
        }
        this.sessions.delete(sid);
      }
    }
  }

  private async callTool(
    session: Session,
    aggregate: AggregateResult,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const fail = (code: number, message: string) => ({
      content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
      isError: true,
    });

    // 发现工具（实时查 DB，不用会话快照——会话建立后新建的资产也必须出现在列表里；
    // 但仍按本会话 scope（group/category/tag）收窄，保持 ?group=/?category=/?tag= 的会话视图语义）
    if (name === 'opsgate_list_assets') {
      const search = typeof args.search === 'string' ? args.search.toLowerCase() : '';
      const tagFilter = typeof args.tag === 'string' ? args.tag : undefined;
      let rows = await this.deps.db.select().from(schema.servers).all();
      // scope.group：按分组实体过滤（ADR-030）
      if (session.scope.group && session.scope.group !== 'all') {
        const grp = await this.deps.db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, session.scope.group)).get()
          ?? await this.deps.db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, session.scope.group)).get();
        if (!grp) rows = [];
        else {
          const inGroup = new Set(
            (await this.deps.db.select({ serverId: schema.groupServers.serverId }).from(schema.groupServers)
              .where(eq(schema.groupServers.groupId, grp.id)).all()).map((r) => r.serverId),
          );
          rows = rows.filter((a) => inGroup.has(a.id));
        }
      }
      if (session.scope.category) rows = rows.filter((a) => a.category === session.scope.category);
      const list: Array<{ id: string; name: string; displayName: string | null; category: string; tags: string[]; executionMode: string }> = [];
      for (const a of rows) {
        if (!a.enabled) continue;
        if (!(await this.deps.isVisible({ ownerId: a.ownerId ?? '', visibility: a.visibility }, session.principal))) continue;
        const tags = (a.tags as string[] | null) ?? [];
        if (session.scope.tag && !tags.includes(session.scope.tag)) continue;
        if (tagFilter && !tags.includes(tagFilter)) continue;
        if (search && !a.name.toLowerCase().includes(search) && !(a.displayName ?? '').toLowerCase().includes(search)) continue;
        list.push({
          id: a.id,
          name: a.name,
          displayName: a.displayName ?? null,
          category: a.category,
          tags,
          executionMode: a.executionMode === 'mcp' || a.executionMode === 'cli' ? a.executionMode : 'native',
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify(list) }] };
    }

    // 探索工具（只读；view 权限与 invoke 一致，R-3 单一真值源；不含任何密钥值——AC-9）
    if (name === 'opsgate_view_asset') {
      const ref = typeof args.asset === 'string' ? args.asset : '';
      if (!ref) return fail(-32602, 'asset 必填（id 或名称）');
      let row = await this.deps.db.select().from(schema.servers).where(eq(schema.servers.id, ref)).get();
      if (!row) row = await this.deps.db.select().from(schema.servers).where(eq(schema.servers.name, ref)).get();
      if (!row || !(await canOnAsset(this.deps.db, 'view', session.principal, row))) {
        return fail(-32006, '资产不存在或无权访问');
      }
      const boundRows = await this.deps.db
        .select({ slotName: schema.serverCredentials.slotName })
        .from(schema.serverCredentials)
        .where(eq(schema.serverCredentials.serverId, row.id))
        .all();
      const bound = new Set(boundRows.map((b) => b.slotName));
      const grps = await this.deps.db
        .select({ name: schema.groups.name })
        .from(schema.groupServers)
        .innerJoin(schema.groups, eq(schema.groups.id, schema.groupServers.groupId))
        .where(eq(schema.groupServers.serverId, row.id))
        .all();
      // CLI 段：runnerAttached 回答"执行器是否装配"（没装配时 CLI 资产根本不可调用），
      // health 走 CliRunner 真实探测（二进制存在/可执行/bwrap 可用），探测本身不解密凭证。
      //
      // 只在 CLI 行探测：`buildAssetDetail` 对非 CLI 行根本不产 cli 段，此时探测纯属白跑
      // （PATH 解析 + accessSync，沙箱开启时还会 spawnSync('bwrap')），view 任何资产都付这份开销。
      let cliSection: AssetCliSectionInput | undefined;
      if (row.executionMode === 'cli') {
        const runner = this.deps.cliRunner;
        cliSection = {
          runnerAttached: runner !== undefined,
          health: runner ? (await runner.health(toCliAssetView(row))).status : 'unknown',
        };
      }
      const detail = buildAssetDetail(row, bound, grps.map((g) => g.name), cliSection);
      return { content: [{ type: 'text' as const, text: JSON.stringify(detail) }] };
    }

    if (name === 'opsgate_list_groups') {
      // 与 REST /api/v1/groups 同口径：成员只见自己所在（或自己资产所属）的分组，admin 见全部。
      // 分组名与资产数量属于组织信息，全量下发等于把他人资产分布暴露给每个成员。
      const all = await this.deps.db.select().from(schema.groups).all();
      let rows = all;
      if (!session.principal.isAdmin) {
        const myGroupIds = new Set(
          (await this.deps.db.select({ groupId: schema.groupUsers.groupId }).from(schema.groupUsers).where(eq(schema.groupUsers.userId, session.principal.userId)).all())
            .map((r) => r.groupId),
        );
        const myOwnedIds = new Set(
          (await this.deps.db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.ownerId, session.principal.userId)).all())
            .map((r) => r.id),
        );
        const viaMyAssets = new Set(
          (await this.deps.db.select({ groupId: schema.groupServers.groupId, serverId: schema.groupServers.serverId }).from(schema.groupServers).all())
            .filter((r) => myOwnedIds.has(r.serverId))
            .map((r) => r.groupId),
        );
        rows = all.filter((g) => myGroupIds.has(g.id) || viaMyAssets.has(g.id));
      }
      const out = [];
      for (const g of rows) {
        // assetCount 也只算调用者可见的资产（MCP 端本来就要按 can('invoke') 过滤候选集）
        const members = await this.deps.db
          .select({ serverId: schema.groupServers.serverId })
          .from(schema.groupServers)
          .where(eq(schema.groupServers.groupId, g.id))
          .all();
        let visibleCount = 0;
        for (const m of members) {
          const srv = await this.deps.db.select().from(schema.servers).where(eq(schema.servers.id, m.serverId)).get();
          if (srv && (await canOnAsset(this.deps.db, 'view', session.principal, srv))) visibleCount++;
        }
        out.push({ id: g.id, name: g.name, description: g.description ?? '', assetCount: visibleCount });
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }

    if (name === 'opsgate_view_group') {
      const ref = typeof args.group === 'string' ? args.group : '';
      if (!ref) return fail(-32602, 'group 必填（id 或名称）');
      let g = await this.deps.db.select().from(schema.groups).where(eq(schema.groups.id, ref)).get();
      if (!g) g = await this.deps.db.select().from(schema.groups).where(eq(schema.groups.name, ref)).get();
      if (!g) return fail(-32006, '分组不存在');
      const members = await this.deps.db
        .select({ serverId: schema.groupServers.serverId })
        .from(schema.groupServers)
        .where(eq(schema.groupServers.groupId, g.id))
        .all();
      const visible: Array<{ id: string; name: string; category: string }> = [];
      for (const m of members) {
        const srv = await this.deps.db.select().from(schema.servers).where(eq(schema.servers.id, m.serverId)).get();
        if (!srv) continue;
        if (await canOnAsset(this.deps.db, 'view', session.principal, srv)) {
          visible.push({ id: srv.id, name: srv.name, category: srv.category });
        }
      }
      const users = await this.deps.db
        .select({ userId: schema.groupUsers.userId })
        .from(schema.groupUsers)
        .where(eq(schema.groupUsers.groupId, g.id))
        .all();
      const detail = {
        id: g.id,
        name: g.name,
        description: g.description ?? '',
        memberCount: users.length,
        assetCount: visible.length,
        assets: visible,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(detail) }] };
    }

    if (name === 'opsgate_select_scope') {
      return await this.selectScope(session, args);
    }

    if (name === 'opsgate_list_asset_tools') {
      return await this.listAssetTools(session, args);
    }

    if (name === 'opsgate_invoke') {
      return await this.invokeOnAsset(session, args);
    }

    const tool = aggregate.tools.find((t) => t.name === name);
    if (!tool) return fail(-32601, `未知工具: ${name}`);

    if (tool.source === 'native') {
      const def = this.deps.nativeRegistry.find((t) => t.id === tool.toolRef);
      if (!def) return fail(500, `原生工具未注册: ${tool.toolRef}`);
      const out = await dispatchNativeTool(def, args, session.principal, this.deps.dispatchServices);
      if (!out.ok) return fail(out.code ?? 500, out.message ?? "");
      return { content: [{ type: 'text', text: JSON.stringify(out.data) }] };
    }

    // 派生工具
    return await this.dispatchDerived(session, tool.toolRef, args);
  }

  /**
   * opsgate_select_scope（ADR-032）：把本会话的工具集切换到给定范围。
   *
   * 关键语义：
   *  - **替换而非累积**：每次重设视图。累积会让工具数随着探索过程无限增长，回到"迟早撞上限"的老问题。
   *  - **范围是资产集合**：同品类的 300 台虚拟机共用同一套工具，靠 `asset` 参数区分具体目标。
   *  - 范围收窄只在**调用者可见资产**内生效——聚合层本来就走 can('invoke') 过滤，不会越权。
   */
  private async selectScope(
    session: Session,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const fail = (code: number, message: string) => ({
      content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
      isError: true,
    });
    const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim() : 'all';
    const category = typeof args.category === 'string' && args.category.trim() ? args.category.trim() : undefined;
    const tag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : undefined;
    if (group === 'all' && !category && !tag) {
      return fail(-32602, 'select_scope 至少给一个条件（group / category / tag）；不带条件是"全部资产"，工具数会失控');
    }
    if (group !== 'all') {
      const grp = await this.deps.db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, group)).get()
        ?? await this.deps.db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, group)).get();
      if (!grp) return fail(-32602, `分组 "${group}" 不存在（取值来自 opsgate_list_groups）`);
    }
    if (category) {
      const known = await listKnownCategories(this.deps.db);
      if (!known.includes(category)) {
        return fail(-32602, `品类 "${category}" 不存在（现有：${known.join('/')}）`);
      }
    }

    let aggregate: AggregateResult;
    try {
      aggregate = await aggregateTools(this.aggregationDeps(), {
        group,
        ...(category ? { category } : {}),
        ...(tag ? { tag } : {}),
        principal: session.principal,
      });
    } catch (err) {
      // 工具数仍超限：明确告诉 agent 收窄，而不是抛 500
      if (err instanceof TooManyToolsError) return fail(-32005, err.message);
      throw err;
    }
    if (aggregate.assets.length === 0) {
      return fail(-32006, '该范围内没有可见资产（检查 group / category / tag，或确认权限）');
    }

    session.scope = { group, ...(category ? { category } : {}), ...(tag ? { tag } : {}) };
    session.aggregate = aggregate;
    // 通知客户端重拉 tools/list（MCP 标准机制；实测 opencode 会清缓存后强制 refresh）
    await session.server.sendToolListChanged();

    const scopeText = [
      group === 'all' ? '全部分组' : `分组「${group}」`,
      category ? `品类 ${category}` : null,
      tag ? `tag=${tag}` : null,
    ].filter(Boolean).join(' · ');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          scope: scopeText,
          assets: aggregate.assets.length,
          tools: aggregate.tools.length,
          note: '工具列表已更新，可直接调用；asset 参数用于指定该范围内的具体资产。',
        }),
      }],
    };
  }

  /**
   * opsgate_list_asset_tools（ADR-033）：单个资产的工具名 + schema。
   *
   * 元工具模式的存在理由：部分客户端（实测 opencode 2.2.6 Code Mode）在会话内不刷新运行期
   * 工具目录，`tools/list_changed` 只更新协议缓存。因此把"这个资产能做什么"降级成一次读取，
   * 由 agent 拿到工具名后走 `opsgate_invoke`。
   *
   * 返回的 schema 去掉了 `asset` 参数——元工具已经把它提到外层，重复要求会诱导模型填错。
   */
  private async listAssetTools(
    session: Session,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const fail = (code: number, message: string) => ({
      content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
      isError: true,
    });
    const ref = typeof args.asset === 'string' ? args.asset : '';
    if (!ref) return fail(-32602, 'asset 必填（id / name / displayName，取自 opsgate_list_assets）');
    // 查 DB 不用会话快照：会话建立后新建的资产也必须能解析（否则 -32006 误判无权）
    const assetRow = await this.resolveVisibleAsset(ref, session.principal);
    if (!assetRow) return fail(-32006, '资产不存在或无权访问');
    const meta = { id: assetRow.id, name: assetRow.displayName || assetRow.name, category: assetRow.category };

    const { tools, violations } = await toolsOfAsset(this.aggregationDeps(), meta.id, session.principal);
    if (tools.length === 0) {
      // 空工具列表不是正常态：多半是槽位未绑定或实例起不来。把原因一并交出去，
      // 否则 agent 只能反复重试同一个资产（R-2 显式失败）。
      return {
        content: [{
          type: 'text' as const,
          text: `[${-32006}] 资产「${meta.name}」当前没有可用工具${violations.length > 0 ? `：${violations.join('；')}` : '（未绑定凭证或实例不可用）'}`,
        }],
        isError: true,
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          asset: { id: meta.id, name: meta.name, category: meta.category },
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: withoutAssetParam(t.inputSchema) })),
          note: '用 opsgate_invoke(asset, tool, args) 调用；tool 取上面的 name，args 按 inputSchema 填（不要带 asset）。',
        }),
      }],
    };
  }

  /**
   * opsgate_invoke（ADR-033）：元工具调用入口。
   *
   * 安全前提：`tool` 必须**属于该资产当前可用的工具集**（同一份 `toolsOfAsset` 结果），
   * 否则等于开了一个任意工具名透传口，绕过 tool_filters / 品类过滤 / 停用开关。
   */
  private async invokeOnAsset(
    session: Session,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const fail = (code: number, message: string) => ({
      content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
      isError: true,
    });
    const ref = typeof args.asset === 'string' ? args.asset : '';
    const toolName = typeof args.tool === 'string' ? args.tool : '';
    if (!ref) return fail(-32602, 'asset 必填（id 或名称，取自 opsgate_list_assets）');
    if (!toolName) return fail(-32602, 'tool 必填（取自 opsgate_list_asset_tools）');
    const rawArgs = args.args;
    if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
      return fail(-32602, 'args 必须是对象（该工具的参数集合）；没有参数就省略');
    }

    // 查 DB 不用会话快照：会话建立后新建的资产也必须能解析（否则 -32006 误判无权）
    const row = await this.resolveVisibleAsset(ref, session.principal);
    if (!row) return fail(-32006, '资产不存在或无权访问');

    const { tools } = await toolsOfAsset(this.aggregationDeps(), row.id, session.principal);
    const target = tools.find((t) => t.name === toolName);
    if (!target) {
      return fail(-32601, `资产「${row.displayName || row.name}」没有可用工具「${toolName}」；先调用 opsgate_list_asset_tools 取合法工具名`);
    }

    const merged = { ...((rawArgs ?? {}) as Record<string, unknown>), asset: row.id };

    // CLI 分支必须先于 native（设计说明 §4.2）：写反会让 category=redis 的 CLI 资产落到下面的
    // 原生 dispatch，用进程内 redis 连接执行命令——既绕过"只跑该资产配置的二进制"的边界，
    // 也让 argv 校验形同虚设。
    if (row.executionMode === 'cli') {
      const argv = (merged as { argv?: unknown }).argv;
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
        return fail(-32602, 'argv 必须是非空字符串数组（如 ["get","pods","-n","prod"]）');
      }
      const runner = this.deps.cliRunner;
      // 执行器未启用 → 显式失败：不退回原生/派生分支，否则同品类 CLI 资产会被别的路径执行。
      // 用 500 而不是 -3200x：这是**服务端装配缺失**（Task 9 才在 server.ts 装配 runner），
      // 调用方改参数/换资产都修不好；-32008 会被理解成"参数校验失败"，反而引导 agent 反复重试。
      // 与 native 分派里"connector 未注册"同为启动期不变量，同一口径。
      if (!runner) return fail(500, 'CLI 执行器未启用（服务端未装配 CliRunner，CLI 资产不可调用）');
      const cliAsset: CliAssetView = toCliAssetView(row);
      const slotNames = cliAsset.credentialSlots.map((s) => s.name);
      const out = await runGuarded(
        {
          assetRef: row.id,
          toolName: `cli:${row.id}:${toolName}`,
          args: merged,
          // 设计说明 §5.3 声明 CLI 为 write 级；当前审计模型只有 normal|high（§5.8：全不命中→normal，
          // mark 命中→high），且 native 的 host_execute_command 同样以 normal 起步。
          // 破坏性 argv 由 Task 5 的 mark 规则升级为 high，argv 全文照旧进审计，故此处取 normal。
          baseRisk: 'normal',
          audit: { fields: ['argv'], includeCommand: true },
        },
        session.principal,
        this.deps.dispatchServices,
        async () => {
          // 凭证放在门禁之后解析：策略拦截/无权时不解密任何密钥，解析失败也走统一错误映射与回填
          const credentials = await this.deps.dispatchServices.resolveCredentials(
            cliAsset,
            slotNames,
            session.principal.userId,
          );
          const r = await runner.exec({
            asset: cliAsset,
            argv: argv as string[],
            credentials,
            userId: session.principal.userId,
          });
          return {
            content: r,
            meta: { exitCode: r.exitCode, truncated: r.truncated, durationMs: r.durationMs },
            durationMs: r.durationMs,
          };
        },
      );
      if (!out.ok) return fail(out.code ?? 500, out.message ?? '');
      return { content: [{ type: 'text', text: JSON.stringify(out.data) }] };
    }

    if (row.executionMode !== 'mcp') {
      const def = this.deps.nativeRegistry.find((t) => t.name === toolName && t.category === row.category);
      if (!def) return fail(-32601, `原生工具「${toolName}」未注册`);
      const out = await dispatchNativeTool(def, merged, session.principal, this.deps.dispatchServices);
      if (!out.ok) return fail(out.code ?? 500, out.message ?? '');
      return { content: [{ type: 'text', text: JSON.stringify(out.data) }] };
    }

    // 派生工具复用同一套"规则→写前审计→实例池→callTool→回填"链路；toolRef 即 MCP 侧真实工具名
    return await this.dispatchDerived(session, toolName, merged);
  }

  private async dispatchDerived(
    session: Session,
    toolRef: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const fail = (code: number, message: string) => ({
      content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
      isError: true,
    });
    const ref = typeof args.asset === 'string' ? args.asset : '';
    const assetMeta = session.aggregate.assets.find((a) => a.id === ref || a.name === ref);
    if (!assetMeta) return fail(-32006, '资产不存在或无权访问');
    const row = await this.deps.db.select().from(schema.servers).where(eq(schema.servers.id, assetMeta.id)).get();
    if (!row || row.executionMode !== 'mcp') return fail(-32006, '资产不存在或无权访问');
    // 停用资产必须拒绝调用（§4.1 enabled）：发现阶段已不派生其工具，
    // 但会话的 aggregate 是建立时快照，停用后旧会话仍可能持有工具名——此处兜底。
    if (!row.enabled) return fail(-32006, '资产已停用，不可调用');

    // 发现工具与调用共用同一次可见性（session 内已过滤）
    const ruleName = `derived:${row.id}:${toolRef}`;
    const assetGroups = await this.deps.db
      .select({ name: schema.groups.name })
      .from(schema.groupServers)
      .innerJoin(schema.groups, eq(schema.groups.id, schema.groupServers.groupId))
      .where(eq(schema.groupServers.serverId, row.id))
      .all();
    const hit = evaluateRules(loadActiveRules(this.deps.sqlite), {
      tool: ruleName,
      args,
      assetType: row.category,
      groups: assetGroups.map((g) => g.name),
    });
    const risk = hit?.kind === 'mark' ? 'high' : 'normal';
    let intent: { intentId: string };
    try {
      intent = await this.deps.audit.writeIntent({
        principal: session.principal,
        asset: { id: row.id, name: row.name },
        tool: ruleName,
        args,
        risk,
        status: hit?.kind === 'block' ? 'blocked' : 'pending',
      });
    } catch {
      return fail(-32003, 'Audit unavailable; call refused');
    }
    if (hit?.kind === 'block') return fail(-32004, `被规则拦截: ${hit.ruleName}`);

    const t0 = Date.now();
    try {
      const view = (await this.deps.dispatchServices.resolveAsset(ref, session.principal)) as AssetView | null;
      if (!view) return fail(-32006, '资产不存在或无权访问');
      const slotNames = view.credentialSlots.map((s) => s.name);

      // ADR-028 §2.4：可选 credential 参数 —— 指定用哪个凭证（先校验调用者可用性）
      const requestedCred = typeof args.credential === 'string' && args.credential.trim() ? args.credential.trim() : null;
      if (requestedCred) {
        const avail = listAvailableCredentials(this.deps.db, row.id, session.principal.userId, session.principal.isAdmin);
        if (!avail.some((c) => c.credentialId === requestedCred)) {
          return fail(-32006, '无权使用该凭证（未被共享，或不是本人绑定）');
        }
      }
      const creds = await this.deps.dispatchServices.resolveCredentials(view, slotNames, session.principal.userId, requestedCred);
      const plan = buildPlan(
        {
          id: row.id,
          configHash: row.configHash,
          command: row.command,
          args: row.args ?? [],
          env: row.env ?? {},
          url: row.url,
          headers: row.headers ?? {},
          transport: transportOf(row.type),
          allowInsecureTls: row.allowInsecureTls === true,
          resolveRef: (ref) => {
            const v = this.deps.dispatchServices.resolveRefValue(ref.name, ref.key);
            if (v === null) throw new Error(`凭证引用 ref.${ref.name}.${ref.key} 不存在或键缺失（fail-closed）`);
            return v;
          },
          credentialSlots: (row.credentialSlots ?? []) as never,
        },
        // 凭证已在 plan 注入前解析（env 占位符补充）：从 creds 回填为 ResolvedCredential 形状不可得元数据时仅值
        Object.entries(creds).map(([slotName, value]) => ({
          slotName,
          value,
          credentialId: '',
          updatedAtMs: 0,
        })),
        this.deps.runtimeCredsDir,
      );
      const handle = await this.deps.pool.acquire(plan, session.principal.userId);
      try {
        const { asset: _asset, ...rest } = args;
        const result = await handle.client.callTool({ name: toolRef, arguments: rest });
        await this.deps.audit.fill({
          intentId: intent.intentId,
          status: 'success',
          outputSummary: JSON.stringify(result).slice(0, this.deps.settings.get<number>('tools.output_truncate_bytes')),
          durationMs: Date.now() - t0,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.deps.audit.fill({
          intentId: intent.intentId,
          status: 'error',
          errorMessage: message.slice(0, this.deps.settings.get<number>('tools.output_truncate_bytes')),
          durationMs: Date.now() - t0,
        });
        return fail(-32002, message);
      } finally {
        await handle.release();
      }
    } catch (err) {
      await this.deps.audit.fill({
        intentId: intent.intentId,
        status: 'error',
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, this.deps.settings.get<number>('tools.output_truncate_bytes')),
        durationMs: Date.now() - t0,
      });
      return fail(-32002, err instanceof Error ? err.message : String(err));
    }
  }

  /** 仅供 preview 端点：聚合结果（不建会话） */
  async preview(input: { group: string; category?: string; tag?: string; principal: { userId: string; isAdmin: boolean } }): Promise<{
    tools: ExposedTool[];
    instructions: string;
    count: number;
    violations: string[];
    assetCount: number;
  }> {
    try {
      const r = await aggregateTools(this.aggregationDeps(), input);
      return {
        tools: r.tools,
        instructions: r.instructions,
        count: r.tools.length,
        violations: r.violations,
        assetCount: r.assets.length,
      };
    } catch (err) {
      if (err instanceof TooManyToolsError) {
        return { tools: [], instructions: '', count: 0, violations: [err.message], assetCount: 0 };
      }
      throw err;
    }
  }
}

export interface AvailableCredential {
  credentialId: string;
  name: string;
  privileges: string[];
  scope: 'asset' | 'personal';
  slots: string[];
}

/**
 * 元工具对外暴露的 schema 不带 `asset`：它已经是 opsgate_invoke 的外层参数。
 * 保留会让模型在两个地方填同一件事，且与 `required` 里已含的 asset 冲突。
 */
function withoutAssetParam(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...((inputSchema.properties ?? {}) as Record<string, unknown>) };
  delete properties.asset;
  const required = (inputSchema.required as string[] | undefined)?.filter((k) => k !== 'asset');
  return { ...inputSchema, properties, ...(required ? { required } : {}) };
}

/**
 * ADR-028 §2.4：调用者在某资产上可用的凭证。
 * 可见范围 = 自己的全部绑定 + 他人的 asset 绑定；他人 personal 绑定不可见。
 * 用于两处：工具描述里提示可用凭证、tools/call 的 credential 参数校验。
 */
export function listAvailableCredentials(
  db: BetterSQLite3Database<typeof schema>,
  serverId: string,
  userId: string,
  isAdmin: boolean,
): AvailableCredential[] {
  const rows = db
    .select({
      credentialId: schema.serverCredentials.credentialId,
      userId: schema.serverCredentials.userId,
      scope: schema.serverCredentials.scope,
      slotName: schema.serverCredentials.slotName,
      name: schema.credentials.name,
      privileges: schema.credentials.privileges,
    })
    .from(schema.serverCredentials)
    .innerJoin(schema.credentials, eq(schema.credentials.id, schema.serverCredentials.credentialId))
    .where(eq(schema.serverCredentials.serverId, serverId))
    .all();
  const byCred = new Map<string, AvailableCredential>();
  for (const r of rows) {
    if (r.scope !== 'asset' && r.userId !== userId && !isAdmin) continue;
    const cur = byCred.get(r.credentialId);
    if (cur) {
      if (!cur.slots.includes(r.slotName)) cur.slots.push(r.slotName);
      continue;
    }
    byCred.set(r.credentialId, {
      credentialId: r.credentialId,
      name: r.name,
      privileges: Array.isArray(r.privileges) ? r.privileges : [],
      scope: r.scope === 'personal' ? 'personal' : 'asset',
      slots: [r.slotName],
    });
  }
  return [...byCred.values()];
}
