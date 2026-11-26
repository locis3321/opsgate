/**
 * L1 系统设置声明式 schema（ADR-024 / Spec §5.10.6）：唯一定义源。
 * DB（system_settings 表）只存偏离默认值的行；无行 = 用本 schema 默认值（零 INSERT 可用，AC-56）。
 * 新增配置项 = 此处加一行（零迁移）；删除配置项 = 删一行，孤儿行在启动期被检出（AC-59）。
 * 注意：不得出现匹配 /audit.*(enable|disable|skip)|accessMode|authorize/i 的 key（AC-58，CI 强制）。
 */

export type SettingValueType =
  | 'int'
  | 'float'
  | 'bool'
  | 'string'
  | 'json'
  | 'duration'
  | 'size';

export type SettingCategory =
  | 'instance_pool'
  | 'ssh_pool'
  | 'tools'
  | 'transfer'
  | 'audit'
  | 'credentials'
  | 'mcp'
  | 'general';

export interface SettingDef {
  /** 命名空间化 key，如 instance_pool.global_budget */
  key: string;
  /** DB 中 value 的存储类型（统一 JSON 编码字符串 + 本标签 + 校验） */
  type: SettingValueType;
  /** 内置默认值（DB 无行时生效） */
  default: unknown;
  /** 数值范围（写入与启动期校验；undefined = 不限） */
  min?: number;
  max?: number;
  /** UI 分区 */
  category: SettingCategory;
  label: string;
  description: string;
  /** 改动后需重启才生效（UI 显示"已保存值 ≠ 当前生效值"） */
  requiresRestart: boolean;
  /** 审计与 UI 掩码（secret 项 value 恒记 ***） */
  secret: boolean;
  /** 枚举型可选值 */
  options?: readonly (string | number)[];
}

/**
 * 内置工作流骨架：作为 mcp.instructions 的默认值。
 *
 * 为什么这段文本是可配置项而不是代码常量：它是**给模型的引导**，不同组织的运维约定不同
 * （有的要双人确认、有的要变更窗口），写死在代码里只能改代码发版。但「先确认再执行高危操作」
 * 这类安全约束一旦被管理员删掉就没有第二道防线，所以 UI 上必须给危险提示（Settings 弹窗）。
 *
 * 只包含**与连接无关**的约束：视图名 / 资产台数 / 工具数 / 分组说明由 buildInstructions 动态前置，
 * 不写在这里（否则改死会变成永久错误信息）。
 */
export const DEFAULT_WORKFLOW_INSTRUCTIONS = `工作流（必须遵守）：
1. 先 opsgate_list_assets 确认目标资产存在且在可见范围内，用返回的 id 作 asset 参数；不要凭记忆编造资产名。
2. 资产不在清单中时直接说明"我无权访问该资产"，不要换名字反复尝试。
3. 删除 / 写入 / 重启 / 变更配置前，先复述目标资产与完整命令，等用户确认后再执行。
4. 同品类的资产共用同一套工具（靠 asset 区分）；一次只处理一个品类的任务，处理完再切下一个品类。
5. 走 opsgate_invoke 时，tool 必须取自 opsgate_list_asset_tools 的返回，args 按其 inputSchema 填且不要带 asset（框架自动注入）。
6. 传文件：先申请一次性入口（5 分钟有效），再用 HTTP PUT/GET 传本体，最后用状态工具确认落位；文件内容不要写进工具参数。
7. 命令输出超过上限会被截断并置 truncated=true；需要完整内容时用 head/tail/分页自行收窄，不要假设拿到的是全部。
8. 错误码含义：-32002 实例忙/超时（缩小范围重试）；-32003 审计不可用（网关为保护而拒绝，重试无用）；-32004 命中安全策略（不要绕过）；-32005 工具数超限（用筛选收窄）；-32006 资产不存在或无权（不要重试）；-32007 文件或暂存超限（分批传输）；-32008 参数校验失败（按 message 修正）。`;

/** 默认值按 Spec §5.10.6 逐字对齐 */
export const SETTINGS_SCHEMA: readonly SettingDef[] = [
  {
    key: 'instance_pool.global_budget',
    type: 'int',
    default: 80,
    min: 1,
    max: 96,
    category: 'instance_pool',
    label: '全局实例预算',
    description: '16GB 部署机上的实例总预算；硬上限 96',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'instance_pool.global_weight_budget',
    type: 'int',
    default: 200,
    min: 1,
    max: 1000,
    category: 'instance_pool',
    label: '全局权重预算',
    description: '加权内存单位：Node 类权重 3 / uvx 类权重 2',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'instance_pool.max_per_asset',
    type: 'int',
    default: 2,
    min: 1,
    max: 4,
    category: 'instance_pool',
    label: '单资产实例数',
    description: '并发降级时允许开的最大实例数',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'instance_pool.queue_per_user',
    type: 'int',
    default: 8,
    min: 1,
    max: 64,
    category: 'instance_pool',
    label: '单用户排队长度',
    description: '超出返回 429',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'instance_pool.global_concurrency',
    type: 'int',
    default: 64,
    min: 1,
    max: 512,
    category: 'instance_pool',
    label: '全局并发调用上限',
    description: '全局信号量；需重启生效',
    requiresRestart: true,
    secret: false,
  },
  {
    key: 'instance_pool.idle_ttl_sec',
    type: 'duration',
    default: 300,
    min: 30,
    max: 3600,
    category: 'instance_pool',
    label: '实例空闲回收 TTL（秒）',
    description: 'active==0 后启动 idle TTL，到期 tree-kill 回收',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'instance_pool.queue_timeout_sec',
    type: 'duration',
    default: 15,
    min: 5,
    max: 120,
    category: 'instance_pool',
    label: '排队超时（秒）',
    description: '超时返回 -32002',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'instance_pool.degrade_wait_sec',
    type: 'duration',
    default: 3,
    min: 1,
    max: 30,
    category: 'instance_pool',
    label: '并发降级等待阈值（秒）',
    description: '等待超过该值且 maxInstances>=2 且预算允许 → 开第二实例',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'ssh_pool.idle_ttl_sec',
    type: 'duration',
    default: 300,
    min: 30,
    max: 3600,
    category: 'ssh_pool',
    label: 'SSH 连接空闲 TTL（秒）',
    description: '原生 SSH 连接池 idle TTL',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'ssh_pool.global_semaphore',
    type: 'int',
    default: 32,
    min: 1,
    max: 256,
    category: 'ssh_pool',
    label: 'SSH 全局信号量',
    description: '全局并发 SSH 连接上限；需重启生效',
    requiresRestart: true,
    secret: false,
  },
  {
    key: 'tools.list_max',
    type: 'int',
    default: 200,
    min: 10,
    max: 500,
    category: 'tools',
    label: '工具列表上限',
    description: 'tools/list 超出返回 -32005，不静默截断',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'tools.output_truncate_bytes',
    type: 'size',
    default: 4096,
    min: 512,
    max: 65536,
    category: 'tools',
    label: '命令输出截断字节数',
    description: 'stdout/stderr 各截断该字节数，置 truncated=true',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'tools.command_timeout_sec',
    type: 'duration',
    default: 30,
    min: 5,
    max: 300,
    category: 'tools',
    label: '命令超时（秒）',
    description: '原生命令执行超时上限',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'tools.schema_token_budget',
    type: 'int',
    default: 15000,
    min: 5000,
    max: 50000,
    category: 'tools',
    label: '全量 schema token 预算',
    description: 'tools/list 全量序列化的 token 预算（CI 断言阈值）',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'native_tools.disabled',
    type: 'json',
    default: [],
    category: 'tools',
    label: '停用原生工具',
    description: '停用的原生工具 id 列表（如 ["host.execute_command"]）；停用即从 tools/list 移除（§5.9.5）',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'cli.member_allowed_binaries',
    type: 'json',
    // 默认覆盖一期实际要用的运维工具（kubectl / mysql / redis-cli / kafka-topics.sh / mc / jq）。
    // 这是**策略值**不是结构契约：不同环境预装的工具不同（有的没有 mc/jq），因此做成 L1 可改。
    default: ['kubectl', 'mysql', 'redis-cli', 'kafka-topics.sh', 'mc', 'jq'],
    category: 'tools',
    label: '成员可建 CLI 二进制白名单',
    description:
      '成员创建 CLI 资产时只允许这些二进制（按 basename 比对，/usr/local/bin/kubectl 视为 kubectl）；管理员不受限。空数组 = 成员不能建任何 CLI 资产',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'transfer.max_file_bytes',
    type: 'size',
    default: 209715200,
    min: 1048576,
    max: 2147483648,
    category: 'transfer',
    label: '单文件传输上限（字节）',
    description: '上传/下载单文件上限 200MB；超出 -32007',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'transfer.entry_ttl_sec',
    type: 'duration',
    default: 300,
    min: 60,
    max: 3600,
    category: 'transfer',
    label: '传输入口 TTL（秒）',
    description: '一次性 transfer token 有效期；过期 401',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'transfer.staging_quota_bytes',
    type: 'size',
    default: 2147483648,
    category: 'transfer',
    label: '暂存配额（字节）',
    description: 'transfer-staging 目录配额 2GB；不足 -32007',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'transfer.staging_ttl_sec',
    type: 'duration',
    default: 900,
    min: 60,
    max: 86400,
    category: 'transfer',
    label: '暂存清理 TTL（秒）',
    description: '暂存目录超期清理周期',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'audit.retention_months',
    type: 'int',
    default: 6,
    min: 1,
    max: 60,
    category: 'audit',
    label: '审计保留期（月）',
    description: '超期自动清理，默认 6 个月（约 180 天）',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'audit.arg_truncate_bytes',
    type: 'size',
    default: 4096,
    min: 512,
    max: 65536,
    category: 'audit',
    label: '审计入参截断字节数',
    description: '工具入参截断长度',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'credentials.max_slots',
    type: 'int',
    default: 32,
    min: 1,
    max: 64,
    category: 'credentials',
    label: '凭证槽位上限',
    description: '单个资产可绑定的凭证槽位数量',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'general.credential_user_warn_threshold',
    type: 'int',
    default: 5,
    min: 1,
    max: 100,
    category: 'general',
    label: '凭证使用者告警阈值',
    description: '实际使用人数达到该值告警',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'general.npm_registry',
    type: 'string',
    default: 'https://repo.huaweicloud.com/repository/npm/',
    category: 'general',
    label: 'npm 镜像源',
    description: '注入 MCP 子进程的 npm_config_registry（npx 拉包走该源）；留空则不注入',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'general.pypi_index_url',
    type: 'string',
    default: 'https://repo.huaweicloud.com/repository/pypi/simple',
    category: 'general',
    label: 'PyPI 镜像源',
    description: '注入 MCP 子进程的 UV_INDEX_URL / PIP_INDEX_URL（uvx/pip 走该源）；留空则不注入',
    requiresRestart: false,
    secret: false,
  },
  {
    key: 'mcp.instructions',
    type: 'string',
    default: DEFAULT_WORKFLOW_INSTRUCTIONS,
    category: 'mcp',
    label: 'MCP 工作流引导',
    description:
      '每个 MCP 连接的 initialize.instructions 正文（Markdown）。视图名、资产台数、本连接工具数、分组说明由服务端自动生成并置于其上；此处只管工作流约束本身。留空或恢复默认即用内置版本。下一次建立连接时生效',
    requiresRestart: false,
    secret: false,
  },
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(
  SETTINGS_SCHEMA.map((def) => [def.key, def]),
);
