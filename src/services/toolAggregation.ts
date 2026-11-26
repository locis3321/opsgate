/**
 * 工具聚合服务（ADR-021 / Spec §5.5）：
 * 聚合单元 =(category, implementation)：native(impl='opsgate') ∪ derived(社区 tools/list 派生)；
 * 工具名 {category}_{tool}；同品类多实现冲突 → {impl 短前缀}_{tool} + 描述首句标注来源（R5）；
 * 派生裁剪：剔除连接参数（描述含 ${ 或连接键集合）→ 追加必填 asset（描述含"取值来自 opsgate_list_assets"）；
 * opsgate_list_assets 永远第一位；>tools.list_max → TooManyTools(-32005)；
 * R1–R8 校验：违规工具从列表剔除并在 violations 报告（fail-safe）。
 * v1 平台注入仅 opsgate_list_assets（§5.5.1 估算的 +2 含 V1.1 request_access，决策记录）。
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { buildPlan, transportOf, type InstancePlan } from './instancePlan.js';
import type { InstancePool } from './instancePool.js';
import type { ExecutionMode, NativeToolDefinition } from '../framework/types.js';
import { validateDescription } from '../framework/validate.js';
import type { Settings } from '../config/settings.js';
import { DEFAULT_WORKFLOW_INSTRUCTIONS } from '../config/settingsSchema.js';
import type { ResolvedCredential } from './credentials.js';
import { cliExposedTool } from './cliTool.js';

export interface ExposedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: 'native' | 'derived' | 'cli';
  category: string;
  /** 实现标识：opsgate（原生）或社区命令短前缀 */
  impl: string;
  /** 原生工具 id 或派生原始工具名 */
  toolRef: string;
  serverId?: string;
}

export interface VisibleAsset {
  id: string;
  name: string;
  category: string;
  tags: string[];
  /** 执行方式：发现链路据此区分 native / mcp / cli（§3.2 / ADR-037） */
  executionMode: ExecutionMode;
}

export class TooManyToolsError extends Error {}

export interface AggregateInput {
  /** 分组名或分组 id（ADR-030）；'all' = 不限分组 */
  group: string;
  /** 资产品类收窄（ADR-032 起品类取自实际数据，不再有白名单） */
  category?: string;
  tag?: string;
  principal: { userId: string; isAdmin: boolean };
  /**
   * 只返回平台工具（opsgate_*），不派生任何品类/资产工具（ADR-032）。
   *
   * 单入口模型：MCP 连接建立时用 platformOnly 聚合，保证裸 `/mcp` 恒定为固定的小工具集，
   * 永远不可能撞 tools.list_max。agent 必须先调 opsgate_select_scope 选定范围，
   * 才拿到该范围的工具（§5.5.1 的分层暴露）。
   */
  platformOnly?: boolean;
}

export interface AggregateResult {
  tools: ExposedTool[];
  instructions: string;
  violations: string[];
  serverIds: string[];
  assets: VisibleAsset[];
}

export interface AggregationDeps {
  db: BetterSQLite3Database<typeof schema>;
  settings: Settings;
  pool: InstancePool;
  nativeRegistry: NativeToolDefinition[];
  /** 可见性（T8 完整 can() 替换；T7 为 owner|admin|public 最小版，决策记录） */
  isVisible(asset: { ownerId: string | null; visibility: string }, principal: { userId: string; isAdmin: boolean }): boolean | Promise<boolean>;
  runtimeCredsDir: string;
  /** 资产绑定凭证解析（未绑定槽位抛错）——聚合派生按资产 fail-closed 处理，不炸整组。
   *  `userId` 传入时按 personal → asset 取值（ADR-028）；不传则只取 asset。 */
  resolveSlots(serverId: string, slotNames: string[], userId?: string): ResolvedCredential[];
  /** ref.<凭证名>.<键名> 解析（不存在抛错 fail-closed） */
  resolveRef(ref: { name: string; key: string }): string;
  /** ADR-028：该资产上调用者可用的凭证（自己绑的 + owner 共享/绑定的），用于工具描述与 credential 参数校验 */
  availableCredentials?(serverId: string, userId: string, isAdmin: boolean): Array<{
    credentialId: string;
    name: string;
    privileges: string[];
    scope: 'asset' | 'personal';
    slots: string[];
  }>;
}

const CONNECTION_PARAM_KEYS = new Set([
  'host', 'port', 'username', 'user', 'password', 'database', 'ssh_host', 'ssh_port',
  'db_host', 'mcp_host', 'token', 'api_key', 'url',
]);

export function implShortOf(command: string): string {
  const base = command.split(/\s+/).pop() ?? command;
  return base.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'impl';
}

/**
 * 实际存在的品类集合（ADR-032 · D3）：`servers.category` ∪ `market_entries.categories`。
 *
 * 为什么改成动态：原实现用 `TOOL_CATEGORIES` 硬编码白名单做 `?category=` 校验，
 * 而 ES / Kafka / Prometheus / Baota / MinIO 这些后来接入的品类不在白名单里 → 它们
 * 只能从 `?group=` 入口连，而所在分组工具数先撞上限 → 整个品类不可达。
 * 品类本来就在数据里，没有理由再维护第二份清单。
 *
 * 含 market categories 是因为新建资产时该品类可能还没有任何资产（不该因此被拒）。
 */
export async function listKnownCategories(db: BetterSQLite3Database<typeof schema>): Promise<string[]> {
  const serverRows = await db.selectDistinct({ category: schema.servers.category }).from(schema.servers).all();
  const marketRows = await db.select({ categories: schema.marketEntries.categories }).from(schema.marketEntries).all();
  const set = new Set<string>(serverRows.map((r) => r.category));
  for (const m of marketRows) for (const c of m.categories ?? []) if (typeof c === 'string') set.add(c);
  return [...set].sort();
}

export async function aggregateTools(deps: AggregationDeps, input: AggregateInput): Promise<AggregateResult> {
  const tools: ExposedTool[] = [];
  const violations: string[] = [];
  const serverIds: string[] = [];

  // 0) 可见资产（发现工具与派生遍历共用同一集合，保证不泄露-AC-34）
  //    ADR-030：?group= 按**分组实体**过滤（不是品类）；?category= 才是品类收窄；两者为交集。
  let candidates = await deps.db.select().from(schema.servers).all();
  if (input.group && input.group !== 'all') {
    // 分组名或 id → 分组内资产 id 集合；不存在时由上层 400（此处防御性返回空）
    const grp = await deps.db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, input.group)).get()
      ?? await deps.db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, input.group)).get();
    if (!grp) {
      candidates = [];
    } else {
      const inGroup = new Set(
        (await deps.db
          .select({ serverId: schema.groupServers.serverId })
          .from(schema.groupServers)
          .where(eq(schema.groupServers.groupId, grp.id))
          .all()).map((r) => r.serverId),
      );
      candidates = candidates.filter((a) => inGroup.has(a.id));
    }
  }
  if (input.category) candidates = candidates.filter((a) => a.category === input.category);
  const assets: VisibleAsset[] = [];
  for (const a of candidates) {
    // 停用的资产不参与发现，也不派生工具（§4.1 enabled：停用即不可调用）。
    // 这里同时决定 list_assets 的可见集合与派生遍历集合，两处必须一致（AC-34 不泄露）。
    if (!a.enabled) continue;
    if (!(await deps.isVisible(a, input.principal))) continue;
    if (input.tag && !((a.tags as string[] | null) ?? []).includes(input.tag)) continue;
    assets.push({
      id: a.id,
      name: a.name,
      category: a.category,
      tags: (a.tags as string[] | null) ?? [],
      // servers.execution_mode 是 text 列（无 DB 级枚举约束），这里收窄成联合类型；
      // 只有 native / mcp / cli 三种定义，其余值按 native 处理（与 nativeDispatch 同一口径）。
      executionMode: a.executionMode === 'mcp' || a.executionMode === 'cli' ? a.executionMode : 'native',
    });
  }

  // 工具名唯一性登记表（name → impl）：原生与派生共用同一张表（ADR-032 · P1）。
  const seenByName = new Map<string, string>();

  // 1) 原生工具（impl='opsgate'；§5.9.5 停用即从 tools/list 移除）
  const disabledNative = new Set<string>(deps.settings.get<readonly string[]>('native_tools.disabled') ?? []);
  // ADR-030：原生工具跟随 ?category= 收窄；?group= 是资产视图、不影响原生工具的品类
  // ADR-032：platformOnly 时一条都不给——分层暴露的第一层只有 opsgate_* 工具
  for (const t of input.platformOnly ? [] : deps.nativeRegistry.filter((x) => !input.category || x.category === input.category)) {
    if (disabledNative.has(t.id)) continue;
    const dup = dedupeToolName(seenByName, t.name, 'opsgate');
    if (dup.action === 'dropped') {
      violations.push(dup.reason);
      continue;
    }
    tools.push({
      name: t.name,
      description: t.description,
      inputSchema: withAssetParam(t.inputSchema, t.category),
      source: 'native',
      category: t.category,
      impl: 'opsgate',
      toolRef: t.id,
    });
    violations.push(...validateDescription(t).map((v) => `${t.id}: ${v}`));
  }

  // 2) 派生工具：每个可见 mcp 资产——按实现取样（同实现复用同一 schema 集合）
  // v1 冲突策略（决策记录）：同品类多实现同名工具时保留首个实现，被省略者记入 violations（显式失败）；
  // R5 的 {impl}_{tool} 前缀命名保留在聚合层（impl 字段），供后续启用。
  const derivedTools: ExposedTool[] = [];
  for (const a of input.platformOnly ? [] : candidates) {
    if (!assets.some((v) => v.id === a.id)) continue;
    if (a.executionMode !== 'mcp') continue;
    const impl = implShortOf(a.command ?? 'mcp');
    const slotNames = ((a.credentialSlots ?? []) as Array<{ name: string }>).map((s) => s.name);
    // ADR-028：按调用者解析（personal 优先）；缓存键必须含 userId，否则成员会拿到 owner 的派生结果
    const derived = await derivedToolsOf(deps, a, `${a.id}:${a.configHash}:${input.principal.userId}`, slotNames, violations, input.principal);
    // 该调用者在此资产上可用的凭证（用于描述提示；不可用的不会出现在这里）
    const creds = deps.availableCredentials?.(a.id, input.principal.userId, input.principal.isAdmin) ?? [];
    const credHint = creds.length > 0
      ? `可用凭证：${creds.map((c) => `${c.name}(${[c.scope === 'personal' ? '私有' : '共享', ...c.privileges].join('/') || '无等级'})`).join('、')}；调用时可传 credential 指定用哪个，不传则自动选择。`
      : '';
    // 资产级工具筛选（tool_filters，Spec §5.5）：白名单优先；黑名单剔除
    const filters = (a.toolFilters ?? {}) as { enabledTools?: string[]; disabledTools?: string[] };
    const listed =
      filters.enabledTools && filters.enabledTools.length > 0
        ? derived.filter((dt) => filters.enabledTools!.includes(dt.name))
        : derived.filter((dt) => !(filters.disabledTools ?? []).includes(dt.name));
    serverIds.push(a.id);
    for (const dt of listed) {
      const baseName = `${a.category}_${dt.name}`;
      const existingImpl = seenByName.get(baseName);
      const dup = dedupeToolName(seenByName, baseName, impl);
      if (dup.action === 'dropped') {
        // 同实现重复资产 = 复用首个 schema（静默）；不同实现 = 冲突（记 violations，显式失败）
        if (existingImpl !== impl) violations.push(dup.reason);
        continue;
      }
      derivedTools.push({
        name: baseName,
        description: normalizeDerivedDescription(dt.description, dt.name, a.category, credHint),
        inputSchema: withAssetParam(normalizeDerivedSchema(dt.inputSchema), a.category),
        source: 'derived',
        category: a.category,
        impl,
        toolRef: dt.name,
        serverId: a.id,
      });
    }
  }
  tools.push(...derivedTools);

  // 3) 平台注入：opsgate_list_assets 永远第一位；探索工具（只读，all/group 均生效）
  const platform: ExposedTool = {
    name: 'opsgate_list_assets',
    description:
      '列出当前连接可见的资产清单（id/name/displayName/category/tags），也是 asset 参数取值的唯一合法来源。Use when: 用户说"有哪些主机/数据库"、或调用任何 *_ 工具前确认目标。Required: 无参数即可调用；后续 asset 参数可直接填返回的 name（或 id），不必记 id，不要编造。',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: '按名称模糊匹配（可选）' },
        tag: { type: 'string', description: '按资产 tag 过滤（可选）' },
      },
    },
    source: 'derived',
    category: input.group,
    impl: 'opsgate',
    toolRef: 'opsgate_list_assets',
  };
  const exploreTools: ExposedTool[] = [
    {
      name: 'opsgate_view_asset',
      description:
        '查看单个资产详情：类型/执行模式/主机配置/槽位绑定状态/可见范围/所属分组（不含任何密钥值）。Use when: 确认某个资产能否操作、槽位是否已绑定、属于哪个分组。Required: 先调用 opsgate_list_assets 取资产 id 作为 asset 参数，不要编造。',
      inputSchema: {
        type: 'object',
        properties: { asset: { type: 'string', description: '资产 id / name / displayName（取自 opsgate_list_assets）' } },
        required: ['asset'],
      },
      source: 'derived',
      category: input.group,
      impl: 'opsgate',
      toolRef: 'opsgate_view_asset',
    },
    {
      name: 'opsgate_list_groups',
      description:
        '列出全部分组清单与分组说明（管理员维护的业务背景，LLM 应结合理解）。Use when: 需要了解组织机构/分组上下文再决定操作对象。Required: 无参数。',
      inputSchema: { type: 'object', properties: {} },
      source: 'derived',
      category: input.group,
      impl: 'opsgate',
      toolRef: 'opsgate_list_groups',
    },
    {
      name: 'opsgate_view_group',
      description:
        '查看分组详情：分组说明 + 组内可见资产 + 成员数。Use when: 了解某分组的业务背景与资产构成。Required: 先调用 opsgate_list_groups 取分组 id 或名称作为 group 参数。',
      inputSchema: {
        type: 'object',
        properties: { group: { type: 'string', description: '分组 id 或名称（取自 opsgate_list_groups）' } },
        required: ['group'],
      },
      source: 'derived',
      category: input.group,
      impl: 'opsgate',
      toolRef: 'opsgate_view_group',
    },
    {
      name: 'opsgate_list_asset_tools',
      description:
        '列出某个资产可用的工具名与参数 schema（只读，不含任何密钥值）。Use when: 已用 opsgate_list_assets 选定资产、准备调用前，先确认这个资产能做哪些操作、参数怎么填。Required: asset 取自 opsgate_list_assets，不要编造。',
      inputSchema: {
        type: 'object',
        properties: { asset: { type: 'string', description: '资产 id / name / displayName（取自 opsgate_list_assets）' } },
        required: ['asset'],
      },
      source: 'derived',
      category: input.group,
      impl: 'opsgate',
      toolRef: 'opsgate_list_asset_tools',
    },
    {
      name: 'opsgate_invoke',
      description:
        '调用某个资产上的工具。Use when: 已通过 opsgate_list_asset_tools 确认工具名与参数后执行操作。Required: asset 取自 opsgate_list_assets；tool 取自上一步返回的工具名（不含品类前缀）；args 是该工具的参数对象，不要包含 asset。',
      inputSchema: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: '资产 id / name / displayName（取自 opsgate_list_assets）' },
          tool: { type: 'string', description: '工具名，取值来自 opsgate_list_asset_tools（如 execute_command / query）' },
          args: { type: 'object', description: '该工具的参数对象（不含 asset，框架会自动注入）' },
        },
        required: ['asset', 'tool'],
      },
      source: 'derived',
      category: input.group,
      impl: 'opsgate',
      toolRef: 'opsgate_invoke',
    },
    {
      name: 'opsgate_select_scope',
      description:
        '（可选）把本连接的工具列表切换为某个范围（分组 / 品类 / tag）的完整工具集。Use when: 客户端支持动态工具列表刷新、且希望直接以一等公民工具调用时。Required: 至少给一个条件；范围是**资产集合**不是单个资产。注意：部分客户端不刷新运行期工具目录，此时请改用 opsgate_invoke。',
      inputSchema: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '分组名或 id（来自 opsgate_list_groups）；不传=全部分组' },
          category: { type: 'string', description: '资产品类（如 host / mysql / k8s）；不传=全部品类' },
          tag: { type: 'string', description: '资产 tag 过滤（可选）' },
        },
      },
      source: 'derived',
      category: input.group,
      impl: 'opsgate',
      toolRef: 'opsgate_select_scope',
    },
  ];
  tools.unshift(platform, ...exploreTools);

  // 4) 上限（-32005，不静默截断）
  const max = deps.settings.get<number>('tools.list_max');
  if (tools.length > max) throw new TooManyToolsError(`工具数 ${tools.length} 超过上限 ${max}（需 ?tag= 收窄）`);

  // 5) R1-R8 fail-safe：违规剔除并报告（preview 可见 violations）
  const safe: ExposedTool[] = [];
  for (const t of tools) {
    // 平台工具（opsgate_*）命名是全局固定契约，R1 的 {category}_ 前缀规则不适用（决策记录）
    const v = t.name.startsWith('opsgate_') ? [] : validateDescription(t as unknown as NativeToolDefinition);
    if (v.length > 0) {
      violations.push(`${t.name}: ${v.join('; ')}`);
      continue;
    }
    safe.push(t);
  }

  // ADR-024：tools.schema_token_budget 真实消费——全量 schema 粗估（4 字符/token），超阈值进 violations
  const budget = deps.settings.get<number>('tools.schema_token_budget');
  const estimatedTokens = Math.ceil(
    safe.reduce((acc, t) => acc + (t.name.length + t.description.length + JSON.stringify(t.inputSchema).length), 0) / 4,
  );
  if (estimatedTokens > budget) {
    violations.push(`全量 schema 粗估 ${estimatedTokens} token 超出预算 ${budget}（tools.schema_token_budget）`);
  }

  // 分组说明（LLM 上下文补充：管理员维护的组描述进 instructions；all 模式无单一分组）
  // ADR-030：?group= 现为分组实体，name 或 id 均可解析
  const grp =
    input.group === 'all'
      ? undefined
      : await deps.db
          .select({ description: schema.groups.description, name: schema.groups.name })
          .from(schema.groups)
          .where(eq(schema.groups.name, input.group))
          .get()
        ?? await deps.db
          .select({ description: schema.groups.description, name: schema.groups.name })
          .from(schema.groups)
          .where(eq(schema.groups.id, input.group))
          .get();

  return {
    tools: safe,
    instructions: buildInstructions(
      input,
      safe.length,
      assets.length,
      grp?.description ?? '',
      deps.settings.get<string>('mcp.instructions') ?? '',
    ),
    violations,
    serverIds,
    assets,
  };
}

const derivedCache = new Map<string, { at: number; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>();

/**
 * 单个资产当前可用的工具（ADR-033 元工具模式）。
 *
 * 与 `aggregateTools` 的关系：同一份派生逻辑（`derivedToolsOf`），只是不按品类聚合、
 * 不建会话视图。用途有两个：
 *  1. `opsgate_list_asset_tools` 把工具名 + schema 交给 agent；
 *  2. `opsgate_invoke` 校验 agent 传来的 tool 名确实属于该资产（否则等于开了一个任意调用口）。
 *
 * 原生资产（executionMode='native'）从注册表按品类取，与资产数无关。
 */
export async function toolsOfAsset(
  deps: AggregationDeps,
  assetId: string,
  principal: { userId: string; isAdmin: boolean },
): Promise<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; violations: string[] }> {
  const row = await deps.db.select().from(schema.servers).where(eq(schema.servers.id, assetId)).get();
  if (!row || !row.enabled) return { tools: [], violations: [] };
  const violations: string[] = [];

  // CLI 分支必须先于 native 判断（设计说明 §4.2）：条件反过来写会让 category=redis 的 CLI 资产
  // 被判成"原生 redis 资产"，暴露并对接进程内 redis_command / redis_info / redis_slowlog，
  // 等于绕过"CLI 只能跑它自己配置的那个二进制"这条边界。
  if (row.executionMode === 'cli') {
    // command 缺失是必填业务事实缺失，cliExposedTool 会抛错。这里必须自己接住：
    // 让它冒到 listAssetTools / invokeOnAsset 外层会变成 JSON-RPC 协议级 -32603，
    // 调用方分不清"这台资产没配好"和"网关自己崩了"。改按 R 校验违规同口径报出，
    // 由调用方转成 -32006 + 原因（一个工具都没有的资产本来就该显式说原因）。
    try {
      const t = cliExposedTool({
        id: row.id,
        name: row.name,
        category: row.category,
        command: row.command,
      });
      return {
        tools: [{
          name: t.name,
          description: t.description,
          inputSchema: withAssetParam(t.inputSchema, row.category) as Record<string, unknown>,
        }],
        violations,
      };
    } catch (err) {
      violations.push(`cli:${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      return { tools: [], violations };
    }
  }

  if (row.executionMode !== 'mcp') {
    const disabled = new Set<string>(deps.settings.get<readonly string[]>('native_tools.disabled') ?? []);
    const tools = deps.nativeRegistry
      .filter((t) => t.category === row.category && !disabled.has(t.id))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: withAssetParam(t.inputSchema, t.category) as Record<string, unknown>,
      }));
    return { tools, violations };
  }

  const slotNames = ((row.credentialSlots ?? []) as Array<{ name: string }>).map((s) => s.name);
  const derived = await derivedToolsOf(
    deps,
    row,
    `${row.id}:${row.configHash}:${principal.userId}`,
    slotNames,
    violations,
    principal,
  );
  const filters = (row.toolFilters ?? {}) as { enabledTools?: string[]; disabledTools?: string[] };
  const listed =
    filters.enabledTools && filters.enabledTools.length > 0
      ? derived.filter((dt) => filters.enabledTools!.includes(dt.name))
      : derived.filter((dt) => !(filters.disabledTools ?? []).includes(dt.name));
  return {
    tools: listed.map((dt) => ({
      name: dt.name,
      description: normalizeDerivedDescription(dt.description, dt.name, row.category, ''),
      inputSchema: withAssetParam(normalizeDerivedSchema(dt.inputSchema), row.category) as Record<string, unknown>,
    })),
    violations,
  };
}

async function derivedToolsOf(
  deps: AggregationDeps,
  asset: {
    id: string;
    configHash: string;
    command: string | null;
    args: unknown;
    env: unknown;
    url: string | null;
    headers: unknown;
    credentialSlots: unknown;
    type?: string | null;
  },
  cacheKey: string,
  slotNames: string[],
  violations: string[],
  principal?: { userId: string; isAdmin: boolean },
): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
  const hit = derivedCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 300_000) return hit.tools;
  // 归因失败（槽位未绑定/未解析/构建失败/池忙）：该资产 fail-closed 不派生工具（R-2 显式失败），
  // 记入 violations 而不是让整组 initialize/tools-list 500。
  let plan: InstancePlan;
  try {
    const resolved = deps.resolveSlots(asset.id, slotNames, principal?.userId);
    plan = buildPlan(
      {
        id: asset.id,
        configHash: asset.configHash,
        command: asset.command,
        args: asset.args ?? [],
        env: asset.env ?? {},
        url: asset.url,
        headers: asset.headers ?? {},
        transport: transportOf(asset.type),
        allowInsecureTls: (asset as { allowInsecureTls?: boolean }).allowInsecureTls === true,
        resolveRef: deps.resolveRef,
        credentialSlots: (asset.credentialSlots ?? []) as never,
      },
      resolved,
      deps.runtimeCredsDir,
    );
  } catch (err) {
    violations.push(`${asset.id}: ${err instanceof Error ? err.message : String(err)}（该资产未派生工具）`);
    return [];
  }
  try {
    const handle = await deps.pool.acquire(plan, 'aggregation');
    try {
      const listed = await handle.client.listTools();
      const tools = listed.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: pruneDerivedSchema((t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>),
      }));
      derivedCache.set(cacheKey, { at: Date.now(), tools });
      return tools;
    } finally {
      await handle.release();
    }
  } catch (err) {
    violations.push(`${asset.id}: 实例化失败（${err instanceof Error ? err.message : String(err)}）（该资产未派生工具）`);
    return [];
  }
}

/**
 * 工具名唯一性判定（ADR-032 · P1）。
 *
 * 为什么需要单独一个函数：原生工具是先 `tools.push()` 插进去、派生工具走 `seenByName` 去重，
 * 两条路径互不相识。`office-host-3.58-test` 的 mcp-server-ssh 派生出 `execute_command`，
 * 与原生 `host.execute_command` 映射后同名，于是同一个视图里出现两个 `host_execute_command`。
 * MCP 要求工具名唯一（客户端按名路由，重名行为未定义）。
 *
 * 返回 dropped 时由调用方写进 violations —— 显式失败，不静默丢弃。
 */
export function dedupeToolName(
  seen: Map<string, string>,
  name: string,
  impl: string,
): { action: 'kept' } | { action: 'dropped'; reason: string } {
  const existing = seen.get(name);
  if (existing === undefined) {
    seen.set(name, impl);
    return { action: 'kept' };
  }
  return {
    action: 'dropped',
    reason: `${name}: 工具名重复（已保留 ${existing} 版本，省略 ${impl} 版本）`,
  };
}

export function pruneDerivedSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const pruned: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const desc = String(prop.description ?? '');
    if (key === 'asset') continue;
    if (desc.includes('${')) continue; // 凭证槽位占位符 → 服务端注入
    if (CONNECTION_PARAM_KEYS.has(key)) continue;
    pruned[key] = prop;
  }
  // required 必须跟着 properties 一起裁：只删 properties 会留下一个"必填但无法填"的幽灵参数，
  // 严格客户端会按 schema 校验失败（minio_connect_minio 的 port 就是这样）。
  const required = inputSchema.required as string[] | undefined;
  return {
    ...inputSchema,
    properties: pruned,
    ...(required ? { required: required.filter((k) => k in pruned) } : {}),
  };
}

const DESC_MAX = 200;
const PARAM_DESC_MAX = 80;

/**
 * 按**句子边界**截断到上限（超限时才截，且尽量不截断句子中间）。
 *
 * 为什么不是硬切字符：社区工具描述被 `t.slice(0, max)` 硬切后会出现
 * "...调用时可传 creden…" 这种半个单词，反而降低 LLM 理解质量。
 * 这里优先在句末标点处断开；找不到合适断点时退化为按分句/词组边界，最后才硬切。
 */
export function smartTruncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;

  const budget = max - 1; // 预留省略号
  const head = t.slice(0, budget);

  // ① 句末标点（英文 . ! ? 后跟空格；中文 。！？；）
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('；'),
  );
  // ② 分句（逗号/分号/顿号）
  const clauseEnd = Math.max(
    head.lastIndexOf(', '),
    head.lastIndexOf('; '),
    head.lastIndexOf('，'),
    head.lastIndexOf('、'),
  );
  // ③ 词边界（空格）
  const wordEnd = head.lastIndexOf(' ');

  // 取能保留 ≥60% 内容的最小粒度，避免为了"整齐"丢掉大半句话
  const minKeep = Math.floor(budget * 0.6);
  for (const idx of [sentenceEnd, clauseEnd, wordEnd]) {
    if (idx >= minKeep) {
      return `${head.slice(0, idx).trimEnd().replace(/[,;，、]$/, '')}…`;
    }
  }
  return `${head.trimEnd()}…`;
}

/**
 * 社区 MCP 工具描述规范化（ADR-030 附带的可用性修复）。
 *
 * 为什么需要：Spec §5.5 的 R3/R4/R6 面向**自家原生工具**设计，但校验也施加于社区派生工具。
 * kubernetes-mcp-server / mysql-mcp-server 的原描述普遍超过 200 字、参数描述上百字、
 * 且没有 "Use when:" 段 —— 结果是被 fail-safe 全部剔除，用户看到"资产可见但一个工具都没有"。
 *
 * 做法：保留原始语义（截断而非丢弃），补齐四段式骨架，并把凭证提示并入 Required。
 * 这既满足 R1–R8，又不会让社区工具静默消失。
 */
function normalizeDerivedDescription(raw: string, toolName: string, category: string, credHint: string): string {
  const head = smartTruncate(raw || toolName, DESC_MAX - 120);
  const when = `Use when: 需要执行与 ${category} 相关的「${toolName}」操作时。`;
  const req = `Required: asset 取自 opsgate_list_assets，不要编造。${credHint ? `
${credHint}` : ''}`;
  const text = `${head}
${when}
${req}`;
  // 极端情况下（head 已顶满）再兜一次底，确保必含 R4 两段且 ≤200
  return text.length <= DESC_MAX ? text : smartTruncate(text, DESC_MAX);
}

/** 参数描述规范化：R7 必填 + R6 ≤80 字；枚举参数补"含义"说明 */
function normalizeDerivedSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const rawDesc = typeof prop.description === 'string' ? prop.description : '';
    let desc = smartTruncate(rawDesc || `参数 ${key}`, PARAM_DESC_MAX);
    // R7：枚举参数描述须说明取值含义
    if (Array.isArray(prop.enum) && !/含义|[是指]/.test(desc)) {
      desc = smartTruncate(`${desc}；取值含义见枚举项`, PARAM_DESC_MAX);
    }
    out[key] = { ...prop, description: desc };
  }
  return { ...inputSchema, properties: out };
}


function withAssetParam(inputSchema: Record<string, unknown>, category: string, _derived = false): Record<string, unknown> {
  const properties = (inputSchema.properties ?? {}) as Record<string, unknown>;
  return {
    ...inputSchema,
    properties: {
      ...properties,
      asset: {
        type: 'string',
        description: `目标${category === 'host' ? '主机' : category}资产 id 或 name，取值来自 opsgate_list_assets，不要编造`,
      },
    },
    required: [...((inputSchema.required as string[] | undefined) ?? []), 'asset'],
  };
}

/**
 * 生成 initialize.instructions。四段固定结构：
 *
 * 1. 动态头：身份 + 视图（分组/品类）+ 可见资产台数 + 本连接工具数
 * 2. 动态模式段：仅 platformOnly 时说明「只有平台工具 + 元工具三步走」
 * 3. 动态分组段：分组说明（管理员在分组页维护）
 * 4. 骨架段：`mcp.instructions` 设置值；为空则用 DEFAULT_WORKFLOW_INSTRUCTIONS
 *
 * 前三段都是**事实性信息**（数字、名字），必须由服务端算；只有第 4 段是可以在运行时参数页编辑的
 * 行为约束。把工具数放进第 1 段，是为了让骨架保持纯静态文本——管理员改它时不会留下过期的数字。
 */
export function buildInstructions(
  input: AggregateInput,
  toolCount: number,
  visibleCount: number,
  groupDesc = '',
  workflow = '',
): string {
  const isAll = input.group === 'all';
  const catNote = input.category ? `，且仅限品类 ${input.category}` : '';
  const lines = [
    isAll
      ? `你是 OpsGate 运维助手，当前视图为全部可见资产${catNote}，共 ${visibleCount} 台；本连接共暴露 ${toolCount} 个工具。`
      : `你是 OpsGate 运维助手，当前视图：分组「${input.group}」${catNote}，组内可见资产 ${visibleCount} 台；本连接共暴露 ${toolCount} 个工具。`,
  ];
  if (input.platformOnly) {
    lines.push(
      '',
      '当前**只暴露平台工具**（资产操作工具按需获取，不随连接一次性平铺）。',
      '标准工作流：opsgate_list_assets 找资产 → opsgate_list_asset_tools 看这个资产能做什么、参数怎么填 →',
      'opsgate_invoke(asset, tool, args) 执行。这条路径不依赖客户端刷新工具目录，任何客户端都可用。',
      '如果客户端支持动态工具列表刷新（会消费 notifications/tools/list_changed），也可以改用 opsgate_select_scope',
      '把某个范围（分组/品类/tag）的完整工具集铺开，之后直接以一等公民工具调用。',
    );
  }
  if (groupDesc) {
    lines.push(`分组说明（管理员维护，务必结合理解业务背景）：${groupDesc}`);
  }
  const body = workflow.trim() || DEFAULT_WORKFLOW_INSTRUCTIONS;
  lines.push('', body);
  return lines.join('\n');
}
