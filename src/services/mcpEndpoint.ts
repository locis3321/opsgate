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

    // 发现工具
    if (name === 'opsgate_list_assets') {
      const search = typeof args.search === 'string' ? args.search.toLowerCase() : '';
      const tagFilter = typeof args.tag === 'string' ? args.tag : undefined;
      const list = aggregate.assets.filter(
        (a) =>
          (!search || a.name.toLowerCase().includes(search)) &&
          (!tagFilter || a.tags.includes(tagFilter)),
      );
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
      const slots = ((row.credentialSlots ?? []) as Array<{ name: string; target?: string; file?: boolean }>).map((s) => ({
        name: s.name,
        target: s.target ?? 'env',
        file: !!s.file,
        bound: bound.has(s.name),
      }));
      const detail = {
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
        groups: grps.map((g) => g.name),
        hostConn: row.hostConn ?? null, // 仅 host/port/username/槽位名，无密钥
        envKeys: Object.keys((row.env ?? {}) as Record<string, unknown>),
        argsCount: Array.isArray(row.args) ? (row.args as unknown[]).length : 0,
        credentialSlots: slots,
        unboundSlots: slots.filter((s) => !s.bound).map((s) => s.name),
      };
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
    if (!ref) return fail(-32602, 'asset 必填（id 或名称，取自 opsgate_list_assets）');
    const meta = session.aggregate.assets.find((a) => a.id === ref || a.name === ref);
    if (!meta) return fail(-32006, '资产不存在或无权访问');

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

    const meta = session.aggregate.assets.find((a) => a.id === ref || a.name === ref);
    if (!meta) return fail(-32006, '资产不存在或无权访问');
    const row = await this.deps.db.select().from(schema.servers).where(eq(schema.servers.id, meta.id)).get();
    if (!row || !row.enabled) return fail(-32006, '资产不存在或无权访问');

    const { tools } = await toolsOfAsset(this.aggregationDeps(), row.id, session.principal);
    const target = tools.find((t) => t.name === toolName);
    if (!target) {
      return fail(-32601, `资产「${meta.name}」没有可用工具「${toolName}」；先调用 opsgate_list_asset_tools 取合法工具名`);
    }

    const merged = { ...((rawArgs ?? {}) as Record<string, unknown>), asset: row.id };

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
