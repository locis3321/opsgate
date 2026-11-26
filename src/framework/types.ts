/**
 * 原生工具扩展框架契约（ADR-023 / Spec §5.9）。
 * 两层正交：Connector（协议，少而稳定）× Tool（能力，多而演进）。
 * 工具作者只写 execute + schema + 声明；鉴权/审计/规则/连接/截断由框架（dispatch.ts）承担。
 */
export type RiskLevel = 'read' | 'write' | 'destructive';
/**
 * 内置品类的「已知前缀」清单（ADR-032）。
 *
 * **不再是白名单**：品类集合来自实际数据（`servers.category` ∪ `market_entries.categories`），
 * 新增品类（ES / Kafka / Prometheus / Baota / MinIO …）无需改代码即可用 `?category=` 收窄。
 * 本常量保留的唯一用途是给内置原生工具与默认分组提供类型边界，校验逻辑不得再引用它。
 */
export const BUILTIN_CATEGORIES = ['host', 'mysql', 'k8s', 'other', 'zabbix', 'rocketmq', 'nacos', 'redis', 'kafka'] as const;
export type BuiltinCategory = (typeof BUILTIN_CATEGORIES)[number];
/** @deprecated 用 BUILTIN_CATEGORIES；保留别名避免一次性改动过大，校验处已改为动态品类 */
export const TOOL_CATEGORIES = BUILTIN_CATEGORIES;
export type ToolCategory = BuiltinCategory;

/**
 * 内置品类的默认分组名：手工创建的资产按品类自动入组，避免"建完资产在分组视图里找不到"。
 *
 * 与 ADR-026「分组不按 category 自动归组」的关系：ADR-026 反对的是**把分组语义等同于品类**，
 * 导致一个资产只能属于 host/mysql/k8s 之一而无法按环境/业务线组织。默认分组只是
 * **初始归属**（用户随后可自由加入其它分组、也可移出），不构成任何调用权限约束。
 * `other` 不设默认分组——它没有可推断的归属。
 */
export const DEFAULT_GROUP_BY_CATEGORY: Partial<Record<ToolCategory, string>> = {
  host: 'host',
  mysql: 'mysql',
  k8s: 'k8s',
  zabbix: 'zabbix',
  rocketmq: 'rocketmq',
  nacos: 'nacos',
  redis: 'redis',
  kafka: 'kafka',
};
export type SlotTarget = 'env' | 'args' | 'headers';

export interface CredentialSlot {
  target: SlotTarget;
  name: string;
  label: string;
  file: boolean;
}

export interface HostConn {
  host: string;
  port: number;
  username: string;
  authSlot?: string;
  /** 私钥口令槽位（Spec §4.3 多槽位）：仅在私钥认证时出现，槽位里绑的凭证取 passphrase 键 */
  authPassSlot?: string;
  jumpHostSlot?: string;
  hostFingerprint?: string;
}

/** 资产执行方式：内置原生工具 / MCP 服务器 / CLI 二进制直执行（argv，不经 shell） */
export type ExecutionMode = 'native' | 'mcp' | 'cli';

/** 资产视图（由 T8 assetService 解析后注入；工具只见白名单字段） */
export interface AssetView {
  id: string;
  name: string;
  category: string;
  /** 归属人（can()/写入侧同主校验用）；成员被删除后为 null（无主，仅 admin 可用） */
  ownerId: string | null;
  executionMode: ExecutionMode;
  hostConn?: HostConn | null;
  url?: string | null;
  /** 关闭 TLS 证书校验（仅该资产显式开启；见 servers.allow_insecure_tls） */
  allowInsecureTls?: boolean;
  env?: Record<string, unknown> | null;
  args?: unknown[] | null;
  headers?: Record<string, unknown> | null;
  credentialSlots: CredentialSlot[];
  configHash: string;
}

/** 审计抽取声明（§5.9.2 AuditSpec） */
export interface AuditSpec {
  /** 从入参抽取的字段名（如 command / remote_path） */
  fields?: string[];
  /** 记录命令全文（脱敏后） */
  includeCommand?: boolean;
}

export interface ToolResult {
  /** 主结果（输出截断由框架完成） */
  content: unknown;
  /** 结构化元数据（exit_code / stdout 摘要等，进审计 output_summary） */
  meta?: Record<string, unknown>;
}

export interface NativeToolContext {
  asset: AssetView;
  /** 框架按槽位名注入的解密凭证值 */
  credentials: Record<string, string>;
  /** 调用主体（传输 token 绑定等需要 userId） */
  principal?: { userId: string; isAdmin: boolean };
  /** L1 设置读取（工具不得直接 import config/settings） */
  settings?: { get<T>(key: string): T };
  signal?: AbortSignal;
}

export interface NativeToolDefinition<H = unknown> {
  /** 稳定标识（进审计/规则），如 host.execute_command；生成暴露名 name 的语义来源 */
  id: string;
  category: ToolCategory;
  /** 依赖的 connector（须在 CONNECTOR_REGISTRY 中） */
  connector: string;
  risk: RiskLevel;
  /** 声明从入参/结果抽哪些字段进审计 */
  audit: AuditSpec;
  /** 暴露名，强制 {category}_ 前缀（R1） */
  name: string;
  /** 四段式描述（§5.5.3 R1–R8） */
  description: string;
  /** JSON Schema，**不含 asset**（由框架注入 asset 参数） */
  inputSchema: Record<string, unknown>;
  execute(ctx: NativeToolContext & { handle: H }, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface PoolStats {
  active: number;
  idle: number;
  total: number;
}

/** 调用主体（框架在 acquire 阶段透传给 connector，用于按调用者解析凭证） */
export interface CallerPrincipal {
  userId: string;
  isAdmin: boolean;
}

/** Connector 契约（§5.9.1，逐字） */
export interface Connector<H = unknown> {
  type: string;
  /**
   * `principal` 可选：只有需要**按调用者取凭证**的 connector 才用得上（SSH）。
   * 不传或为 undefined 表示系统级路径（无"谁在调用"），此时按 asset 共享凭证解析。
   */
  acquire(asset: AssetView, credentialRef: string, principal?: CallerPrincipal): Promise<H>;
  release(h: H): void;
  invalidate(assetId: string): void;
  stats(): PoolStats;
}

/** 内部账户小助手：从 asset + 槽位拆出连接参数（connector 实现用） */
export function slotCredential(asset: AssetView, slotName: string): string | undefined {
  return asset.credentialSlots.find((s) => s.name === slotName)?.name;
}
