/**
 * Drizzle schema（Spec §4 数据模型，唯一类型来源）。
 * 约定（project-rules.md §5）：时间 integer(Unix ms)；布尔 integer(0/1)；
 * JSON 字段存 JSON 字符串；审计按月分表 audit_log_YYYY_MM（动态，见 audit.ts）。
 * 注意：credentials 表**没有** visibility / shared_with_user_ids（ADR-020 / AC-26）。
 */
import { randomUUID } from 'node:crypto';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core';

const pkId = () => text('id').primaryKey().$defaultFn(() => randomUUID());
const now = () => new Date();
const ts = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now);

/** users：本地账号，两态身份（管理员/成员），无角色矩阵（project-rules §1）
 *  Spec §4 未列字段明细（ER §4.8 + §7 /users），按事实推导；name/email_verified/image
 *  为 better-auth 核心字段映射（T3 决策），username 供 username 插件登录。 */
export const users = sqliteTable('users', {
  id: pkId(),
  /** better-auth 显示名（核心字段 name 映射） */
  name: text('name'),
  username: text('username').notNull().unique(),
  email: text('email'),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  /**
   * 禁用标记（ADR-028 §2.5）：只阻断 Web UI 登录，**不阻断** MCP 调用。
   * agent 通道是独立凭证（API Key），禁用成员不等于吊销其已签发的 Key。
   */
  isDisabled: integer('is_disabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: ts(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now).$onUpdate(now),
});

/** api_keys（§4.4）：审计归属键 = user_id；key_hash 存 SHA-256，明文只签发时展示一次 */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: pkId(),
    name: text('name').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    keyHash: text('key_hash').notNull(),
    clientName: text('client_name'),
    /** 固定 ["mcp:invoke"] */
    scopes: text('scopes', { mode: 'json' }).notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('api_keys_user_id_idx').on(t.userId)],
);

/** servers 资产（§4.1）：单实体。execution_mode='native' 仅 category='host' 可为且为默认 */
export const servers = sqliteTable(
  'servers',
  {
    id: pkId(),
    /** DNS-1123 子域规范，如 web-mysql-01 */
    name: text('name').notNull().unique(),
    displayName: text('display_name'),
    description: text('description'),
    /** stdio | http | sse | native */
    type: text('type').notNull(),
    /** native = 进程内直连（SSH/SFTP）；mcp = 代理社区实现走实例池 */
    executionMode: text('execution_mode').notNull(),
    /** host | mysql | k8s | other */
    category: text('category').notNull(),
    /** 仅 execution_mode='native' 有效：{host, port, username, authSlot, jumpHostSlot?} */
    hostConn: text('host_conn', { mode: 'json' }),
    tags: text('tags', { mode: 'json' }).notNull().$defaultFn(() => []),
    /** fail-closed：默认 0，按资产显式开启（ADR-016 / AC-20） */
    allowPrivateNetwork: integer('allow_private_network', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * 允许不安全 TLS（自签证书）：仅按资产显式开启，默认 0（fail-closed）。
     * 影响两类连接：HTTP 型资产的 fetch、stdio 子进程的 NODE_TLS_REJECT_UNAUTHORIZED。
     * 开启后对中间人攻击无防护——必须由归属人显式授权并写治理审计。
     */
    allowInsecureTls: integer('allow_insecure_tls', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** 社区原生配置快照（execution_mode='mcp'） */
    command: text('command'),
    args: text('args', { mode: 'json' }),
    env: text('env', { mode: 'json' }),
    url: text('url'),
    headers: text('headers', { mode: 'json' }),
    /** [{target:'env', name, label, file}]，≤32 个（credentials.max_slots） */
    credentialSlots: text('credential_slots', { mode: 'json' }).notNull().$defaultFn(() => []),
    /** 归属人；成员被删除后置 NULL（资产保留，等 admin 重新分配，ADR-028 §2.5） */
    ownerId: text('owner_id')
      .references(() => users.id),
    /** owner | group | public */
    visibility: text('visibility').notNull().default('owner'),
    sharedWithUserIds: text('shared_with_user_ids', { mode: 'json' })
      .notNull()
      .$defaultFn(() => []),
    /** {enabledTools:[], disabledTools:[]} 或 null */
    toolFilters: text('tool_filters', { mode: 'json' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** keep-warm 白名单 */
    prewarm: integer('prewarm', { mode: 'boolean' }).notNull().default(false),
    /** sha256(规范化配置)，实例键组成部分 */
    configHash: text('config_hash').notNull(),
    /** 来源 Market 目录条目 key（ADR-025）：仅徽章/重复检测，运行时不读 */
    marketKey: text('market_key'),
    createdAt: ts(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now).$onUpdate(now),
  },
  (t) => [
    index('servers_owner_id_idx').on(t.ownerId),
    index('servers_visibility_idx').on(t.visibility),
  ],
);

/**
 * market_entries：Market 目录条目（ADR-029，取代 ADR-025「静态 JSON 不落库」）。
 * 字段与 `services/marketCatalog.ts` 的 `CatalogEntry` 一一对应——落库后仍能构造出
 * 同一形状，`detectSlots` / `expandConfig` / `injectSlots` 与实例化逻辑无需改动。
 * Market 仍是**创建期模板**：实例化后配置快照固化到 servers，本表不参与 tools/call。
 */
export const marketEntries = sqliteTable(
  'market_entries',
  {
    key: text('key').primaryKey(),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description').notNull(),
    repository: text('repository').notNull(),
    /** JSON string[]（一条目可属多个分类） */
    categories: text('categories', { mode: 'json' }).notNull().$type<string[]>(),
    /** JSON string[] */
    tags: text('tags', { mode: 'json' }).notNull().$type<string[]>(),
    /** npm | pypi */
    runtime: text('runtime').notNull(),
    /** JSON Record<string,string> | null */
    slotLabels: text('slot_labels', { mode: 'json' }).$type<Record<string, string> | null>(),
    /** JSON string[] | null：**已废弃**（2026-11-17 取消槽位必填，全部槽位未绑定都不再拦截）。
     *  列保留是因为删除列属于 DDL；代码不再读写它。 */
    optionalSlots: text('optional_slots', { mode: 'json' }).$type<string[] | null>(),
    /**
     * 默认分组名：从该条目创建的资产自动加入此分组（不存在则自动创建）。
     * 分组本身仍是自由组织单元（ADR-026 不自动按 category 归组），
     * 这里只是把"模板作者希望的默认归属"显式声明在条目上，由管理员维护。
     */
    defaultGroup: text('default_group'),
    /** JSON Record<runtime, {command?,args?,env?,url?,headers?}> */
    installations: text('installations', { mode: 'json' }).notNull(),
    /** draft | verified | disabled（ADR-029 §2 状态机） */
    status: text('status').notNull(),
    /**
     * 执行分层（ADR-022 扩展）：`mcp`（默认，代理社区实现，走实例池）|
     * `native`（网关内建 HTTP 工具，无子进程；管理 API 地址由用户建资产时填写）。
     * 用 DB 级 default，重建表时不会丢默认值。
     */
    executionMode: text('execution_mode').notNull().default('mcp'),
    /** README 源地址（PyPI/npm/GitHub 页面 URL） */
    readmeUrl: text('readme_url'),
    /** README 内容缓存（markdown） */
    readmeCache: text('readme_cache'),
    readmeFetchedAt: integer('readme_fetched_at', { mode: 'timestamp_ms' }),
    /** 锁定版本（含于 installations 的 args 中，此处单列供版本比对） */
    versionPinned: text('version_pinned'),
    /** 上游检测到的最新版本 */
    versionLatest: text('version_latest'),
    createdAt: ts(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now).$onUpdate(now),
  },
  (t) => [index('market_entries_status_idx').on(t.status)],
);

/** credentials（§4.2）：创建者私有资源，**无 visibility / shared_with_user_ids**（ADR-020）
 *  ADR-028 恢复按分组的共享（credential_group_shares），并新增 privileges 等级标签。
 *  updated_at 变化 → 全部绑定资产的实例失效重建（轮换副作用）。 */
export const credentials = sqliteTable(
  'credentials',
  {
    id: pkId(),
    name: text('name').notNull().unique(),
    /** 仅 env-values（命名值集合） */
    kind: text('kind').notNull().default('env-values'),
    /** v1.<iv>.<tag>.<ciphertext>（AES-256-GCM，AAD=credentialId，§5.6） */
    encryptedValues: text('encrypted_values').notNull(),
    /** 末 4 位掩码，如 ****abcd */
    valueHint: text('value_hint').notNull(),
    /** 权限等级标签（root/rw/wo/ro，可多选）：**仅展示性元信息**，不参与任何授权判定（ADR-028）。
     *  用 DB 级 `.default()` 而非 `$defaultFn`：重建表（如 0007 放开 owner_id）时会保留默认值，
     *  否则 drizzle-kit 生成的新表会丢 DEFAULT，导致不带该列的 INSERT 失败。 */
    privileges: text('privileges', { mode: 'json' }).notNull().$type<string[]>().default([]),
    /** 归属人：仅 owner + 平台 admin 可改值/轮换/删除 */
    /** 归属人；成员被删除后置 NULL（资产保留，等 admin 重新分配，ADR-028 §2.5） */
    ownerId: text('owner_id')
      .references(() => users.id),
    createdAt: ts(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now).$onUpdate(now),
  },
  (t) => [index('credentials_owner_id_idx').on(t.ownerId)],
);

/**
 * credential_group_shares（ADR-028）：凭证 → 分组的共享开关。
 * 存在即共享；拥有者按分组逐个开关，未列入的行 = 未共享（不默认跨组分享）。
 */
export const credentialGroupShares = sqliteTable(
  'credential_group_shares',
  {
    credentialId: text('credential_id')
      .notNull()
      .references(() => credentials.id),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.credentialId, t.groupId] })],
);

/**
 * server_credentials（§4.3 / ADR-028）：槽位 → 凭证绑定。
 * 主键含 `user_id`：同一资产同一槽位可由 owner 与多个成员各自绑定（一槽多凭证）。
 * `scope` 区分来源：`asset` = 资产归属人绑定（整组可用）；`personal` = 成员自己绑定（仅本人）。
 */
export const serverCredentials = sqliteTable(
  'server_credentials',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id),
    slotName: text('slot_name').notNull(),
    /** 绑定者；asset scope 为该资产的 ownerId，personal scope 为成员本人 */
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    credentialId: text('credential_id')
      .notNull()
      .references(() => credentials.id),
    /** asset = 共享给该资产的使用者 | personal = 仅绑定者本人可用（由绑定时的共享复选框决定） */
    scope: text('scope').notNull().default('personal'),
    /** 区分名（如 "root 账号"），可空 */
    label: text('label'),
    /**
     * 该条绑定使用的 SSH 登录用户名（可空）。只在 native host 链路上生效。
     * 优先级：绑定 username > 凭证 username 键 > 资产 host_conn.username。
     * 放在绑定上而不是资产上，是因为「root 凭证 + dev 凭证」同槽并存时账号随之不同。
     */
    username: text('username'),
    /**
     * 该绑定从凭证里取哪个键（可空，ADR-031）。
     * NULL = 按槽位名匹配（键名完全一致或归一化后一致）；有值 = 精确取该键。
     * 不再有「单键兜底」「敏感别名兜底」——那两级是猜，AUTH_PASS 与 passphrase 就是猜不到的典型。
     */
    credentialKey: text('credential_key'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [
    // 主键含 credential_id：同一人可在同一槽位同时持有 root(personal) 与 dev(asset) 两套凭证。
    // 原三列主键让同槽同人只能存一条，实际表现是「追加绑定 = 换绑」，问题 11 的根本卡点。
    primaryKey({ columns: [t.serverId, t.slotName, t.userId, t.credentialId] }),
    index('server_credentials_user_id_idx').on(t.userId),
    index('server_credentials_credential_id_idx').on(t.credentialId),
  ],
);

/**
 * server_slot_values：资产自带的槽位直填值（ADR-027）。
 * 与 credentials **无关**：直填值是资产自己的密钥，不进凭证列表、不属于任何凭证、
 * 不参与"凭证=创建者私有资源"的模型；只加密存于本资产，随资产删除而删除。
 * 与 server_credentials 互斥：同一槽位要么绑定凭证，要么有直填值（写入侧保证）。
 */
export const serverSlotValues = sqliteTable(
  'server_slot_values',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id),
    slotName: text('slot_name').notNull(),
    /** v1.<iv>.<tag>.<ciphertext>（AES-256-GCM，AAD=slot:<serverId>:<slotName>） */
    encryptedValue: text('encrypted_value').notNull(),
    /** 明文值的 sha256 前 16 位（实例键构成用；非明文，不可逆） */
    valueFingerprint: text('value_fingerprint').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.slotName] })],
);

/** groups（§4.8）：自由组织单元，管理员按需创建（ADR-026），不预置 */
export const groups = sqliteTable('groups', {
  id: pkId(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: ts(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now).$onUpdate(now),
});

export const groupServers = sqliteTable(
  'group_servers',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.serverId] })],
);

export const groupUsers = sqliteTable(
  'group_users',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/** group_metadata（§4.8 扩展）：分组自定义 KV 元信息，同组内 key 唯一 */
export const groupMetadata = sqliteTable(
  'group_metadata',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.key] })],
);

/** guard_rules（§4.7）：WAF 式规则库，mark/block 一张表一个引擎 */
export const guardRules = sqliteTable('guard_rules', {
  id: pkId(),
  name: text('name').notNull(),
  /** mark（打 risk=high）| block（拒绝调用 -32004） */
  kind: text('kind').notNull(),
  /** tool | arg | body | asset_type | group —— **匹配维度**（拿什么去匹配），与 scope 正交。
   *  arg 只看参数值（递归展开嵌套），body 看整份序列化请求体（含键名）。 */
  target: text('target').notNull(),
  /**
   * 作用域（2026-11-18）：`global` 全部资产 | `asset_type` 指定品类 | `asset` 指定资产。
   * 与 target 的区别：scope 决定"对哪些资产生效"，target 决定"拿什么去匹配"。
   */
  scope: text('scope').notNull().default('global'),
  /** scope=asset_type → JSON 品类名数组；scope=asset → JSON 资产 id 数组；global → null */
  scopeValue: text('scope_value', { mode: 'json' }).$type<string[] | null>(),
  /** 规则创建者；内置规则为 null（系统） */
  ownerId: text('owner_id'),
  /** builtin | admin | owner —— 来源锁定依据：owner 不可改/删/停用 admin 与 builtin 规则 */
  source: text('source').notNull().default('builtin'),
  /** 正则，必须线性无回溯（禁止嵌套量词/回溯引用，入库前 safe-regex2 校验） */
  pattern: text('pattern').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** 命中多条取优先级最高 */
  priority: integer('priority').notNull().default(0),
  /** 1 = 内置规则（来源标记；2026-11-17 起管理员可改删，责任归管理员） */
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  hitCount: integer('hit_count').notNull().default(0),
  lastHitAt: integer('last_hit_at', { mode: 'timestamp_ms' }),
  description: text('description'),
});

/** system_settings（§5.10.2）：配置字典，DB 只存偏离默认值的行（不播种，AC-56） */
export const systemSettings = sqliteTable('system_settings', {
  /** 命名空间化 key，如 instance_pool.global_budget */
  key: text('key').primaryKey(),
  /** 统一 JSON 编码字符串 */
  value: text('value').notNull(),
  /** int | float | bool | string | json | duration | size */
  valueType: text('value_type').notNull(),
  /** UI 分区：instance_pool | ssh_pool | tools | transfer | audit | credentials | general */
  category: text('category').notNull(),
  /** 内置默认值快照（UI 显示与"恢复默认"） */
  defaultValue: text('default_value').notNull(),
  minValue: integer('min_value'),
  maxValue: integer('max_value'),
  options: text('options', { mode: 'json' }),
  isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
  requiresRestart: integer('requires_restart', { mode: 'boolean' }).notNull().default(false),
  updatedBy: text('updated_by').references(() => users.id),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
});

/** audit_stats_hourly（§4.6）：预聚合，仅概览页查询 */
export const auditStatsHourly = sqliteTable(
  'audit_stats_hourly',
  {
    hourTs: integer('hour_ts').notNull(),
    assetId: text('asset_id').notNull(),
    callCount: integer('call_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    blockedCount: integer('blocked_count').notNull().default(0),
    totalDurationMs: integer('total_duration_ms').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.hourTs, t.assetId] })],
);

/**
 * 审计分表工厂（§4.5 / §4.8）：audit_log_YYYY_MM，按月；跨月查询由 service 层拼接。
 * 迁移只建当月表；运行时按月 ensure（T8）。
 */
export function auditLogTable(tableName: string): SQLiteTable {
  return sqliteTable(
    tableName,
    {
      id: text('id').primaryKey(),
      ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
      userId: text('user_id'),
      username: text('username'),
      apiKeyId: text('api_key_id'),
      clientName: text('client_name'),
      sourceIp: text('source_ip'),
      serverId: text('server_id'),
      serverName: text('server_name'),
      credentialId: text('credential_id'),
      tool: text('tool'),
      /** tool_call | blocked | auth_fail | credential_rotate | credential_bind | visibility_change | group_change | server_toggle */
      action: text('action').notNull(),
      /** normal | high（kind=mark 命中判定） */
      risk: text('risk'),
      /** 入库前已脱敏 */
      inputSummary: text('input_summary'),
      /** pending → success | error | blocked | unknown */
      status: text('status'),
      outputSummary: text('output_summary'),
      durationMs: integer('duration_ms'),
      errorMessage: text('error_message'),
    },
    (t) => [
      index(`${tableName}_ts_idx`).on(t.ts),
      index(`${tableName}_user_ts_idx`).on(t.userId, t.ts),
      index(`${tableName}_server_ts_idx`).on(t.serverId, t.ts),
      index(`${tableName}_status_ts_idx`).on(t.status, t.ts),
      index(`${tableName}_tool_ts_idx`).on(t.tool, t.ts),
    ],
  );
}
