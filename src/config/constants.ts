/**
 * L2 结构契约（ADR-024）：协议形状 / 正则 / 错误码 / 加密格式。
 * 这些是契约 —— 改了就是改代码，UI 不可改（project-rules.md §11）。
 * 策略值一律走 L1 settingsSchema.ts（settings.get()）；L0 见 bootstrap.ts。
 */

/** 错误码唯一清单（project-facts.md §5），不得自造码 */
export const ERROR_CODES = {
  /** 实例忙 / 排队超时（SSH 连接复用此码） */
  instanceBusy: -32002,
  /** 审计不可用 → 拒绝调用（write-ahead 失败，无降级旁路） */
  auditUnavailable: -32003,
  /** 被 kind=block 规则拒绝（返回 ruleId + ruleName，不含 pattern） */
  ruleBlocked: -32004,
  /** 分组工具数超限（需 ?tag= 收窄） */
  tooManyTools: -32005,
  /** 资产不存在或无权（两者不区分，防探测） */
  assetNotFoundOrDenied: -32006,
  /** 文件超出大小限制 / 暂存配额不足 */
  transferLimit: -32007,
  /** 配置校验失败（越界 / 类型不符，不落库） */
  settingsInvalid: -32008,
  /** 无 Bearer key */
  unauthorized: 401,
  /** 未注册路径或未授权 */
  forbidden: 403,
  /** 业务校验失败 */
  badRequest: 400,
  /** 单用户排队超限 */
  tooManyRequests: 429,
} as const;

/** 凭证槽位占位符（§5.3）：整值等于 ${NAME} 时视为"该值就是槽位" */
export const SLOT_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** 值内嵌占位符扫描：`Bearer ${TOKEN}`、`http://${HOST}/mcp` 这类写法同样算槽位（每处都要注入） */
export const SLOT_PLACEHOLDER_SCAN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 凭证引用（用户 2026-10-22 决策）：ref.<凭证名>.<键名> —— 配置值直接按名引用凭证的键，一个凭证可服务多个资产 */
export const REF_RE = /^ref\.([A-Za-z0-9_.-]+)\.([A-Za-z_][A-Za-z0-9_]*)$/;

export function parseRef(value: string): { name: string; key: string } | null {
  const m = REF_RE.exec(value);
  return m ? { name: m[1]!, key: m[2]! } : null;
}

/** 敏感键启发式（§5.3 / §4.6）：key 命中即视为凭证槽位 / 敏感值 */
export const SENSITIVE_KEY_RE = /secret|token|password|api_key|private_key|passwd|credential/i;

/** 审计入参脱敏 key 正则（§4.5）：命中值替换为 *** */
export const AUDIT_REDACT_RE = /password|secret|token|key|passwd|credential/i;
export const AUDIT_REDACT_REPLACEMENT = '***';

/** 凭证加密（§5.6）：AES-256-GCM，格式 v1.<iv>.<tag>.<ciphertext>（均 base64），AAD = credentialId */
export const CREDENTIAL_CIPHER_FORMAT = 'v1.<iv>.<tag>.<ciphertext>';

/** 审计分表命名（§4.5）：audit_log_YYYY_MM，按月 */
export const AUDIT_TABLE_PREFIX = 'audit_log_';

/** 文件传输（§4.4）：一次性 token 32B 随机，不是 API Key */
export const TRANSFER_TOKEN_BYTES = 32;

/** Agent API Key 前缀（§4.4）：ogk_live_<base64url 32B>；明文只签发时展示一次 */
export const API_KEY_PREFIX = 'ogk_live_';

/** 文件传输暂存目录名（§4.4）：<data>/transfer-staging/（0700） */
export const TRANSFER_STAGING_DIRNAME = 'transfer-staging';

/** 一次完整上传的审计事件数为 3（§4.5）：request intent → 传输完成 → 落位完成 */
export const UPLOAD_AUDIT_EVENT_COUNT = 3;

/** 凭证槽位结构（§4.6）：仅四字段 */
export const SLOT_FIELDS = ['target', 'name', 'label', 'file'] as const;

/**
 * 实例键构成（§5.4，T6 实例池实现）：
 * instanceKey = hash(serverId + configHash + sorted([(slotName, credentialId, credentialUpdatedAt)]))
 * 键里是凭证指纹而不是用户 ID —— 20 人复用同一套资产+凭证 → 复用同一实例。
 */
export const INSTANCE_KEY_PLAN = 'hash(serverId + configHash + sorted([(slotName, credentialId, credentialUpdatedAt)]))';

/**
 * 凭证类型字典（T5 数据驱动）：新增形态只改此处，前端经 GET /credentials/types 读取，不改前端代码。
 * 这是**结构的单一真值源**（L2）：`kind` 同时是落库值与表单形态选择；
 * `fields` 决定输入表单，`slots` 说明该类型可匹配的槽位键（供前端做"键名不命中"解释）。
 * env-values 保留为兜底（任意键值对），新增自定义类型不得与之重名。
 */
export const CREDENTIAL_TYPES = [
  {
    kind: 'user_password',
    label: '账号密码',
    description: '主机地址(可选) + 用户名(可选) + 密码；资产槽位 host/username/password 分别绑定本凭证的对应键',
    keys: ['host', 'username', 'password'],
    fields: [
      { key: 'host', label: '主机地址', placeholder: '如 10.0.0.1 或 db.example.com', optional: true },
      { key: 'username', label: '用户名', placeholder: '如 ro', optional: true },
      { key: 'password', label: '密码', placeholder: '写入槽位 password', secret: true },
    ],
  },
  {
    kind: 'ak_sk',
    label: 'AK/SK',
    description: '云厂商访问密钥；槽位 access_key / secret_key',
    keys: ['access_key', 'secret_key'],
    fields: [
      { key: 'access_key', label: 'Access Key', placeholder: 'AK…', secret: true },
      { key: 'secret_key', label: 'Secret Key', placeholder: 'SK…', secret: true },
    ],
  },
  {
    kind: 'api_key',
    label: 'API Key',
    description: '单个 Bearer 密钥；槽位 API_KEY',
    keys: ['API_KEY'],
    fields: [{ key: 'API_KEY', label: 'API Key', placeholder: 'sk-…', secret: true }],
  },
  {
    kind: 'token',
    label: 'Token',
    description: '单个令牌；槽位 TOKEN',
    keys: ['TOKEN'],
    fields: [{ key: 'TOKEN', label: 'Token', placeholder: 'eyJ…', secret: true }],
  },
  {
    kind: 'kubeconfig',
    label: 'Kubeconfig',
    description: 'kubeconfig 文件内容；键名命中 → 槽位 file:true，注入为 0600 临时文件并写入 KUBECONFIG 环境变量',
    keys: ['kubeconfig'],
    fields: [{ key: 'kubeconfig', label: 'kubeconfig 内容（YAML）', placeholder: 'apiVersion: v1\nkind: Config\n…', textarea: true, secret: true }],
  },
  {
    kind: 'ssh_key',
    label: 'SSH 私钥',
    description: '私钥 + 登录用户名（可带口令）；资产的 authSlot 指向它；用户名随凭证走，换资产不必重填；口令在资产上另设口令槽位(authPassSlot)并绑定本凭证的 passphrase 键',
    keys: ['AUTH', 'username', 'passphrase'],
    fields: [
      { key: 'AUTH', label: '私钥内容（PEM/OPENSSH）', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----…', textarea: true, secret: true },
      { key: 'username', label: '登录用户名', placeholder: '如 root 或 deploy', optional: true, hint: '留空则使用资产上配置的用户名' },
      { key: 'passphrase', label: '口令', placeholder: '私钥口令', optional: true, secret: true },
    ],
  },
  {
    kind: 'redis_password',
    label: 'Redis 密码',
    description: '单密码；槽位 REDIS_PASSWORD',
    keys: ['REDIS_PASSWORD'],
    fields: [{ key: 'REDIS_PASSWORD', label: '密码', placeholder: 'redis 密码', secret: true }],
  },
  {
    kind: 'env-values',
    label: '自定义键值对（JSON）',
    description: '任意命名值集合（原 JSON 入口保留为兜底）',
    keys: [],
    fields: [],
  },
] as const;

/** 合法 kind 清单（落库校验用；由 CREDENTIAL_TYPES 派生，避免两处漂移） */
export const CRED_KINDS = CREDENTIAL_TYPES.map((t) => t.kind);

/**
 * 治理类审计动作（管理后台操作：可见性 / 凭证 / 分组 / 规则库 / 原生工具 / 系统设置 / 资产管理）。
 * 其余动作（tool_call / blocked / auth_fail / transfer_*）是**资产的具体操作**。
 * 审计页「日志范围」筛选以此划分（前端镜像同一份清单）。
 * 清单必须覆盖所有 governanceAudit / ruleAudit 写入点 —— 漏一个就会把管理操作误分到资产操作。
 */
export const GOVERNANCE_ACTIONS = [
  'visibility_change',
  'credential_bind',
  'credential_unbind',
  'credential_rotate',
  'credential_reveal',
  'group_change',
  'update_group',
  'delete_group',
  'set_metadata',
  'delete_metadata',
  'remove_member',
  'guard_rule_change',
  'native_tool_toggle',
  'system_setting',
  'asset_create',
  'asset_prewarm',
  'asset_tool_filters',
  'asset_enabled_change',
  'remove_asset',
] as const;
