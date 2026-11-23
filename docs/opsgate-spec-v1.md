# OpsGate v1 产品规格与技术设计

> 状态：**待用户确认**（本文件是与用户的唯一正式交互点，确认后冻结为开发基线）
> 日期：2026-10-20
> 参考实现：`D:/work/mcphub-ref`（Apache-2.0，Node/Express/TS + React/Vite/Tailwind，268 源文件）
> 历史决策链：v0 的 D1–D36 决策记录随旧文档一并删除（2026-10-20）；**业务语义层已被本文 §1「已确认决策」与文末 ADR-001～023 完整吸收并取代**，工程层随技术栈变更整体失效。需要回溯原文时用 `git show <旧提交>:docs/mcp-gateway-design.md`。
> 本文档是**唯一权威**：与任何历史文档冲突时以本文为准，不存在第二实现依据。

---

## 0. 这一版为什么推倒重来

上一版失败的根因不是功能不够，而是**模型复杂度压过了使用价值**。逐条对应：

| 上版问题 | 本版的答案 | 落点 |
|---|---|---|
| MCP 添加复杂度高，要手写配置 | 内置 Market 目录，选中即展开为资产（**v1 必修，ADR-025**） | §5.3 |
| Server 需映射 JSON Schema 到资产 | 用 `${VAR}` 占位符自动识别凭证槽位，无 Schema 编辑器 | §5.3 |
| 资产 × MCP 目录 × 凭证三实体过复杂 | 收敛为 **Server（= 一条完整社区原生 MCP 配置）+ Credential（可共享）** 两个实体，Market 仅作创建期模板 | §3、§4 |
| 凭证按用户私有，不适配运维 | **凭证是共享资源**，多人共用同一凭证，审计记到人 | §4.4、ADR-004 |
| 技术栈未定 | TypeScript 全栈，单 Node 进程 | §5.1 |
| 334 资产 × 20 人资源爆炸 | 实例键含凭证指纹（20 人乘数消失）+ 按需拉起 + 空闲 TTL + LRU，2GB 内 | §5.4 |

---

## 1. 已确认决策（用户拍板，不可回退）

| # | 决策 | 选择 | 影响 |
|---|---|---|---|
| 1 | 技术栈 | **TypeScript 全栈** | 单进程持有全部 stdio 子进程；MCP 官方 SDK 首发支持；前后端同语言；单容器交付 |
| 2 | MCP 实例生命周期 | **stdio 按需拉起 + 短空闲 TTL** | 不常驻；靠包缓存把冷启动压到 1–3s |
| 3 | 凭证模型 | **按账号共享，审计到人** | 与 mcphub 的 per-user binding 根本分叉 |
| 4 | 可见性与分组 | **分组 + 可见性三态**，分组策略由用户自定 | 分组不承担权限职责，只控制 agent 一次看到多少工具 |
| 5 | API Key | **每人一个 Key** | 审计归属到人 |
| 6 | 审计保留 | **12 个月**（按月分表 + 归档） | |
| 7 | 账号体系 | **本地账号**（不接 LDAP/AD，MVP） | better-auth username+password |

---

## 2. 产品定位与范围

### 2.1 一句话定位

**自托管的 MCP 网关与控制平面：让 AI agent 安全地操作运维资产，且每一次操作都能回答"谁、在几点、用哪个账号、对哪台机器、做了什么"。**

### 2.2 目标场景

企业内部 20 人运维团队，管理 300 台 Linux 主机、30 个 MySQL 实例、4 个 K8s 集群。三类用户：

- **P1 运维工程师**（一线高频）：用 Claude Code / Cursor 等 agent 排障，需要"说一句话就能查"
- **P2 运维主管**（决策者）：怕出授权绕过事故，需要"一眼确认谁能碰什么"
- **P3 安全合规专员**：要追溯、要轮换凭证

### 2.3 三个市场空白（差异化依据）

1. **"团队共享凭证 + 审计精确到人"** 全市场无人提供 —— 通用网关要么 per-user 凭证（mcphub），要么无凭证治理（Docker MCP Gateway）
2. **运维 stdio 规模化**（300 资产、按需拉起/空闲回收/2GB 内存）无产品专门设计
3. **Market + `${VAR}` 槽位一键添加** —— 竞品均要求理解并编辑完整配置

### 2.4 明确不做（8 条，各带原因）

| 不做 | 原因 |
|---|---|
| 角色矩阵（admin/operator/viewer） | 上版失败根源；本模型只有"能看见/能调用/能管理"三动作，无角色概念 |
| JSON Schema 编辑器 | 上版失败点；槽位只需要 `{target, name, label, file}` 四字段 |
| **自研语义级运维能力**（SQL 语义、K8s 资源模型、业务编排） | 语义层交给社区实现，平台不重复造轮子（详见下方 ADR-022 分层原则） |
| 多协议联邦（A2A 等） | 范围外 |
| 每用户私有凭证 | 与运维场景根本冲突 |
| 内置 chat UI / agent 编排 | 客户端由用户自选 |
| 每个 server 容器化隔离 | 资源不可承受；靠实例串行化 + guard_rules 保证安全 |
| emoji 图标 / 紫粉渐变 | 项目级 P0 设计红线 |

> **修订说明（ADR-022）**：原条目写的是"自研运维 MCP server —— 平台不实现运维能力，只代理社区开源 server"。用户决策后收紧为**分层原则**：**协议级原子能力原生实现，语义级能力仍代理社区**。即 SSH 执行 / SFTP 文件上传下载由 OpsGate 自己实现为原生 tool（不走子进程），MySQL / K8s 等仍有语义的品类继续代理社区实现。判据见 §5.5.7。

---

## 3. 核心概念模型（三句话）

1. **Server = 资产 = 一条完整社区原生 MCP 配置**（`command/args/env` 或 `url/headers`）。用户不需要理解抽象，看到的形态和社区文档里一模一样。
2. **Credential = 可共享的命名凭证值集合**，加密存储。资产的配置里有 `${MYSQL_PASSWORD}` 这样的占位符，槽位指向哪个凭证，就是"用哪个账号操作"。
3. **Market = 创建期模板目录**，选中后展开成一个 Server，之后两者彻底解耦 —— Market 不是运行时实体。

4. **执行分两层**：**协议级原子能力原生实现**（SSH 执行 / SFTP 文件传输，网关进程内直连，无子进程），**语义级能力代理社区实现**（MySQL / K8s，走 stdio MCP 实例池）。判据见 §5.5.7。

**为什么分组不承担权限职责**：分组控制的是 **agent 的资产候选集**（`opsgate_list_assets` 返回范围、`asset` 参数的合法取值、instructions 的裁剪范围），而**不是**工具数量 —— 工具数在按品类聚合后已恒定（~28），与资产数无关（§5.5.1）。权限由资产自身的可见性决定，分组策略由用户自定义。

> 说明：这一条在按品类聚合后已改写。旧版写的是"分组的唯一作用是控制 agent 一次看到多少工具（334 资产全量平铺 = 2400+ 工具）"—— 那个前提已不成立。

---

## 4. 数据模型（Drizzle ORM / SQLite WAL）

表清单：`users`、`api_keys`、`servers`、`credentials`、`server_credentials`、**`server_slot_values`（槽位直填值，ADR-027）**、`groups`、`group_servers`、`group_users`、`audit_log_YYYY_MM`、`audit_stats_hourly`、**`system_settings`（配置字典，§5.10）**、`guard_rules`（规则库，§5.8）

### 4.1 servers（资产）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text PK | uuid |
| name | text unique | DNS-1123 子域规范，如 `web-mysql-01` |
| display_name / description | text | |
| type | text | **传输协议**：`stdio`（子进程 stdio）\| `http`（Streamable HTTP）\| `sse`（旧式 SSE）\| **`native`**（原生执行，无子进程）。与 `category`（业务品类）正交：`category` 决定规则匹配维度，`type` 决定实例池 transport |
| **execution_mode** | text | `native` \| `mcp`。`native` = 网关进程内直连（SSH/SFTP，§5.5.7）；`mcp` = 代理社区实现走实例池。**仅 `category='host'` 可为 `native`**，且为该品类的默认值 |
| category | text | `host` \| `mysql` \| `k8s` \| `other`，来自 Market 模板品类；**仅**决定 `asset_type` 规则匹配维度，**不决定分组归属**（ADR-026：分组是自由组织单元） |
| **host_conn** | JSON nullable | 仅 `execution_mode='native'` 时有效：`{host, port:22, username, authSlot, jumpHostSlot?}`。`authSlot` 指向 `server_credentials` 中绑定 SSH 私钥/密码的槽位名（凭证模型完全复用，注入目标从"子进程 env"变为"`ssh2.connect()` 参数"） |
| tags | JSON | 如 `["web","prod"]`，用于 MCP 端点 `?tag=` 二级收窄（§5.5） |
| allow_private_network | integer | 默认 `0`（fail-closed），按资产显式开启，变更写治理审计（§5.6） |
| command / args / env / url / headers | text / JSON / JSON / text / JSON | 社区原生配置，Market 展开后固化为快照 |
| credential_slots | JSON | `[{target:'env', name:'MYSQL_PASSWORD', label:'MySQL 密码', file:false}]`，≤32 个 |
| owner_id | text FK→users | |
| visibility | text | `owner` \| `group` \| `public` |
| shared_with_user_ids | JSON | 单独授权名单 |
| tool_filters | JSON nullable | `{enabledTools:[], disabledTools:[]}` |
| enabled / prewarm | integer(bool) | prewarm = keep-warm 白名单 |
| config_hash | text | sha256(规范化配置)，实例池 revision 组成部分 |
| **market_key** | text nullable | 来源 Market 目录条目 key（ADR-025）；**仅用于"已添加"徽章与重复检测，运行时不读**。手工创建的资产为 null |
| created_at / updated_at | integer | |

约束：槽位 name 必须匹配 env/args/headers 中的 `${NAME}` 占位符（应用层校验）。
索引：`owner_id`、`visibility`

> **可编辑字段（ADR-035）**：`display_name` / `description` / `tags` / `host_conn` / `url` / `allow_private_network` / `allow_insecure_tls` / `visibility` / `shared_with_user_ids` / `credential_slots` / `enabled` / `name` 可改。
> `type` / `execution_mode` / `category` / `command` / `args` / `env` / `headers` **创建后不可改**（`PATCH` 显式 400 整批拒绝）。形态与执行配置决定工具名前缀、策略作用域与实例计划，建错应重建资产。

### 4.2 credentials（凭证 = 创建者私有资源，可按分组共享使用）

> **ADR-028 修订（2026-11-06）**：凭证仍是**创建者私有资源**（管理权 = 归属人 + admin 不变），
> 但**恢复按分组的显式共享**——归属人在凭证详情页按分组逐个开关，成员可"使用"共享凭证。
>
> 与 ADR-020（2026-10-20）的差别：
> 1. **绑定候选仍只有自己创建的凭证** —— 共享凭证**只能"用"不能"绑"**（防转授权），这条不变；
> 2. **使用权不再从"绑定资产"间接派生**，改为凭证自身的 `credential_group_shares` 事实；
> 3. 新增 `privileges`（root/rw/wo/ro）**仅展示**，不参与授权判定。
>
> 不重新引入 `visibility` / `shared_with_user_ids` 列——跨人共享走独立的
> `credential_group_shares(credential_id, group_id)` 表，语义是"共享给这个分组"而非"共享给这些人"。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text PK | |
| name | text unique | 如 `prod-mysql-ro` |
| kind | text | `env-values`（命名值集合） |
| encrypted_values | text | `v1.<iv>.<tag>.<ciphertext>`（AES-256-GCM），AAD = credentialId |
| value_hint | text | 末 4 位掩码，如 `****abcd` |
| owner_id | text FK→users | **归属人**：仅 owner + 平台 admin 可改值 / 轮换 / 删除 / 调共享。**成员被删除后置 NULL（无主），admin 可重新指派**（ADR-028） |
| **privileges** | JSON | `["root","rw"]` 等，取值 `root \| rw \| wo \| ro`，可多选。**仅展示性元信息，不参与任何授权判定**（ADR-028） |
| created_at / updated_at | integer | **updated_at 变化触发全部绑定资产的实例失效重建**（见下方副作用） |

> **不引入的字段**：`visibility`、`shared_with_user_ids`（ADR-020 取消，ADR-028 也未恢复）。
> 跨人共享由 `credential_group_shares(credential_id, group_id)` 表表达——按**分组**共享，不按人。

**三种能力（引用权已取消）：**

| 能力 | 谁能 | 判定依据 |
|---|---|---|
| **管理**（改值 / 轮换 / 删除） | 归属人 + 平台 admin | `owner_id` / `isAdmin` |
| **使用**（实际拿它去连目标资源） | 归属人 ∪ 归属人授权出去的人 | 见下方"使用权传播" |
| **查看**（在 `/credentials` 列表出现） | 归属人 ∪ 实际使用者 ∪ admin | 使用者由绑定资产推导 |

**使用权判定（ADR-028 修订，取代 ADR-019 的「从资产派生」）**

```
1. principal.isAdmin                              → 允许
2. cred.ownerId === principal.userId              → 允许（归属人自己）
3. credential_group_shares 中存在 G 满足:
     该凭证共享到 G
     AND principal 在 G 里                        → 允许（归属人按分组共享）
```

**为什么不再从资产派生**：ADR-028 恢复了显式共享开关后，若仍按「看见任一使用该凭证的资产即有权使用」派生，
成员只要能看到资产就等于拿到凭证，与「没共享就看不到」直接矛盾。共享是**凭证自身的事实**，必须显式。

| 场景 | 结果 |
|---|---|
| Alice 把凭证共享到 G 组，Bob 在 G 组 | Bob **能**用 |
| Alice 共享到 G 组，Charlie 只在 F 组 | Charlie **不能用**（不默认跨组） |
| Bob 想给自己资产绑 Alice 的凭证 | **绑不上** —— 候选只有自己的凭证（防转授权，ADR-028 §2.2 保留） |
| 成员被移出 G 组 | 不能再用该组的共享凭证；其 personal 绑定保留但对该凭证失效 |
| admin 把任意凭证绑到任意资产 | **允许**（显式例外），记治理审计 |

**两处写入侧硬校验（fail-closed）：**

| 写入动作 | 校验 |
|---|---|
| 槽位绑定 / 换绑凭证 | **只能绑自己创建的凭证**（`cred.ownerId === principal.userId \|\| isAdmin`，ADR-028 §2.2），否则 400。共享凭证只可「用」不可「绑」。前端下拉已过滤，此处是服务端兜底 —— 前端过滤不是安全边界 |
| 改资产可见性（放宽） | 若任一槽位凭证 `ownerId !== asset.ownerId` 且非 admin 代绑 → 400 并说明原因 |

**这带来一个运维上的自然结论**：想让一群人共用一套凭证，就由**凭证归属人同时持有那些资产**再授权出去（例如 Alice 导入 300 台主机、持有 SSH 密钥凭证，然后把资产授权给全组）。`credential_id` 相同、`user_id` 各异 —— 共享凭证 + 审计到人成立。

**凭证详情页新增"实际使用者"**：从绑定资产的可见者去重推导，显示"N 人正在使用此凭证"。这比原来的"public 徽章"更准确 —— 真正的安全信号是"有多少人在用"，不是"配置上写了什么"。

**一凭证绑多资产（多对多，已支持）**：300 台主机绑同一个 SSH 密钥，`server_credentials` 里就是 300 行，凭证表只有 1 行。实例键 = `serverId + configHash + 凭证指纹`，`serverId` 不同 ⇒ 每台主机仍是独立实例，不受影响。

**⚠ 由此产生的副作用（必须写进 UI）**：凭证轮换或改值 → `updated_at` 变化 → **所有绑定它的资产的实例全部失效重建**。共享给 300 台主机的 SSH 密钥轮换一次，理论上影响 300 个资产（稳态下同时活跃的按实例预算封顶）。因此：
- 轮换确认模态必须列"将影响 N 个资产"（名单，非数量，沿用设计师 V3 规则）
- 补充提示"这 N 个资产正在运行的连接将被断开重建"
- `audit_log` 记一条 `credential_rotate` 治理事件，携带受影响资产数

### 4.3 server_credentials（槽位 ↔ 凭证值映射，ADR-028 一槽多凭证）

| 字段 | 说明 |
|---|---|
| server_id + slot_name + **user_id + credential_id** | **联合主键**（ADR-028 由两列扩为三列；**2026-11-17 扩为四列**） |
| credential_id | FK→credentials |
| **scope** | `asset`（共享给该资产的使用者）\| `personal`（仅本人可用）。**由绑定时的「共享给组内成员」复选框决定**（2026-11-17 用户决策）；只有资产归属人 / admin 有资格勾选共享，成员自建绑定固定 `personal`（防转授权） |
| **label** | 区分名，如「root 账号」，可空 |
| **username** | 该条绑定使用的 SSH 登录用户名（可空，2026-11-17 新增）。**优先级：绑定 username > 凭证 username 键 > 资产 `host_conn.username`**。仅在 native host 链路上生效；连接池键含用户名，改账号即换连接 |
| **credential_key** | 该绑定从凭证里取哪个键（可空，**2026-11-18 新增，ADR-031**）。**NULL = 按槽位名匹配**（键名完全一致或归一化后一致：剥品类前缀 + 小写 + 去下划线）；有值 = 精确取该键，键不存在则 fail-closed 抛错。**注意：不再有"单键兜底"与"敏感别名兜底"两级猜测** |

一个资产的多个槽位可指向不同凭证（如 SSH 私钥一个凭证、私钥口令另一个）。
同一槽位可同时存在归属人的 `asset` 绑定与多个成员的 `personal` 绑定 —— 取值时 personal 优先（见 §4.2 取值顺序）。

> **为什么用户名放绑定而不是资产（2026-11-17 用户决策）**：同一槽位并存「root 私钥 + dev 私钥」时，
> 账号是**绑定**的属性 —— 两条绑定各自对应一个登录账号，放资产上就表达不了。同时它也不该固定绑在凭证里：
> 同一份私钥在不同资产/不同绑定上用不同账号是合法诉求。因此解析顺序为绑定 > 凭证 > 资产，
> 绑定处留空即回落到凭证自带的 `username`，再回落到资产。UI 上只在认证槽位（`host_conn.authSlot`）
> 的绑定行显示「改用户名」，其他品类不受影响。

> **一槽多凭证的典型用法（2026-11-17 用户确认）**：归属人有一台虚拟机，持 root 与 dev 两套凭证 ——
> root 绑成 `personal`（只自己用），dev 绑成 `asset`（勾选「共享给组内成员」，全组可用）。
> 主键 `(server_id, slot_name, user_id)` 保证这是两行，取值顺序保证归属人自己拿到 personal 的 root。
注入时按槽位从对应凭证解密取值。

> **取哪个键（ADR-031，2026-11-18）**：绑定记录的 `credential_key` 有值时精确取该键；
> 为 NULL 时只接受「键名完全一致」或「归一化后一致」（`RABBITMQ_PASSWORD` ≡ `password`、
> `MINIO_ACCESS_KEY` ≡ `access_key`）。两者都不中直接报错，提示"请在绑定上指定键名"。
> **已删除**原先的两级猜测：「凭证只有 1 个键就用它」「唯一敏感别名（password/token/secret…）」——
> 前者会在单键凭证绑多槽位时把同一个值喂给不同槽位，后者永远追不上下一个产品的命名
> （`AUTH_PASS` 归一化得 `pass`，与 `passphrase` 不同名，正是本次触发缺陷的场景）。
> UI 上选完凭证后同面板出现「用哪个键」下拉，默认选中同名键。

> **与 `ref.<凭证名>.<键名>` 的区别（ADR-031 §2.4）**：`ref.` 写在资产配置值里、
> 按凭证名全局引用、**不参与** `scope`/`privileges`/成员自绑，适合平台内建条目；
> `credential_key` 是**绑定关系的属性**，完全参与权限模型，适合成员给自己的槽位挑键。两者并存不合并。

> **为什么主键要含 credential_id（2026-11-17 修订）**：三列主键下，同一人在同一槽位只能存一条绑定，
> 「归属人 root 自用 + dev 共享给全组」在结构上无法成立 —— 第二条会覆盖第一条（ON CONFLICT DO UPDATE
> 让"追加绑定"实际变成"换绑"）。扩为四列后，同一槽位可并存多条绑定；取值时 personal 优先于 asset，
> 同类内按 `privileges` 取权限最高的一条。

> **同权限等级时的确定性择优（2026-11-19 新增，见 §10 ADR-034）**：并列最高权限的绑定按
> ①管理类账号优先（凭证名或绑定用户名含 `root`/`admin`/`superuser`/`superadmin`）
> ②`credentialId` 字典序 决胜。起因：v1 迁移后大量资产一槽绑定 2~3 个同为 admin 的账号
> （如 `tke-nacosdb-mysql-16.79` 的 root 与 nacos 账号），旧实现只按等级排序，同分时结果取决于
> SQLite 行序 —— 同一份数据在不同机器可能取到不同账号，属隐式不确定。

**可见性**：槽位列表接口对成员返回「自己的全部绑定 + 他人的 asset 绑定」；
他人的 `personal` 绑定是成员的私有选择，不向其他成员暴露。

### 4.3.1 server_slot_values（槽位直填值，ADR-027）

| 字段 | 说明 |
|---|---|
| server_id + slot_name | 联合主键 |
| encrypted_value | `v1.<iv>.<tag>.<ct>`（AES-256-GCM，AAD=`slot:<serverId>:<slotName>`） |
| value_fingerprint | 明文值 sha256 前 16 位（实例键构成用；非明文，不可逆） |

**直填值不是凭证**：用户在资产上直接填写的密钥属于该资产自身 —— 不进 `credentials` 表、不出现在凭证列表、不参与「凭证 = 创建者私有资源、可按分组共享」（ADR-028）的模型、不能被别的资产引用。加密存于本表，随资产删除而删除。

**与 server_credentials 互斥**：同一槽位要么绑定凭证、要么有直填值，写入侧保证（绑凭证 → 清直填值；写直填值 → 清绑定）。

> **2026-11-17 修订**：写直填值时**只清写入者本人**在该槽位的凭证绑定，不清其他人的。
> 直填值本身是**资产级**的（`server_slot_values` 主键只有 `server_id + slot_name`），
> 一槽多凭证后若按槽位清空全部绑定，归属人写一次直填值就会顺手删掉所有成员的 personal 绑定。
> 现在的行为：归属人写直填值 → 自己的绑定被清（互斥生效），成员的个人绑定保留；
> 直填值被清除后，成员的 personal 绑定重新生效。

**取值优先级**：直填值优先于凭证绑定（互斥使二者不会同时存在，优先级只为数据异常兜底）。

**实例键**：直填值以 `credentialId = inline:<值指纹>`、`updatedAtMs = 0` 参与实例键构成 —— 值变 → 指纹变 → 键变 → 实例重建（与凭证轮换同语义）。

### 4.4 api_keys

| 字段 | 说明 |
|---|---|
| id / name | |
| user_id | **审计归属键**：agent 调用记到 Key 所属人 |
| key_hash | SHA-256(key)，原文只显示一次 |
| client_name | text nullable，显式客户端标识（如"张三的 Claude Desktop"） |
| scopes | `["mcp:invoke"]` 固定 |
| last_used_at / revoked_at | 软删除 |

### 4.5 audit_log_YYYY_MM（按月分表）

| 字段 | 阶段 | 说明 |
|---|---|---|
| id (uuid PK) | intent | |
| ts | intent | 毫秒 |
| user_id + username | intent | **审计到人**（API Key 归属人） |
| api_key_id | intent | |
| client_name | intent | 来源客户端（白名单规范化，原始 UA 不落库） |
| source_ip | intent | |
| server_id + server_name | intent | 资产 |
| credential_id | intent | **实际注入的凭证 = "用哪个账号"** |
| tool | intent | 如 `mysql_query` / `ssh_exec` |
| action | intent | `tool_call` \| `blocked` \| `auth_fail` \| `credential_rotate` \| `credential_bind` \| `visibility_change` \| `group_change` \| `server_toggle` |
| risk | intent | `normal` \| `high`，由 `guard_rules` 中 `kind='mark'` 的规则命中判定（§5.8） |
| input_summary | intent | **入库前已脱敏**，不存明文中转 |
| status | intent→result | `pending` → `success` / `error` / `blocked` / `unknown` |
| output_summary | result | 脱敏 + 截断 4KB |
| duration_ms / error_message | result | |

索引：`(ts)`、`(user_id, ts)`、`(server_id, ts)`、`(status, ts)`、`(tool, ts)`

> AI 调用类动作 = `tool_call`/`blocked`/`auth_fail`；治理类动作 = `credential_rotate`/`credential_bind`/`visibility_change`/`group_change`/`server_toggle`。前端"授权变更"筛选直接过滤治理类枚举值，不新增字段。

### 4.6 audit_stats_hourly（预聚合，服务概览页）

```
hour_ts integer, asset_id text, call_count integer, error_count integer,
blocked_count integer, total_duration_ms integer
PRIMARY KEY (hour_ts, asset_id)
```
写入路径：result 回填时**同一事务内** UPSERT 增量。查询只打这张表（7 天 ≈ 40 资产 × 168 小时 = 6720 行，毫秒级）。启动时 + 每天一次与明细对账，不一致按明细重灌。

### 4.7 guard_rules（WAF 式规则库）

> 用户决策：高危定义不做硬编码，做成可维护的规则表，按 WAF 规则库的形态管理。规则引擎同时服务两个用途 —— `mark`（打高危标记）与 `block`（拦截调用），一张表、一个引擎、`kind` 字段区分。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text PK | |
| name | text | 规则名，如"删库语句" |
| kind | text | `mark`（打 risk=high）\| `block`（拒绝调用，返回 -32004） |
| target | text | `tool`（匹配工具名）\| `arg`（递归匹配参数**值**，展开嵌套对象/数组，不含键名）\| `body`（匹配完整请求体，JSON 序列化后连键名一起匹配——2026-11-18 用户需求：不能只匹配入参）\| `asset_type`（匹配资产类型）\| `group`（匹配资产所属分组名） |
| pattern | text | 正则，**必须线性无回溯**（禁止嵌套量词、禁止回溯引用） |
| enabled | integer | |
| priority | integer | 命中多条时取优先级最高 |
| locked | integer | `1` = 内置规则（**仅作标注，不再阻止修改/删除**，见下方修订） |
| builtin | integer | `1` = 系统播种，用于 UI 标注「内置」 |
| hit_count / last_hit_at | integer | 运营统计，帮助判断规则是否失效 |
| description | text | 给管理员看的说明 |

**内置播种规则（locked=1，随迁移写入）：**

| kind | target | pattern（示意） | 说明 |
|---|---|---|---|
| block | arg | 云元数据地址 `169\.254\.169\.254`、`metadata\.google\.internal` | SSRF 底线，等同 mcphub always-on 规则 |
| block | arg | 凭据路径 `\.ssh/id_\|\.aws/credentials\|\.kube/config\|/etc/shadow` | 凭据文件读取 |
| block | arg | RCE 模式（仅对 command/script 类字段）：`;\s*rm\s+-rf`、`\|\s*sh\b`、`\$\(.*\)`、`` `.*` `` | 命令注入 |
| mark | tool | `(delete\|drop\|truncate\|kill\|restart\|reboot\|shutdown\|scale\|patch\|apply\|exec)$` | 写删类工具名 |
| mark | arg | `\b(DROP\|DELETE\|TRUNCATE\|ALTER\|GRANT\|INSERT\|UPDATE)\b` | SQL 写操作 |
| mark | arg | `\b(rm\s+-rf\|mkfs\|dd\s+if=\|shutdown\|reboot\|kill\s+-9)\b` | 主机高危命令 |

> **2026-11-17 修订（用户决策）：内置规则允许管理员修改 / 停用 / 删除。**
> 原设计用 `locked=1` 在服务端硬拦 PATCH/DELETE，导致「规则误判把正常业务挡死」变成无解问题 ——
> 管理员看着一条拦错的正则，却没有任何办法关掉它。现在：
> - 后端不再检查 `locked`；`locked` 退化为纯标注位（UI 显示「内置」徽章）。
> - **安全底线的责任转移给管理员**：删除内置规则（尤其是四条 block 规则）意味着放开 SSRF / 凭据读取 /
>   命令注入 / 后门上传入口。UI 在删除前强制二次确认并说明后果，`guard_rule_change` 审计记录
>   `builtin` 标记与被删规则原文，便于事后追责与恢复。
> - 不新增「按单资产」粒度：现有 `target='asset_type' | 'group'` 已能表达"只对某类/某组生效"，
>   再引入 `asset` 会让规则匹配多一层实体引用，收益不抵复杂度。

**运行机制**：进程启动时把启用规则加载进内存数组（按 priority 排序），规则变更（增删改）时热重载并写治理类审计事件。每次调用对工具名 + 已脱敏前的参数（截断 4KB）跑一遍，**先 block 后 mark**，block 命中即中断。

### 4.8 ER 关系

```
users ||--o{ api_keys : owns
users ||--o{ servers : owns
users ||--o{ credentials : owns
servers ||--o{ server_credentials : "slots bind"
credentials ||--o{ server_credentials : "values for"
servers ||--o{ server_slot_values : "slots inline"
groups ||--o{ group_servers : includes
groups ||--o{ group_users : has
```

---

## 5. 关键技术设计

### 5.1 技术栈（版本锚定）

| 层 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 运行时 | Node.js | 22 LTS | stdio 子进程管理、单进程事件循环 |
| 后端 | **Fastify** | ^5.2 | 内建 JSON Schema 校验（省 zod 双份校验）、OpenAPI 自动导出、性能好 |
| ORM | **Drizzle** | ^0.44 | SQL-like、零运行时开销、类型直接来自 schema、迁移内建 |
| DB | **SQLite (better-sqlite3) + WAL** | ^12 | 单进程自托管零依赖；20 用户 + 每天数千条审计远低于其能力 |
| MCP SDK | `@modelcontextprotocol/sdk` | ^1.29 | 官方主线，Client 能力完整 |
| 认证 | **better-auth** | ^1.6 | session + API Key 双主体内建 |
| 前端 | React + Vite SPA | ^19.2 / ^6.3 | 纯管理后台无 SEO 需求，与参考实现同构 |
| UI | Tailwind CSS 4 + shadcn/ui + TanStack Query v5 + react-router-dom 7 | | |
| **图标** | **lucide-react** | **^1.59.0**（npm registry 实测 latest，pnpm lock 锚定） | 全项目唯一图标库，禁止 emoji，禁止第二套库 |
| **SSH 客户端** | **ssh2** | ^1.16 | 原生执行层（ADR-022）：SSH/SFTP 进程内直连，连接池复用，替代 300 个主机类 MCP 子进程 |
| 其他 | `tree-kill` ^1.2、`ipaddr.js` ^2.4、`zod` ^4、Node 内建 `node:crypto` | | |

### 5.2 部署拓扑

**单 Node 进程**（systemd/pm2）→ Docker 单容器：网关 + 前端静态资源 + SQLite 数据卷（`/data`）。

**不引入 Redis。** 理由：实例池是进程内 Map，多进程会破坏 stdio 子进程的独占持有权 —— 这正是选择 TypeScript 单进程的核心收益。rate-limit 用内存存储（20 用户量级足够）。唯一演进场景是将来多副本 HA，MVP 明确不做。

### 5.3 Market 与凭证槽位（解决痛点 1/2/3）— **v1 必修（ADR-025）**

> **范围裁定（ADR-025 / 决策 R）**：Market 的**目录浏览 + 单条实例化 + 槽位自动识别**属 **v1 必修**；`batch-instantiate`（参数化批量，300 台场景）仍属 **v1.1**（决策 B 不变）。理由见 §10 决策 R 的缺口论证。

**Market 目录**：内置 `servers.json`，沿用 MCP Registry 形状（name / display_name / description / repository / categories / tags / `installations.{npm|pypi|docker}.{command,args,env}`），可从社区 registry 导入。MVP 只收录验证过的品类：mysql / kubernetes / 网络诊断 / 日志指标（host 已原生化，默认不经过 Market，见 ADR-022 修订）。

**目录数据来源与治理**：

| 项 | 规定 |
|---|---|
| 载体 | 数据库表 `market_entries`（**ADR-029 取代 ADR-025 的"不落库"**）；`src/data/market-catalog.json` 降级为**种子源**，仅初始化与回滚用 |
| 条目数 | v1 内置 **12–20 条**，每条必须经实测 `tools/list` 通过（任务 K 校准品类）；管理员可通过后台追加条目 |
| 版本固化 | `command` 固化为 `npx -y pkg@x.y.z` / `uvx pkg==x.y.z`，**严禁 `-y` 裸包名**（§10.4 版本漂移风险）；后台新增条目时同样校验 |
| 条目状态 | `draft`（仅管理员可见）→ `verified`（所有人可见）→ `disabled`（不可见、不可实例化）；停用不影响已创建资产 |
| 自定义条目 | **ADR-029 起提供管理员后台管理**（`/market/entries`）：新增/编辑/停用/删除 + 连通性测试；删除前校验 `servers.market_key` 引用，有引用则拒绝 |
| 已添加徽章 | `servers.marketKey` 记录来源条目 key（可空），仅用于徽章与"再添加一次"的重复检测，**运行时不读**（Market 与 Server 解耦，ADR-003） |

**实例化流程（`POST /market/instantiate`）**——四步，全程不见 schema/JSON：

1. **展开**：取目录条目 → 按 `installations` 选中目标运行时（v1 固定 npm）→ 生成 `command/args/env` 配置快照
2. **槽位自动识别**：扫描 `env` 值 + 敏感键启发式，自动列出待填槽位（用户只看到"MySQL 密码 / kubeconfig 文件"这类中文标签）
3. **凭证绑定**：每个槽位**行内**填值或选自己的凭证（数据源 `GET /credentials/candidates`，仅本人凭证，ADR-028）；也可直接填值（资产自带，ADR-027）
4. **落库 + 预热**：写 `servers`（`marketKey` 记来源）+ `server_credentials`，异步预热拉 `tools/list`，失败不阻断（登记成功 ≠ 连通成功，UI 明确区分）

**槽位自动识别**（零 Schema 定义的关键）：
```
占位符正则: /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
敏感键启发式: key 含 secret|token|password|api_key|private_key|passwd|credential
```
Market 条目的 env 值形如 `${MYSQL_PASSWORD}` → 自动识别为凭证槽位。槽位结构仅四字段：`{target: env|args|headers, name, label, file:boolean}`。

**识别率兜底**：自动识别是启发式，**允许漏判**。故实例化面板提供"手动补槽位"（把任一 env 键手工标为槽位），并在 `/assets/:id` 详情页保留完整的槽位绑定能力（§8.5）。判定失败的产品后果是"凭证填不进去"，必须在 UI 层有人工出口，不能只靠正则。

**槽位自动识别**（零 Schema 定义的关键）：
```
占位符正则: /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
敏感键启发式: key 含 secret|token|password|api_key|private_key|passwd|credential
```
Market 条目的 env 值形如 `${MYSQL_PASSWORD}` → 自动识别为凭证槽位。槽位结构仅四字段：`{target: env|args|headers, name, label, file:boolean}`。

**`file:true` 槽位**（SSH 私钥 / kubeconfig）：值写入 `<data>/runtime-creds/<instanceKey>/<name>`（0600，实例关闭即删），env 值替换为该文件路径。这替代了上版完整的"文件注入 Schema"。

**安装管线修正**：登记时**异步预热**（失败不阻断）+ 登记即拉起一次缓存 `tools/list`。砍掉完整的 install job 状态机 —— npx/uvx 本身就是按需拉取的。

**批量导入（v1.1，决策 B 不变）**：300 台主机是同一模板 × host 清单。Market 实例化需支持参数化批量导入（同一模板 × 主机列表 → N 个 Server）。这是实例池之外的独立导入工具需求。v1 的 300 台主机走 **CSV 直建原生 host 资产**（§8.5 `/assets` 导入按钮），不经过 Market 实例化管线。

> **ADR-022 修订**：host 品类默认走原生执行（§5.5.7）后，**主机资产不再需要 Market 中的 ssh-mcp 类模板** —— 创建流程变为原生表单（host / port / username / 认证槽位 / tags），凭证仍走 `server_credentials` 槽位绑定。Market 目录中保留社区主机类 MCP 供高级用户选用（`execution_mode='mcp'`），但默认路径不经过 Market。批量导入同理：CSV 直接生成原生 host 资产，无需实例化管线。

### 5.4 实例池（解决痛点 6，核心）

**实例键**：
```
instanceKey = hash(serverId + configHash + sorted([(slotName, credentialId, credentialUpdatedAt)]))
```
关键点：键里是**凭证指纹而不是用户 ID**。20 个人用同一套资产+凭证 → 复用同一个进程，**20 人乘数消失**。mcphub 的 `(server, username)` 键在本场景会放大 20 倍，不可照抄。凭证轮换或配置变更 → 键变化 → 旧实例回收、新请求建新实例。

**生命周期状态机**：
```
            acquire(key)
  [absent] ──────────────► [spawning] ──成功──► [ready]
    ▲                          │                   │
    │                      失败/超时               │ idle TTL(默认 5min)
    │                          ▼                   ▼
    └──────── killed/failed  [failed]          [draining] ── tree-kill ──► [absent]
```
- `active` 引用计数，acquire+1 / release-1；`active==0` 启动 idle TTL（`unref()`，不阻塞进程退出）
- ready 状态每 60s `ping()`，连续 2 次失败 → 标记 failed → 重建

**⚠ 与原生执行的关系（ADR-022）**：`execution_mode='native'` 的资产（默认即全部 host 品类）**不进实例池** —— 网关用 ssh2 连接池在**进程内**直连，不 spawn 任何子进程。实例池只服务 `execution_mode='mcp'` 的资产（MySQL 30 + K8s 4 + 其他）。

**配额模型**：

| 参数 | 值 | 说明 |
|---|---|---|
| 全局实例预算 | **80**（硬上限 96） | 加权内存单位：Node 类权重 3，uvx 类权重 2，全局权重预算 **200** |
| 单资产实例数 | 2（默认，可配 1–4） | 并发降级时允许开第二个 |
| 单用户排队长度 | 8 | 超出 429 |
| 全局并发调用上限 | 64 | 信号量 |

**内存核算（部署机 16GB，用户确认）**：网关自身 ~300MB + 80 × 均值 40MB ≈ 3.5GB。即便按 uvx 实测上限 120MB/实例 算，80 × 120MB ≈ 9.9GB，仍在 16GB 内 —— **原 2GB 约束解除，不再是需要权衡的瓶颈**。

**原生化后的实际负载（重算）**：300 台主机改走 SSH 连接池后，实例池只需覆盖 **34 个 MCP 资产**（30 MySQL + 4 K8s），稳态实例数远低于 80 预算。300 台主机的成本变成**连接态**而非**进程态**：

| 态 | 单条成本 | 300 台全活跃 | 说明 |
|---|---|---|---|
| ssh-mcp 子进程（原生化前） | ~40–120MB | 12–36GB | **16GB 机不可承受**，只能靠 LRU 淘汰到 80 以内 |
| ssh2 连接（原生化后） | ~2–5MB（socket 缓冲 + 加密上下文） | 0.6–1.5GB | 可长驻、可空闲超时释放、无包管理器冷启动 |

且**冷启动从 1–30s（npm/uv 拉包）降到 100–500ms（TCP + SSH 握手）**。这是痛点 6（资源控制）比实例池方案彻底得多的解法 —— 实例池是在"必须 spawn 子进程"前提下的优化，原生执行是**去掉了这个前提**。

注意：80 是**上限不是目标**。稳态实例数由空闲 TTL 与 LRU 决定（20 人日常并发远达不到 80），预算只是防止极端并发打爆内存。

**LRU 淘汰**（跳过保护式，避免批量巡检挤掉热实例）：
1. 过滤 `active > 0` 的实例
2. 按 `score = lastUsedAt - (hitCount > 5 ? 10min : 0)` 升序
3. 逐个关闭直到回到预算内；全 busy 则新建请求排队（上限 30s）后失败

**并发串行化**：社区 stdio MCP server 普遍不保证并发安全 → 每实例一个 FIFO Promise 链（`this.tail = this.tail.then(run, run)`），串行执行。降级路径（实现于 `InstancePool.acquire`，2026-11-18 修正为真正读取 `instance_pool.degrade_wait_sec`）：
1. 空闲实例 → 立即复用
2. 全部被占 → 复用 refs 最少的实例（多路复用，AC-11：稳态实例数不随用户数增长）
3. 该实例上的调用已**连续占用** ≥ `degrade_wait_sec`（3s）且 `maxInstances ≥ 2` 且预算允许 → 开第二实例
4. 第二实例不可用 → 继续排队至 15s
5. 超时 → MCP error `-32002 "Instance busy ... Retry or narrow the operation."`

> 阈值判定口径是"已有调用跑了多久"，不是"新请求等了多久"：后者需要新请求先阻塞，会把本可立即复用的短并发也拖慢。

**预热 = 只拉包不常驻**：prewarm 白名单资产后台执行"拉起 → handshake → listTools → 立即关闭"。作用是让 npm/uv 包缓存落盘，真正调用时 1–3s 命中（而非 5–30s）。全局预热并发上限 2，10min 退避重试。**不常驻进程，内存零占用。**

**崩溃与僵尸清理**：子进程 exit → 标记 failed → 指数退避重建（1s/5s/15s，3 次后熔断 5min）；启动时 + 每小时 sweep `tree-kill` 孤儿进程；网关 SIGTERM 优雅关闭 + WAL checkpoint；子进程 stderr 环形缓冲（最近 200 行）管理端可查。

### 5.5 MCP 入口（工具暴露与工具描述）

#### 5.5.0 问题的形状（为什么这是 P0，不是体验优化）

上一版的做法是：**固定几个接口 + schema 入参路由 + skill 引导**。这套做法在当时解决了真问题（上下文不炸），但留下两个死穴：

| 死穴 | 表现 | 本质 |
|---|---|---|
| ① 能力硬编码 | 新接入一种资产类型要写代码、发版 | 不是网关，是"带路由的执行器" |
| ② skill 要分发 | 20 个员工各装各的，版本不一致，引导失效 | 引导机制在连接之外，天然会漂移 |

所以本版必须**同时**满足三个条件，缺一不可：

1. **工具数恒定** —— 不随 334 个资产增长（目标 ≤ 30）
2. **能力定义权在社区实现手里** —— 新增品类 = Market 加一条模板 + 实例化，零代码
3. **引导随连接自动下发** —— 不依赖客户端装任何东西，零分发

同时满足三者的唯一解：**按品类聚合工具，资产降为入参，用 MCP `initialize.instructions` 承载引导**。

---

#### 5.5.1 按品类聚合（ADR-021）

**为什么能聚合**：同一品类的资产跑的是**同一个社区 MCP 实现**（300 台主机都是 ssh-mcp，30 个 MySQL 都是 mysql-mcp）。它们的 `tools/list` 完全相同 —— **差异在连接参数（host / port / 凭证），不在能力**。既然能力一样，就没有理由暴露 300 份。

**工具来源分两类（ADR-022，用户决策）**：

| 类型 | 适用 | 实现 | 走实例池 |
|---|---|---|---|
| **原生工具**（native） | `category=host` 的 SSH 执行 / SFTP 文件传输 | 网关进程内 ssh2 直连，**平台自己定义 schema** | ❌ 否 |
| **派生工具**（derived） | `mysql` / `k8s` / `other`，以及 host 品类的非原生扩展 | 社区 MCP 实现 `tools/list` 裁剪透出 | ✅ 是 |

**聚合单元 = `(category, implementation)`**。对原生工具，`implementation = 'opsgate'`。

| 项 | 规则 |
|---|---|
| 工具名 | `{category}_{tool}`，如 `host_execute_command`、`host_request_upload`、`mysql_query`、`k8s_get_pods` |
| 资产参数 | `asset`（string）作为入参，接受资产 `id` 或 `name` |
| Schema 来源 | 原生工具：平台定义（稳定、可版本化）；派生工具：社区 `tools/list` 自动裁剪 |
| 裁剪内容（仅派生） | ① 剔除所有连接参数（`${HOST}`/`${USER}` 等凭证槽位已在服务端注入，agent 不可见也不可覆盖）② 剔除实现细节字段 ③ 追加 `asset` 必填参数 |
| 冲突处理 | 同品类下出现**两个不同实现**（如 ssh-mcp 与 ansible-mcp 共存）时，工具名加实现短前缀 `{impl}_{tool}`，并在描述首句标注实现来源 |

> **ADR-032（2026-11-18）单入口分层暴露 / ADR-033 元工具——本节的落地方式已变更**：
>
> 上文「工具数恒定 ≤30」的目标是对的，但实现漂移成了「全量平铺」：品类涨到 11 个后，
> 裸 `/mcp` 暴露 245 个工具，超过 `tools.list_max`（默认 200）直接 500；按品类拆端点
> 又不能覆盖不在白名单里的新品类。现在改为：
>
> 1. **`/mcp` 是唯一入口**，初始化**只返回平台工具**（7 个：list_assets / view_asset /
>    list_groups / view_group / **list_asset_tools** / **invoke** / select_scope），
>    结构上不可能撞上限；
> 2. **默认调用路径是元工具**（ADR-033）：`list_assets` → `list_asset_tools` 看该资产的
>    工具名与 schema → `invoke(asset, tool, args)` 执行。这条路径不依赖客户端刷新工具目录，
>    任何客户端都能走（opencode 2.2.6 Code Mode 实测不消费 `tools/list_changed`）；
> 3. **可选优化**：支持 `notifications/tools/list_changed` 的客户端可调
>    `opsgate_select_scope({group?, category?, tag?})` 把该范围的工具铺开成一等公民，
>    服务端替换本会话工具集（不累积）并推送通知；
> 4. **派生粒度仍是品类**：300 台 host 共用同一套 11 个工具，靠 `asset` 入参区分——
>    工具数与资产数解耦这一条不变，变的只是"什么时候、以什么形式把工具给出去"；
> 5. `?group=` / `?category=` / `?tag=` 保留为「初始化即选定该范围」，仍是同一入口同一范式；
> 6. 每会话独立持有工具集（`randomUUID` 建会话），多 agent 并行互不干扰。

**工具数核算（实测前按典型实现估算，实施时以 `tools/list` 实测为准）**：

| 端点（**ADR-030：`?category=` 按品类；`?group=` 按分组实体**） | 来源 | 品类工具 | 平台注入 | 合计 |
|---|---|---|---|---|
| `/mcp`（裸，ADR-033） | 平台 | 0 | 7 | **7** |
| `/mcp?category=host` | **原生**（ssh2 直连） | **4** | +7 | **11** |
| `/mcp?category=mysql` | 派生（MySQL 类 MCP） | ~6 | +7 | ~13 |
| `/mcp?category=k8s` | 派生（Kubernetes 类 MCP） | ~12 | +7 | ~19 |

> **ADR-030（2026-11-13）契约修正**：`?group=` 原先按 `category` 过滤（ADR-026 登记的现状），
> 导致「分组」一词在 UI 与 MCP 侧含义不一致。现改为：**不带参数 = 全部可见资产**；
> `?group=<分组名或 id>` 按**分组实体**（`group_servers`）过滤；`?category=<品类>` 承担原品类收窄；
> 两者同时给出取交集；分组不存在 → 400（不静默返回空）。
> 迁移：原 `?group=host|mysql|k8s` 想按品类收窄的调用方，改用 `?category=`。

> 对比：按资产平铺是 334 × 8 = 2400+（客户端上限普遍 <200，连上即死）。聚合后恒定在 30 以内，**且与资产数量完全解耦** —— 资产从 300 涨到 3000，工具数不变。
>
> host 端点 4 个原生工具：执行 + 上传申请 + 上传状态 + 下载申请（文件本体走 HTTP 临时入口，§5.5.7）。覆盖主机运维 90% 的动作 —— 其余用 `host_execute_command` 组合即可。

**与上一版的本质区别**（形似而神不同，必须讲清楚）：

| | 你的上一版 | 本版 |
|---|---|---|
| 工具定义 | 代码里硬编码固定接口 | 从社区 MCP 实现的 `tools/list` **派生** |
| 新增品类 | 写代码 + 发版 | Market 加一条模板 + 实例化 |
| 工具 schema | 手写维护 | 社区原 schema 自动裁剪透出 |
| 数量控制 | 靠人自觉控制 | 结构上不随资产数增长 |
| 结论 | 带路由的执行器 | **真网关** —— 能力的定义权在社区实现手里，网关只做聚合、路由、鉴权、审计 |

---

#### 5.5.2 平台注入的两个工具（每个端点自动附加）

| 工具 | 优先级 | 作用 |
|---|---|---|
| `opsgate_list_assets` | **P0，永远排在 `tools/list` 第一位** | 返回当前连接可见的资产清单（id / name / tags / status）。支持 `search` 模糊匹配、`tag` 过滤。这是 LLM 获取合法 `asset` 取值的**唯一正确途径** |
| `opsgate_request_access` | P1（V1.1） | 目标资产不可见/无权时，提交带 reason 的申请。写入 `access_requests` 表并通知资产归属人。**解决"agent 撞到权限墙就卡死"** |

`opsgate_list_assets` 的返回是**按调用方权限裁剪过的** —— 它既是发现工具，也是权限边界的自然体现：看不到的资产，LLM 从一开始就不会尝试。

**统一走发现工具，不做混合枚举（用户决策，J2 否决）**：

| 方案 | 结论 |
|---|---|
| 资产数少时把资产注入 `asset` 的 `enum` | **不采用**。同一套行为两种形态，LLM 在不同分组下要适应不同填参方式；且 asset 清单变动时 enum 会漂移，等于把易变数据写进每次 `tools/list` |
| **统一走 `opsgate_list_assets`** | **采用**。所有分组行为一致，描述规范只需写一种，LLM 学到一次就永远适用 |

代价是每次会话多一轮发现调用（约 200 token），换来的是**行为一致性与零漂移**。instructions 第 1 条与每个工具的 `Required` 段都已强制这一轮调用，所以它不是可选项而是工作流的一部分。

---

#### 5.5.3 工具描述规范（让 LLM 理解 + 主动调用）

这是本节的核心。**工具能不能被主动调用，90% 取决于 description 怎么写。** 强制四段式：

```
{What} 一句话能力，动词开头。
Use when: {When} 2–3 个具体的触发场景，用"用户可能会这样说"的自然语句。
Required: {How} 先调用 opsgate_list_assets 取得 {category} 资产清单，用其中的 id 作为 asset 参数 —— 不要凭记忆编造资产名。
{Risk}（仅危险工具）副作用与确认要求。
```

**八条硬规则**：

| # | 规则 | 原因 |
|---|---|---|
| R1 | 工具名动词开头 + 品类前缀（`host_execute_command` 而非 `execute`） | 工具名是 LLM 的第一层语义信号 |
| R2 | **描述里绝不写死资产清单** | 会随权限/资产变更漂移，且等于把资产拓扑写进上下文 |
| R3 | 每个工具描述**必须**包含 `asset` 取值指引 | 否则 LLM 会瞎猜资产名 → 无效调用 → 用户失去信任 |
| R4 | `Use when` 用自然语句，不用抽象名词 | LLM 匹配的是用户意图，不是分类学 |
| R5 | 同品类多实现时，描述首句标注实现来源 | 避免 LLM 混淆两套语义相近的工具 |
| R6 | 工具 description ≤ 200 字，参数 description ≤ 80 字 | Token 成本；28 工具 × 200 字 ≈ 5.6k token，加 schema 全量 <15k，可控 |
| R7 | 参数 description **必填**，枚举值必须带含义说明 | LLM 靠它填参数，空描述 = 必错 |
| R8 | 破坏性工具描述中显式标注 `destructive`，并声明需用户确认 | 配合 §5.8 的 mark 规则形成双重提示 |

**正反示例**：

| | ❌ 反例 | ✅ 正例 |
|---|---|---|
| 工具名 | `execute` | `host_execute_command` |
| 描述 | `在主机上执行命令` | `在指定 Linux 主机上执行一条 shell 命令并返回 stdout/stderr。`<br>`Use when: 用户说"看一下 web-01 的磁盘"、"查一下这几台的负载"、"帮我在 10.0.1.5 上跑个 df -h"。`<br>`Required: 先调用 opsgate_list_assets(category="host") 取得主机清单，用返回的 id 作为 asset 参数，不要凭记忆编造主机名。`<br>`Risk: destructive 命令（rm / systemctl stop / 覆盖写）会命中高危规则并标记，执行前请先向用户复述目标主机与完整命令并等待确认。` |
| 参数 | `{ "asset": { "type": "string" } }` | `{ "asset": { "type": "string", "description": "目标资产 id 或 name，取值来自 opsgate_list_assets，不要编造" } }` |

---

#### 5.5.4 `initialize.instructions` —— 零分发引导（替代上一版的 skill）

**这是解决"skill 分发问题"的关键机制。** MCP 协议 `initialize` 响应支持 `instructions` 字段，主流客户端会把它注入 system prompt。它随连接下发，**不需要在客户端装任何东西**。

网关按连接**动态生成** instructions，四段固定结构（ADR-032 §8 / 2026-11-18 修订）：

```
① 动态头    你是 OpsGate 运维助手，当前视图为全部可见资产[，且仅限品类 X]，共 {n} 台；本连接共暴露 {m} 个工具。
② 动态模式段 仅 platformOnly（裸 /mcp）时：只暴露平台工具 + 元工具三步走 + select_scope 备选
③ 动态分组段 分组说明（管理员在分组页维护；无分组说明时省略）
④ 骨架段    mcp.instructions 设置值；为空/恢复默认则用内置 DEFAULT_WORKFLOW_INSTRUCTIONS
```

内置骨架（`src/config/settingsSchema.ts` 的 `DEFAULT_WORKFLOW_INSTRUCTIONS`）：

```
工作流（必须遵守）：
1. 先 opsgate_list_assets 确认目标资产存在且在可见范围内，用返回的 id 作 asset 参数；不要凭记忆编造资产名。
2. 资产不在清单中时直接说明"我无权访问该资产"，不要换名字反复尝试。
3. 删除 / 写入 / 重启 / 变更配置前，先复述目标资产与完整命令，等用户确认后再执行。
4. 同品类的资产共用同一套工具（靠 asset 区分）；一次只处理一个品类的任务，处理完再切下一个品类。
5. 走 opsgate_invoke 时，tool 必须取自 opsgate_list_asset_tools 的返回，args 按其 inputSchema 填且不要带 asset（框架自动注入）。
6. 传文件：先申请一次性入口（5 分钟有效），再用 HTTP PUT/GET 传本体，最后用状态工具确认落位；文件内容不要写进工具参数。
7. 命令输出超过上限会被截断并置 truncated=true；需要完整内容时用 head/tail/分页自行收窄，不要假设拿到的是全部。
8. 错误码含义：-32002 实例忙/超时（缩小范围重试）；-32003 审计不可用（网关为保护而拒绝，重试无用）；-32004 命中安全策略（不要绕过）；-32005 工具数超限（用筛选收窄）；-32006 资产不存在或无权（不要重试）；-32007 文件或暂存超限（分批传输）；-32008 参数校验失败（按 message 修正）。
```

**为什么只有第 ④ 段可配置**：前三段是**事实**（视图名 / 台数 / 工具数 / 分组说明），由服务端计算；写死在设置里就会变成永久过期信息（比如永远显示"34 台"）。第 ④ 段是**行为约束**，不同组织的运维约定不同（双人确认、变更窗口），必须允许调整 —— 但删掉其中的安全约束就等于放弃了唯一一道提示层防线，所以运行参数页的编辑弹窗必须显示危险提示（§8.5 `/settings`）。

三个决定性的优点：

| 优点 | 说明 |
|---|---|
| **零分发** | 员工只要填 endpoint + API Key 就拿到引导。skill 需要 20 人各装各的，instructions 不需要 |
| **随权限裁剪** | 只写该 Key 可见的分组与资产类型，不泄露全局拓扑（skill 是静态文件，做不到） |
| **服务端单点演进** | 网关改一次，所有客户端下次连接即生效。skill 改一次要重新分发 20 次，必然版本漂移 |

> 这不是"用 instructions 复刻 skill"，而是把引导从**客户端资产**变成**服务端能力**。上一版的 skill 是客户端资产，才会产生分发问题。

---

#### 5.5.5 错误即引导（让 agent 自我纠正）

| 场景 | 返回 | 说明 |
|---|---|---|
| `asset` 缺失 | `-32602` | message 引导"请先调用 opsgate_list_assets" |
| `asset` 不存在 **或** 无权 | `-32006`，**两者不区分** | 防止资产存在性探测；但对**调用方本就可见**的集合做编辑距离匹配，message 内回带最近似 3 个候选（不越权） |
| 分组/端点工具数 > 200 | `-32005` | 聚合后常态不触发，保留为同品类多实现场景的防御；**不静默截断** |
| block 规则命中 | `-32004` + 规则 name（不含 pattern） | 让 agent 知道被拦、为什么，但不过度泄露规则细节 |

---

#### 5.5.6 分组作用的重新定义（ADR-015 / ADR-026）

**分组是自由组织单元（ADR-026）**：不预置默认分组，不按 `category` 自动归组。分组的职责有四项——**关联资产、授权成员、快速筛选、构成查看权**；分组**不构成对资产的业务限定**（资产能否调用仍只由 `can()` 单一真值源决定，ADR-013 / ADR-020 不变）。`category` 的唯一作用是 `asset_type` 规则匹配维度，与分组无关。

> **2026-11-17 补充（用户决策）**：分组关联同时构成**查看权**（见 §6 约束 3 修订）。
> 「关联资产」与「资产可见」不再是两件事：资产加进 G 组，G 组成员即可在 `/groups/:id` 看到它并点进详情页
> 绑定自己的凭证。`visibility='owner'` 只对"与归属人没有任何共同分组"的人不生效。

按品类聚合后，**分组不再控制工具数**（工具数已恒定），改为控制三件事：

1. **资产候选集** —— `opsgate_list_assets` 与 `asset` 参数校验的范围
2. **instructions 内容** —— 引导文案按分组裁剪
3. **标签二级收窄** —— `/mcp?group=prod-db&tag=web` 进一步缩小候选集（`group` 为分组实体名，ADR-030）

以上三项均为**筛选**语义，不改变资产本身的行为约束。

因此 ADR-015 中"类型组不可直接作 agent 端点"的**原理由（1800 工具超限）已不成立**，但结论保留，理由更新为：**300 台主机的候选集会稀释 LLM 注意力**，仍需 `?tag=` 收窄到 ≤30 台的最佳实践。分组页的琥珀警示保留，文案改为"本组 {n} 个资产，建议按 tag 收窄到 30 以内以获得最佳调用准确率"。

**接入端点形态（前端"端点复制区"直接展示）**：
```
https://<opsgate-host>/mcp?group=prod-db
https://<opsgate-host>/mcp?group=prod-db&tag=web

{ "mcpServers": { "opsgate-host": { "url": "https://.../mcp?group=prod-db",
  "headers": { "Authorization": "Bearer <你的API Key>" } } } }
```

**元工具模式 `_all` 不做兼容保留（用户决策，J3 否决）**：原设计的 `opsgate_list_servers` + `opsgate_call` 元工具组合**删除**。理由：按品类聚合后工具数已恒定在 30 以内，元工具解决的"上下文爆炸"问题不复存在；保留它只会多出一套不推荐的旁路，还要维护。需要收窄时用 `?tag=`，不需要第二套调用范式。

> **ADR-032（2026-11-18）部分推翻上述前提；ADR-033（同日）进一步推翻「无调用代理元工具」的结论**：
> 「工具数恒定在 30 以内」的假设随品类增加（3 → 11）失效，裸 `/mcp` 一度到 245 个工具。
> ADR-032 先改为**单入口分层暴露**——初始化只给平台工具，用 `opsgate_select_scope` 选定
> **范围**（分组/品类/tag）后由服务端推送该范围的工具集。
> 但实测 opencode 2.2.6 的 Code Mode 在**同一轮对话内不重建工具目录**（`list_changed` 只更新
> 其客户端缓存），导致 `select_scope` 之后本轮拿不到新工具——服务端不能把"客户端会刷新"
> 当作可用性前提。因此 ADR-033 补上**默认路径**：`opsgate_list_asset_tools` + `opsgate_invoke`
> 元工具，参数 `{asset, tool, args}`，不依赖任何客户端能力。
>
> - `invoke` 的 `tool` 必须属于该资产当前可用工具集（与 `list_asset_tools` 同一份 `toolsOfAsset()`），
>   否则 `-32601`——**不新开任意透传口**，`tool_filters`/停用开关/槽位归因全部照常生效。
> - `opsgate_select_scope` **保留**为可选优化：支持 `list_changed` 的客户端可以少一层嵌套。
> - 因此 J3「元工具不做兼容保留」的结论**被取代**：元工具现在是默认路径，不是旁路。

---

#### 5.5.7 原生工具族：SSH 执行与 SFTP 文件传输（ADR-022）

**用户决策**：SSH 远程执行命令、文件上传、文件下载应作为平台自己的 MCP tool，而不是代理社区 ssh-mcp。

> 本节是**第一批**原生工具的具体设计。它们全部遵循 §5.9 的原生工具扩展框架（ADR-023）—— 后续新增原生工具按同一契约落地，不再重复设计横切逻辑。

**分层原则（判据，回答"哪些能力值得自己实现"）**：

| 判据 | 原生实现 | 代理社区实现 |
|---|---|---|
| 协议稳定性 | 协议几十年不变（SSH / SFTP / RFC 稳定） | 语义随版本演进（SQL 方言、K8s API 版本） |
| 资产规模 | 大规模（300 台）—— 子进程成本被放大 300 倍 | 中小规模（30 MySQL + 4 K8s）—— 子进程可接受 |
| 能力面 | 窄而原子（执行 / 上传 / 下载 覆盖 90% 需求） | 宽而复杂（K8s 数十种资源模型） |
| 社区实现质量 | 参差、依赖重、schema 各异、无事实标准 | 有事实标准实现 |

→ **协议级原子能力原生化，语义级能力保持代理**。这不是放弃网关定位（§2.4 已同步修订），而是把"哪些能力值得自己实现"这个判断显式化、可复核。

**四个原生工具的 schema**：

```
host_execute_command(asset, command, timeout?)
  timeout: int, 默认 30，上限 300
  返回 { stdout, stderr, exit_code, duration_ms, truncated }
  · 非交互 shell，不分配 PTY → sudo 需 -n 且目标机 NOPASSWD；不支持 vim/tail -f 等交互命令
  · stdout/stderr 各截断到 4KB 并置 truncated=true（防止撑爆 agent 上下文）

host_request_upload(asset, remote_path, size_bytes, sha256?, mode?)
  申请一个临时上传入口，文件本体不走 MCP 通道
  mode: 八进制字符串，默认 "0644"
  返回 { upload_id, upload_url, method:"PUT", headers:{Authorization:"Bearer <一次性token>"}, expires_in:300 }
  · 入口 TTL 5min，单次使用，超限大小在申请时即拒绝（-32007）

host_upload_status(upload_id)
  查询上传推送结果，agent 在 HTTP 上传完成后调用
  返回 { status: "awaiting_upload" | "received" | "pushing" | "done" | "failed", error?, path?, size_bytes?, sha256? }

host_request_download(asset, remote_path)
  申请一个临时下载入口；网关同步 SFTP 拉取到暂存区后返回
  返回 { download_url, method:"GET", headers:{Authorization:"Bearer <一次性token>"}, expires_in:300,
         size_bytes, sha256 }
```

**为什么文件传输必须走临时入口（用户经验，纠正了我最初的内联方案）**：MCP 基于 JSON-RPC，是**纯文本协议**，二进制只能 base64 内联进参数 —— 这不仅"协议不支持"，更致命的是**内联内容会进入 LLM 的上下文**：1MB 文件 base64 后约 1.37MB ≈ 30 万 token，单次上传就击穿上下文窗口。所以正确形态是上一版已验证过的两步式：**MCP 只负责申请入口与查询状态（几十 token），文件本体走 HTTP 旁路通道**。

**传输流程（上传）**：

```
agent                          OpsGate                         目标主机
  │ ① host_request_upload        │                                │
  │   (asset, path, size, sha)   │── 鉴权 → 规则 → 写 intent ──▶  │
  │ ◀── upload_url + 一次性token │                                │
  │ ② HTTP PUT 文件本体           │── 校验 size/sha256/尺寸上限 ──▶ │
  │   (curl / 客户端)            │    暂存 <data>/transfer/       │
  │ ③ host_upload_status         │── SFTP 推 .opsgate.tmp.<rand> ─▶
  │ ◀── status=done, sha256      │── rename 原子落位 + 删暂存 ───▶ │
```

**传输流程（下载）**：`host_request_download` 调用时网关**同步**完成 SFTP 拉取（内网几十 MB 在秒级），校验大小上限后落暂存区并返回入口 URL；agent `GET` 一次性拉走。拉取动作本身即审计事件，agent 是否真的下载了不影响审计完整性。

**一次性入口的安全规则**：

| 项 | 规则 |
|---|---|
| Token | 32B 随机值，与 `{userId, assetId, path, direction}` 绑定，**不是 API Key 本身** —— 传输通道泄露不等于凭证泄露 |
| 生命周期 | TTL 5min；上传 token 用后即焚；下载 token 单次使用 |
| 尺寸上限 | 申请时校验：上传 ≤ **200MB**，下载 ≤ **200MB**（HTTP 旁路下限值可远高于内联方案），超限 -32007 |
| sha256 校验 | 申请时提供 sha256 则强校验，不匹配拒收并作废入口 |
| 暂存区 | `<data>/transfer-staging/`（0700），随机文件名；TTL 15min 后台清理；磁盘配额 2GB，超配额拒绝新申请 |
| 路由注册 | `PUT /mcp/transfer/:id` 与 `GET /mcp/transfer/:id` 注册进 default-deny 路由表（ADR-011），`transfer-token` 访问模式 —— **不属于任何已注册 public 路径** |
| 鉴权链 | 入口申请走完整链（`can('invoke')` → guard_rules → write-ahead audit）；HTTP 传输只验一次性 token + 尺寸 + sha256，**不重复鉴权但审计归属仍为发起人** |

**连接池设计（替代子进程实例池）**：

| 项 | 规则 |
|---|---|
| 连接键 | `(assetId, credentialFingerprint)` —— 与实例池同构，凭证轮换即重连 |
| 复用 | 空闲 TTL 5min 后 close；同键并发复用 |
| 串行化 | 每连接 FIFO 串行（与 §5.4 同理由：可审计、可预测） |
| 全局并发 | 信号量 32；排队规则同 §5.4（3s 降级 / 15s 超时 -32002） |
| 断线 | 自动重连 1 次，仍失败返回 -32002 并标记资产 unhealthy |
| 主机指纹 | `host_conn.host_fingerprint` 首次由管理端"连通性测试"采集并信任（支持批量），后续校验不一致**拒绝连接** —— 不做自动信任，否则等于放弃 MITM 防护 |

**凭证注入（完全复用 §5.6 模型）**：`host_conn.authSlot` 指向 `server_credentials` 中绑定 SSH 私钥或密码的槽位。注入目标从"子进程 env"变为 `ssh2.connect({ privateKey | password })` —— **凭证的共享语义、创建者私有、审计到人三层模型一行都不用改**。私钥 `file:true` 情形：解密写临时文件 0600 → 传路径 → 用完 unlink。

**凭证必须按调用者解析（2026-11-17 修正实现缺陷）**：`dispatch` 在 `acquire` 时把 principal 一路传下去，SSH 槽位按 §4.2 取值顺序（personal 优先于 asset）解析。此前 `acquire` 不带调用者，所有使用者（含成员与 MCP 客户端）一律落到归属人的共享凭证上，成员在资产详情页自绑的个人凭证完全不生效 —— 界面说有、实际不用，等于安全模型在这条链路上是假的。同一修正同时保证：连接池键 `(assetId, credentialFingerprint, username)` 按凭证与账号分条，不同成员的 personal 凭证 → 不同条目，不会串用他人连接（同一凭证改用户名也必须换连接，否则沿用旧账号的连接表现为"改了没生效"）；`ssh_key` 凭证可携带 `username` 键（账号随凭证走，换资产不必重填），未携带时回落到 `host_conn.username`；**每条绑定还可单独指定用户名**（§4.3，优先级最高）；连通性测试与文件传输落位都按发起人自己的凭证建连。

**审计增强（原生工具比派生工具更需要）**：

| 事件 | 审计必记 |
|---|---|
| `host_execute_command` | command 全文（脱敏后）、exit_code、stdout/stderr 前 4KB |
| `host_request_upload`（intent，pending） | remote_path、声明 size、声明 sha256 —— write-ahead，**入口发出前先落审计** |
| 上传传输完成 | 实际 size、实际 sha256、**内容前 512B 指纹**（不落全文） |
| 上传落位完成 | remote_path、duration、rename 结果 |
| `host_request_download`（含拉取） | remote_path、size、sha256 —— **拉取即审计**，无论 agent 是否真的 GET |

理由：上传 + 执行 + 下载组合起来就是完整的横向移动链路。审计必须能事后还原"传了什么、跑了什么、取走了什么"。**上传是三条事件（申请 → 传输 → 落位），缺任何一条都算审计不完整。**

**配套规则库条目（§5.8，locked 内置）**：

| 新增规则 | kind | 说明 |
|---|---|---|
| 上传到 `/etc/`、`/root/.ssh/`、cron 目录、shell rc 文件 | **block** | 这类路径写入 = 持久化后门，不是高危而是禁止；在 `host_request_upload` 申请时即拦截 |
| `host_request_upload` 且路径后缀为 `.sh`/`.py`/`.service` | mark | 落脚本 = high |
| command 含 `curl\|wget ... \| sh`、`base64 -d`、反弹 shell 特征 | **block** | 已内置规则扩展 |

**已知限制（写入部署文档）**：非交互 shell 无 PTY；不做命令白名单（那是 guard_rules 的职责，执行层不做第二套判断）；输出截断 4KB；Windows 目标机不支持；**上传/下载依赖网关暂存盘（配额 2GB），超大文件传输需分批**。

### 5.6 凭证加密与注入

**加密**：AES-256-GCM（node:crypto），格式 `v1.<iv b64>.<tag b64>.<ciphertext b64>`，**AAD = credentialId**（绑密文与凭证实体，防密文挪用）。密钥 32B 来自 `OPSGATE_CREDENTIAL_KEY` env 或 `<data>/credentials.key`（0600，首启生成）。

**注入时机**：仅实例创建时（拉起子进程前 / 建 HTTP 连接前）。凭证值永不出实例池层、永不落日志、永不进入 `tools/list` 响应。

**注入点五类**：
- `env`：占位符 → 解密值写入 spawn env（`execution_mode='mcp'`）
- `args`：`--host ${HOST}` → 运行时替换（不入持久化配置）
- `headers`：HTTP 型资产替换后注入；**同时从 passthrough headers 中剔除已绑定槽位名**，防止调用方覆盖
- `file:true`：写临时文件（0600），env 值换为路径
- **`ssh2`：原生主机资产（`execution_mode='native'`）** —— `host_conn.authSlot` 指向的凭证解密后直接作为 `ssh2.connect({ privateKey | password })` 参数，**不经过任何子进程、不落地 env**。凭证的归属人私有 + 按分组共享（ADR-028）、审计到人三层模型一行不变，只是注入目标换了

**SSRF 防护（用户决策：保持 fail-closed）**：资产 URL 保存时即校验 —— 解析 DNS → `ipaddr.js` 判定私网/环回/链路本地/云元数据（169.254.169.254）→ **默认拒绝**。资产表 `allow_private_network=0|1` 按资产显式开启（默认 0），变更写治理类审计。运行时 fetch 禁止跨主机自动重定向。

> 你的场景资产全是内网地址，所以这 300 个资产实际上**每个都要开一次**。为降低重复操作，`allow_private_network` 支持批量设置（资产列表勾选题 + 分组级批量），但**不做全局默认开启** —— 保留 fail-closed 的审计价值。

**审计脱敏**：递归遍历参数，key 匹配 `password|secret|token|key|passwd|credential`（忽略大小写）→ `***`；与已注入凭证值精确比对相等 → `***credential***`；其余截断 4KB。output 仅前 4KB + 结构摘要。子进程 stderr 进管理端前跑同一套脱敏（stderr 可能回显 env）。

### 5.7 审计（write-ahead）

见 §6 硬约束 2。补充：被规则引擎 `block` 的调用**同样先写 intent**（status='blocked'）再返回拒绝 —— 拦截本身也是审计事件。

### 5.8 规则引擎（WAF 式，用户决策）

> 高危定义不做硬编码，做成可维护的规则表。原设计中硬编码的 `toolCallGuard` 两层规则（always-on SSRF + execution RCE）一并外部化进同一张 `guard_rules` 表，作为 `locked=1` 的内置数据播种 —— 一个引擎、一处管理、一份代码。

**执行顺序**（每次 `tools/call`，在鉴权之后、实例获取之前）：

```
1. 取启用规则（内存数组，按 priority 降序）
2. 构造匹配上下文:
   ctx.tool        = 工具名
   ctx.argsText    = 递归拼接的参数值（截断 4KB，脱敏之前）
   ctx.assetType   = server.category
   ctx.groups      = 资产所属分组名数组
3. 先跑 kind='block' 的规则:
   命中 → 写 intent(status='blocked', risk='high')
        → 返回 -32004 { ruleId, ruleName, reason }
        → 不拉起实例、不注入凭证
4. 再跑 kind='mark' 的规则:
   命中 → risk='high'；全不命中 → risk='normal'
5. 继续 §6 约束 2 的 write-ahead 流程
```

**正则安全要求（硬性）**：所有 pattern 必须线性无回溯 —— 禁止嵌套量词 `(a+)+`、禁止回溯引用 `\1`、禁止 `.*.*` 串联。入库前用 `recheck`/`safe-regex2` 校验，不通过直接拒绝保存。理由：ReDoS 在网关进程里是单线程阻塞，一次恶意输入能卡死全部 20 个用户。

**性能**：规则条数量级 10–30，每次调用对 4KB 文本跑一遍，单条线性正则微秒级，不构成瓶颈。规则命中时异步 +1 到 `hit_count`（不阻塞调用）。

**管理界面**：设置页 → 安全策略 Tab，两个区块
- 「高危标记规则」（kind=mark）：可增删改，内置规则标注"内置"徽章
- 「拦截规则」（kind=block）：内置四条标 `locked` 徽章、**不可关闭**；用户可追加自定义拦截规则

规则任何增删改 → 写治理类审计事件 + 内存热重载。

### 5.9 原生工具扩展框架（ADR-023）

> **为什么现在就设计，而不是等加了五六个工具再重构**：原生化的代价是平台要长期维护这些工具。如果每个工具硬编码进 `mcpEntryService`，第 6 个工具开始就会复制粘贴横切逻辑（鉴权 / 审计 / 规则 / 连接获取），第 10 个工具时 ADR-012 与 ADR-013 必然被绕过一两处。**扩展机制必须与第一个原生工具同时落地**，否则安全边界会随工具数量线性劣化。

#### 5.9.1 两层正交扩展：Connector × Tool

| 层 | 职责 | 数量关系 |
|---|---|---|
| **Connector**（协议） | 建立并池化到目标的连接、注入凭证、健康检查 | 少而稳定（ssh / sftp / http / db …） |
| **Tool**（能力） | 用 connector handle 完成一个原子动作，定义 schema 与描述 | 多而演进 |

两层正交带来两个不同的扩展成本：

- **新增协议** → 只加一个 Connector，**该协议下所有既有工具自动可用**（加 WinRM connector ⇒ `host_execute_command` 立刻支持 Windows 主机，零工具代码）
- **新增能力** → 只加一个 Tool 文件，**不改任何框架代码**

```ts
interface Connector<H> {
  type: 'ssh' | 'sftp' | 'http' | 'db' | string;
  acquire(asset: Asset, credentialRef: string): Promise<H>;  // 池化、复用、idle TTL
  release(h: H): void;
  invalidate(assetId: string): void;   // 凭证轮换 / 主机指纹变更 / 配置变更
  stats(): PoolStats;                  // 供 /instances 与 /runtime 展示
}
```

#### 5.9.2 工具契约：作者只写两样东西

```ts
interface NativeToolDefinition<H> {
  id: 'host.execute_command';        // 稳定标识，进审计与规则，不随改名变化
  category: 'host' | 'mysql' | 'k8s' | 'other';
  connector: 'ssh';                  // 声明依赖哪个 connector
  risk: 'read' | 'write' | 'destructive';
  audit: AuditSpec;                  // 声明从入参/结果抽哪些字段进审计
  // ── 以下是作者真正写的部分 ──
  name: string;                      // 暴露名，强制 {category}_ 前缀
  description: string;               // 四段式（§5.5.3 R1–R8）
  inputSchema: JSONSchema;           // **不含 asset**，由框架注入
  execute(ctx: { handle: H; asset: Asset; signal }, args): Promise<ToolResult>;
}
```

一个典型原生工具的实质代码是 **一个 `execute` + 一份 schema，通常 ≤50 行**，其余全是声明。

#### 5.9.3 框架统一承担的横切关注点（工具严禁自己实现）

| 关注点 | 由框架做 | 工具作者 |
|---|---|---|
| `asset` 参数注入、解析、权限校验 | ✅ | ❌ 不写 |
| `can('invoke')` 鉴权（ADR-013） | ✅ | ❌ |
| guard_rules 匹配（block / mark） | ✅ | ❌ |
| write-ahead 审计（ADR-012） | ✅ | ❌ 只声明抽字段 |
| 凭证解密与注入（§5.6） | ✅ | ❌ |
| 连接获取、池化、健康检查 | ✅ | ❌ |
| 输出截断（4KB）与脱敏 | ✅ | ❌ |
| 错误码映射（-32002 / -32006 / -32007） | ✅ | ❌ |
| 文件传输旁路（§5.5.7 临时入口） | ✅ | ❌ |
| description 规范校验（R1–R8） | ✅ CI | ❌ |
| 指标与连接池统计上报 | ✅ | ❌ |

#### 5.9.4 边界用 CI 强制，不靠文档约定

这几条边界**漏掉的每一处都是安全边界**（ADR-012 / ADR-013），所以必须是程序化硬闸门：

| 强制手段 | 断言内容 |
|---|---|
| **自定义 ESLint 规则** | `src/native/tools/**` 内**禁止 import** `ssh2`、`authorize`、`auditService`、`credentialService`、`instancePool` —— 只允许从 `./framework` 取能力 |
| **静态校验（CI + 启动）** | 每个定义必须通过 R1–R8：工具名 `{category}_` 前缀、description 含 `asset` 取值指引、长度上限、参数 description 非空 |
| **启动期 fail-fast** | 工具 id 重复 / category 冲突 / 声明的 connector 不存在 / 与派生工具同名 → **进程启动失败并打印违规项**（与 ADR-011 同源的设计哲学） |
| **契约测试遍历注册表** | 对每个已注册工具自动跑：注入无权 asset 必返 -32006、审计不可用必返 -32003、命中 block 必返 -32004 —— 新工具自动纳入，作者无需手写用例 |

> 最后一条最关键：契约测试**遍历注册表**而非逐个手写，所以新增工具天然被覆盖，不依赖作者"记得写测试"。

#### 5.9.5 注册、命名空间与冲突

| 项 | 规则 |
|---|---|
| 目录约定 | `src/native/tools/<category>/<id>.ts`，barrel 自动 import，无需手工登记 |
| 审计/规则命名空间 | 原生 `native:<toolId>`，派生 `derived:<serverId>:<tool>` —— 规则 `target=tool` 可按命名空间精确命中一类 |
| 同名冲突 | 与派生工具同名时**原生优先**并启动告警（原生 schema 稳定，优先于社区漂移） |
| 启用开关 | 管理端 `/native-tools` 页列全部原生工具（id / category / connector / risk / 命中次数），支持停用 —— 停用即从 `tools/list` 移除，用于灰度与故障隔离 |
| 归属 category | 仅决定 `asset_type` 规则维度，与派生工具完全一致（ADR-026：与分组无关） |

#### 5.9.6 与既有模型的三处接缝

| 接缝 | 处理方式 |
|---|---|
| **授权** | 原生与派生共用同一个 `can('invoke')` —— 不因"这是自研的"就开后门 |
| **审计** | `audit_log.tool` 统一格式 `native:<id>` / `derived:<tool>`；详情页按 `AuditSpec` 渲染抽出的字段 |
| **资源** | 两个池并列：ConnectorPool（原生）/ InstancePool（派生），`/instances` 页分双池展示（§8.5） |

#### 5.9.7 用三个假想需求检验框架够不够

| 未来需求 | 需要写什么 | 框架改动 |
|---|---|---|
| 支持 Windows 主机（WinRM） | 1 个 WinRM connector | **0** —— `host_execute_command` 直接可用 |
| 加磁盘/进程/服务巡检 | 3 个 tool 文件，各 ≤50 行 | **0** |
| K8s 能力逐步原生化（先只读） | 1 个 k8s connector + 2–3 个 tool | **0** —— 可与社区实现并存，按 asset 切换 |
| 加一个全新品类（如 SNMP 设备） | 1 connector + N tool + 表单支持该 category | 仅 category 枚举扩一项 |

#### 5.9.8 明确不做版本化（避免误设计）

`tools/list` 每次连接重新拉取，客户端不跨连接缓存 schema —— 原生工具 schema 变更**不需要版本号**，只需 changelog。派生工具同理（社区实现虽可能随 `npx -y` 漂移，但版本已由 Market 固化在配置快照里）。

#### 5.9.9 反模式清单（写进 CONTRIBUTING）

1. 工具自己 `ssh2.connect()` —— 绕过池化，300 台主机连接数失控
2. 工具自己判权限 —— 绕过 `can()` 单一真值源（ADR-013 破裂）
3. 工具自己写审计 —— 绕过 write-ahead（ADR-012 破裂）
4. 工具把资产清单写进 description —— R2，漂移 + 越权泄露
5. 工具把大文件内容塞进返回值 —— 应走 §5.5.7 临时入口
6. 工具做破坏性动作却不声明 `risk:'destructive'` —— 规则引擎与前端警示都依赖这个声明

---

## 5.10 配置管理：三层模型 + 配置字典（ADR-024）

### 5.10.0 为什么要这一节

上一版的实际痛点是：**改一个超时时间要改代码、重新构建、重启服务**。300 台主机的环境里，"把命令超时从 30s 调到 60s"是运维日常，不该是发版事件。

`guard_rules` 已经是"UI 维护的字典表"（第 6 轮决策：高危操作定义做成 WAF 式规则库）。**本节是同一思路在平台运行参数上的推广** —— 凡是运维需要按环境调整的**策略**，都应该是运行时可改的数据，而不是编译进代码的常量。

### 5.10.1 三层模型（关键：不是所有配置都进数据库）

| 层 | 存放 | 谁能改 | 规模 | 判据 |
|---|---|---|---|---|
| **L0 引导配置** | 环境变量 / `<data>/credentials.key` | 部署者，改了要重启 | **≤ 8 项** | **读它之前连不上数据库**，或**它被用来保护数据库内容** |
| **L1 系统设置** | `system_settings` 表 | admin 在 UI 系统设置页 | 全部运维策略 | 运行时需要按环境调整的策略值 |
| **L2 代码常量** | `src/config/constants.ts` | 改了就是改代码，走发版 | 结构契约 | 协议形状 / 正则 / 错误码 / 加密格式 |

**L0 只有 8 项，且必须由"死锁判据"逐条证明**（多一项都是偷懒）：

| 项 | 为什么不能进 DB |
|---|---|
| `OPSGATE_DATA_DIR` / `OPSGATE_DB_PATH` | 连数据库的路径本身不能来自数据库 |
| `OPSGATE_CREDENTIAL_KEY` | 用它加密凭证，不能存在它保护的数据旁边（循环） |
| `OPSGATE_PORT` / `OPSGATE_BIND` | 服务没起来就没有 UI 可改 |
| `OPSGATE_SESSION_SECRET` | 同上，且属密钥 |
| `OPSGATE_ADMIN_INIT` | 首次启动建账号，此时表是空的（仅首次生效） |
| `OPSGATE_LOG_LEVEL` | 数据库还没连上时就要能打日志（排障刚需） |

除这 8 项之外**一切**走 L1。新增 L0 项必须在本表补一行理由，否则评审打回。

### 5.10.2 `system_settings` 表（配置字典）

| 字段 | 类型 | 说明 |
|---|---|---|
| key | text PK | 命名空间化，如 `instance_pool.global_budget` |
| value | text | **统一 JSON 编码字符串**，不按类型分列 |
| value_type | text | `int` \| `float` \| `bool` \| `string` \| `json` \| `duration` \| `size` |
| category | text | UI 分区：`instance_pool` / `ssh_pool` / `tools` / `transfer` / `audit` / `general` |
| default_value | text | 内置默认值快照（用于 UI 显示与"恢复默认"） |
| min_value / max_value | integer nullable | 数值范围，写入时校验 |
| options | JSON nullable | 枚举型的可选值 |
| is_secret | integer(bool) | UI 掩码显示；审计只记 `***` |
| requires_restart | integer(bool) | 改动后需重启才生效 |
| updated_by | text FK→users | |
| updated_at | integer | |

**为什么 `value` 统一存 text 而不是多列**：SQLite 弱类型，多列会产生"哪一列有效"的歧义（比单列难维护得多）。单一 text + `value_type` 标签 + zod 解析，是唯一能同时保证类型安全与可扩展的形态。

**只存偏离默认值的行**：默认值在代码 `SETTINGS_SCHEMA` 里，DB 里没有的行 = 用默认值。这样新装实例不需要一堆 INSERT 种子，升级新增配置项也不需要迁移。

### 5.10.3 声明式 schema（关键机制）

代码里一份 `SETTINGS_SCHEMA` 是**唯一的定义源**，DB 只是覆盖层：

```ts
{
  key: 'instance_pool.global_budget',
  type: 'int',
  default: 80, min: 1, max: 96,
  category: 'instance_pool',
  label: '全局实例预算',
  description: '16GB 部署机上的实例总预算；硬上限 96',
  requiresRestart: false,
  secret: false,
}
```

- **读**：`settings.get(key)` → 内存缓存（变更时 invalidate）→ DB → schema 默认值。业务代码永远调 `settings.get()`，**不直接读 `process.env`，不硬编码策略值**。
- **写**：`PATCH /settings/:key` → admin 校验 → 类型 + 范围 + options 校验 → **write-ahead 审计**（记 before/after，secret 项记 `***`）→ 落库 → invalidate 缓存。
- **启动期校验**（fail-fast，R-1 哲学）：遍历 DB 全部行，① schema 中不存在 → **告警孤儿配置**（不静默忽略）② 类型或范围非法 → **启动失败**。

新增配置项 = schema 加一行，**零迁移**；删除配置项 = schema 删一行，DB 孤儿行在启动期被检出。

### 5.10.4 生效语义

多数配置**热生效**（下次读取即生效）。少数结构性参数（池容量初始化、连接信号量）标 `requires_restart=true`，UI 上：

- 该项显示"需重启"徽章；
- 修改后进入 **pending 状态**，页面顶部出现"N 项待重启生效"提示条；
- **生效前 UI 必须显示"当前生效值 ≠ 已保存值"**，禁止让管理员以为改了就生效。

### 5.10.5 红线：以下六项永远不可配置（进 UI 即视为违规）

1. **审计开关** —— R-2 明文：不得存在跳过审计的开关、配置或 try-catch 旁路；
2. **路由 `accessMode`** —— R-1 default-deny，是编译期 TS 必填 + 启动期断言，运行时可改等于架空；
3. **`can()` 判定逻辑** —— R-3 单一真值源；
4. **凭证加密主密钥** —— L0，循环依赖；
5. **数据库路径** —— L0，启动死锁；
6. **`guard_rules` 中 `locked=1` 的内置规则** —— 与既有约束保持一致。

配置字典管的是"**策略值**"，不管"**安全不变量**"。CI 需加一条静态检查：`SETTINGS_SCHEMA` 中不得出现匹配 `/audit.*(enable|disable|skip)|accessMode|authorize/i` 的 key。

### 5.10.6 L1 配置清单（从 §4 常量表搬入，逐项标注）

| key | 默认 | 范围 | 热生效 |
|---|---|---|---|
| `instance_pool.global_budget` | 80 | 1–96 | ✅ |
| `instance_pool.global_weight_budget` | 200 | 1–1000 | ✅ |
| `instance_pool.max_per_asset` | 2 | 1–4 | ✅ |
| `instance_pool.queue_per_user` | 8 | 1–64 | ✅ |
| `instance_pool.global_concurrency` | 64 | 1–512 | ❌ 重启 |
| `instance_pool.idle_ttl_sec` | 300 | 30–3600 | ✅ |
| `instance_pool.queue_timeout_sec` | 15 | 5–120 | ✅ |
| `instance_pool.degrade_wait_sec` | 3 | 1–30 | ✅ |
| `ssh_pool.idle_ttl_sec` | 300 | 30–3600 | ✅ |
| `ssh_pool.global_semaphore` | 32 | 1–256 | ❌ 重启 |
| `tools.list_max` | 200 | 10–500 | ✅ |
| `tools.output_truncate_bytes` | 4096 | 512–65536 | ✅ |
| `tools.command_timeout_sec` | 30 | 5–300 | ✅ |
| `tools.schema_token_budget` | 15000 | 5000–50000 | ✅ |
| `transfer.max_file_bytes` | 209715200 | 1MB–2GB | ✅ |
| `transfer.entry_ttl_sec` | 300 | 60–3600 | ✅ |
| `transfer.staging_quota_bytes` | 2147483648 | — | ✅ |
| `transfer.staging_ttl_sec` | 900 | 60–86400 | ✅ |
| `audit.retention_months` | 12 | 1–60 | ✅ |
| `audit.arg_truncate_bytes` | 4096 | 512–65536 | ✅ |
| `credentials.max_slots` | 32 | 1–64 | ✅ |
| `general.credential_user_warn_threshold` | 5 | 1–100 | ✅ |

**留在 L2（代码常量，UI 不可改）**：占位符正则、敏感键启发式、脱敏 key 正则、加密格式 `v1.<iv>.<tag>.<ciphertext>`、实例键构成、错误码表、协议形状。这些是**契约**，改了就是改代码。

### 5.10.7 审计与权限

- 系统设置页 `accessMode = admin-only`；非 admin 访问返回 403（不是 404，ADR-011）。
- 每次配置变更进审计表，`object_type='system_setting'`，记 `key` + before + after；`is_secret` 项 value 记 `***`。
- 配置变更是**高危管理动作**：审计列表里可筛"系统设置变更"，用于回答"谁把文件传输上限从 200MB 改成了 2GB"。

---

## 6. 三条安全硬约束（优先级高于一般功能设计）

这三条对应本品类已发生的事故：Obot 两个授权绕过 CVE（CVSS 9.6 / 8.6，均源于路径前缀匹配 fail-open）、MCPHub 无 Bearer key 时默认放行、MCPHub sessionId 无属主校验。

### 约束 1：default-deny 路由注册表（ADR-011）

**为什么不用纯中间件枚举**：Obot 的 CVE 正是"授权中间件挂在前缀上、新路径不在前缀内就 fail-open"。任何"我把要保护的路由列出来"的方案，新增路由时都会重演事故。

**四层防线，缺一不可**：

1. **TS 编译期**：`RouteDefinition.accessMode` 是必填字段 —— 不声明，代码编不过。对生成式代码尤其关键：LLM 新增路由时不可能绕过类型签名。
2. **启动期自检（fail-fast）**：`public` 路由必须命中硬编码断言清单（`['POST /api/v1/auth/login', 'GET /healthz']`），清单外的 public 路由 → `process.exit(1)` 并打印违规路由。"临时加个公开调试端点"在 CI 就死。
3. **运行期根级兜底**：Fastify `app.addHook('preHandler')` 挂根，对每个请求执行 `authorize(req)`；不在注册表中的 URL（含绕过 registry 直接 `app.get()` 的路径）→ 一律 403。注册表之外不存在可达路径。
4. **403 ≠ 404**：未声明路径返回 403 而非 404，避免用 404 探测端点存在性。

**MCP 入口**：`/mcp`（无论 `?group=` / `?tag=` 取何值）的三种 HTTP 方法全部注册为 `api-key` 模式 —— **无 Bearer key 一律 401，代码里不存在"未配置 key 时默认放行"的分支**。

**sessionId 属主校验**：MCP 会话 ID 由 `userId + groupId` 派生并记录归属，`tools/call` 时校验 `session.ownerUserId === principal.userId`，不匹配即 403。

### 约束 2：write-ahead audit（ADR-012）—— 全产品最高验收标准

```
tools/call 到达
  → [1] 鉴权 + 规则引擎 block 判定（§5.8）
  → [2] 解析实例键、确定将注入的 credentialId
  → [3] ★ 写 intent 审计记录 (status='pending')
         └─ 写失败 → 返回 -32003 "Audit unavailable; call refused"
            不拉起实例、不注入凭证、不执行任何下游操作
  → [4] 实例池 acquire → 凭证注入 → 串行执行
  → [5] 同一主键回填: status / duration_ms / output_summary / error_message
         └─ 回填失败：保持 pending，reconciler 每 5min 扫 >10min 的 pending
            标记 status='unknown' 并告警
```

- 审计写入是调用的**前置同步事务**，不是 fire-and-forget
- **不做降级旁路，不提供"临时跳过审计"开关** —— 任何绕过路径都不存在
- intent 与 result 是**同一条记录的两个阶段**（同主键 UPDATE），不存在"结果写失败导致调用无审计"的窗口
- 明确选择：**用可用性换可审计性**（运维场景正确）

### 约束 3：授权单一真值源（ADR-013）

```typescript
// services/authorize.ts —— 全项目唯一的资产授权判定函数
export function can(
  action: 'view' | 'invoke' | 'manage',
  asset: { ownerId; visibility: 'owner'|'group'|'public'; sharedWithUserIds; groupIds },
  principal: { userId; isAdmin; groupIds },
): boolean;
```

- `manage`：`isAdmin || ownerId === userId`
- `view` / `invoke`：**同一个布尔表达式**（可见即可用，不做"可见但不可用"的细分 —— 那是角色矩阵的滑坡）
  `isAdmin || ownerId===userId || visibility==='public' || sharedWithUserIds.includes(userId) || (资产所在分组 ∩ 用户所在分组 非空)`

> **2026-11-17 修订（用户决策）**：分组关联**本身构成查看权**，不再要求额外把 `visibility` 切到 `'group'`。
> 原表达式里 `visibility==='group' && groupIds 有交集` 导致「已关联进分组、但可见范围仍是 owner」的资产
> 对组员既不可见也不可调用 —— 组员连详情页都进不去，也无法在详情页绑定自己的凭证（AC-25 的本意被卡死）。
> 现在 `visibility='owner'` 的语义收窄为"只对**不在任何共同分组**的人不可见"。
> 同步影响：`can('view')` 与 `can('invoke')` 仍然共用同一表达式，单一真值源不变。

**防漂移的结构性约束**：
1. 调用方全项目仅四处：`mcpEntryService`（tools/list 聚合 + tools/call 路由）、`serverService`（REST 读）、`auditService`（审计详情过滤）、前端经 REST 间接受益。DB 层不做行级过滤（SQLite 无 RLS），过滤一律在调用 `can()` 之后。
2. view 与 invoke 在函数内部共享同一表达式，实现层面杜绝"list 一套、call 另一套"。
3. 参数化测试断言 `can('view', ...) === can('invoke', ...)` 对全部可见性组合成立 —— 把单一真值源变成回归可验证的不变量。

**凭证授权不进 `can()`，由 `canCredential` 独立判定（ADR-028 修订）：**

```typescript
// 凭证只有三种能力：manage / use / view
export function canCredential(
  principal: { userId; isAdmin },
  cred: { ownerId: string | null },
  sharedGroupIds: string[],   // 该凭证共享到的分组
  userGroupIds: string[],     // 用户所在分组
): boolean {
  if (principal.isAdmin) return true;
  if (cred.ownerId === principal.userId) return true;   // 归属人
  // use / view：必须存在「凭证共享到的分组」∩「用户所在分组」—— 不默认跨组
  return sharedGroupIds.some((g) => userGroupIds.includes(g));
}
```

**为什么凭证上仍没有 `visibility` 字段**：跨人共享走 `credential_group_shares` 表（按**分组**共享），
不按人列名单。这样共享的粒度就是运维实际的组织单元，也避免了"人名单随人员变动需要手工维护"。

**与 ADR-019 的差别**：ADR-019 让使用权从「绑定资产的 `can('invoke')`」派生。ADR-028 恢复显式共享后，
若仍从资产派生，成员只要看得见资产就自动获得凭证使用权 —— 与「没共享就看不到」矛盾。
共享必须由归属人**显式**发起。

**防转授权仍然成立**：写入侧仍只允许绑自己创建的凭证（`assertOwnCredentialOrAdmin`），
所以"Bob 借 Alice 的凭证再传给 Charlie"在结构上不存在。

> 平台 admin 是唯一例外（全放行）：admin 绕过资产授权直接可见可操作全部资源，但**不绕过审计**（每条操作仍记 `userId`）。此例外是 v0 阶段的历史辩论结论，已在 v1 重新确认并固化于 ADR-004，不再依赖任何外部文档。

---

## 7. API 端点清单

统一响应 `{code, data, message}`，前缀 `/api/v1`。管理端 session cookie，agent 端 Bearer API Key。

**认证**：`POST /auth/login|logout`、`GET /auth/me`、CRUD `/api-keys`
**Market（v1 必修，ADR-025）**：
- `GET /market/catalog?q=&category=&page=` → `{items:[{key,name,displayName,description,repository,categories,tags,runtime,addedCount}], total, page}`；`addedCount` = 当前用户已从此条目创建的资产数（>0 即显示"已添加"徽章）
- `GET /market/catalog/:pkgName` → 目录条目详情 + **展开预览**（将生成的 `command/args/env` 原文，供高级用户核对）+ **自动识别出的槽位清单**（`{target,name,label,file,sensitive}`）
- `POST /market/instantiate` → `{pkgName, name, displayName, credentialRefs:{[slotName]: credentialId|null}, config?}` → 创建 Server + 绑定槽位 + 异步预热；`name` 冲突返回 400；槽位漏绑**允许**（返回 `missingSlots` 供提示，运行时该变量不注入、由产品自己报错），不阻断创建。`config` 为**可选自定义配置覆盖**（`{command,args,env,headers,url}`，未传字段沿用目录默认值）—— 管理端在目录默认配置上追加参数/env/kv 时传入；**槽位按最终配置识别**（改了 env/args/headers → 槽位随之变化）
- `POST /market/batch-instantiate` → **v1.1**（决策 B），v1 返回 501 且不在路由表中注册（不注册即 default-deny 403，符合 AC-3）

**资产**：`GET /servers`（按调用者可见性过滤）、`POST|GET|PATCH|DELETE /servers/:id`、`POST /servers/:id/test`（连通性 + 冷启动耗时）、`POST /servers/:id/prewarm`、`GET|PATCH /servers/:id/tools`、`GET /servers/:id/instances`

> **`PATCH /servers/:id` 可改字段（ADR-035）**：`name` / `displayName` / `description` / `tags` / `hostConn` / `url` / `allowPrivateNetwork` / `allowInsecureTls` / `visibility` / `sharedWithUserIds` / `credentialSlots` / `enabled`。
> **`category` / `executionMode` / `type` / `command` / `args` / `env` / `headers` 创建后不可改** —— 传任一即整批 400（不静默忽略、不部分生效），message 提示"如需调整请重建资产"。理由：这七个字段决定"资产是什么"（工具名前缀、策略作用域、实例计划）与"怎么跑"，在旧资产上换形态会让已绑定槽位、已签发工具名与既有审计语义同时失效。

**凭证**（ADR-028 修订）：`GET|POST /credentials`（列表 = 自己创建的 ∪ 已共享到自己所在分组的 ∪ 自己实际在用的；admin 见全部；返回含 `privileges`）、`PATCH|DELETE /credentials/:id`（仅归属人 + admin；PATCH 支持 `privileges`）、`POST /credentials/:id/rotate`（触发实例失效）、`GET /credentials/:id/reveal`（**查看明文值，仅归属人 + admin；写 `credential_reveal` 治理审计**）、**`POST|DELETE /credentials/:id/shares/:groupId`**（按分组开关共享，仅归属人 + admin；写 `credential_share` 治理审计）、`GET /credentials/:id`（详情，返回 `privileges` / `sharedGroups` / `canManage`；**归属人、admin、共享分组成员可读，其余 403**）、`GET|POST /servers/:id/slots`（槽位列表返回 `bindings[]` 含 scope/label/mine；绑定时**只能绑自己创建的凭证**，`scope` 由服务端按「是否为资产归属人」判定）、`PUT|DELETE /servers/:id/slots/:slotName/value`（**槽位直填值**，ADR-027：资产自带加密密钥，非凭证；与凭证绑定互斥）、`DELETE /servers/:id/slots/:slotName`（**只能解绑自己添加的那条**；写 `credential_unbind` 审计）、`GET /credentials/candidates?assetId=`（绑定下拉数据源，仅本人凭证；`boundSlots` 只算自己的绑定）

**成员**（ADR-028 §2.5）：`PATCH /users/:id` 支持 `isDisabled`（禁止禁用/降级自己）、`DELETE /users/:id`（凭证/资产转无主、清理 personal 绑定与分组关系、撤销 API Key；禁止删除自己）、`POST /admin/reassign-owner`（`{credentialId?|serverId?, newOwnerId}` 重新指派无主资源）
**分组**：CRUD `/groups`、`/groups/:id/servers`、`/groups/:id/users`
**审计**：`GET /audit?page=&userId=&serverId=&tool=&status=&risk=&from=&to=&scope=management|asset`、`GET /audit/stats?groupBy=asset|global&window=24h|7d|30d&assetId=`、`GET /audit/:id`、CSV 导出。`scope` 按**动作性质**划分日志范围：`management` = 治理类动作（可见性/凭证/分组/规则库/原生工具/系统设置），`asset` = 资产的具体操作（工具调用/传输/拦截/认证失败）；不用 `server_id` 判定（治理事件的主体占位符不统一）。列表直接返回写入时快照的 `username` 与 `server_name`（不给 id 片段）
**规则库**：`GET|POST /guard-rules?kind=`、`PATCH|DELETE /guard-rules/:id`（`locked=1` 返回 403）、`POST /guard-rules/test`（输入样例文本，返回命中规则，用于调试正则）
**运行时**：`GET /runtime/instances`、`GET /runtime/metrics`（Prometheus 文本）、`GET /runtime/ssh-connections`（原生连接池：活跃连接数 / 空闲 / 指纹校验失败）、`GET /runtime/transfer-staging`（暂存区占用 / 待清理数）
**原生主机**：`POST /servers/:id/ssh/trust-fingerprint`（连通性测试时采集并信任主机指纹，支持批量勾选）
**系统设置（配置字典，admin-only）**：`GET /settings`（返回 `SETTINGS_SCHEMA` + 当前生效值 + 默认值 + 是否 pending 重启）、`PATCH /settings/:key`（`{value}`，类型/范围校验，write-ahead 审计）、`POST /settings/:key/reset`（恢复默认）、`GET /settings/pending-restart`（待重启生效项）

**Agent MCP**：`GET|POST|DELETE /mcp?group=:name&tag=:tag`
**工具暴露**：`GET /servers/:id/tools/raw`（社区原生 `tools/list`，用于核对裁剪结果）、`GET /mcp/preview?group=&tag=`（管理端预览：该端点将暴露的工具清单 + 生成的 `instructions` 原文 + 工具数，用于验收 R1–R8 描述规范）
**文件传输旁路**：`PUT /mcp/transfer/:id`（上传）、`GET /mcp/transfer/:id`（下载）—— 一次性 transfer-token 认证，注册进 default-deny 路由表为 `transfer-token` 访问模式（§5.5.7）

**错误码**：`-32002` 实例忙/排队超时（SSH 连接同样复用） · `-32003` 审计不可用（拒绝调用） · `-32004` 被拦截规则拒绝 · `-32005` 分组工具数超限（需 tag 收窄） · `-32006` 资产不存在或无权访问（**两者不区分**，message 内回带可见集内最近似候选） · **`-32007` 文件超出大小限制**（上传/下载 >200MB，或暂存区配额不足；提示分批传输） · **`-32008` 配置项校验失败**（key 不存在 / 类型不符 / 越界 / 命中不可配置红线） · `403` 未注册路径或未授权 · `401` 无 Bearer key

---

## 8. 前端设计规范

### 8.1 设计语言定位

**Product 寄存器**（控制台/后台/仪表板，标杆是"赢得熟悉感"）｜三轴刻度：Variance 3 / Motion 3 / Density 7

**关键词：冷静、精确、可信、密集而不拥挤。** 深色机房控制台（"值班室灯"气质）—— 深色底 + 钢青蓝操作色 + 琥珀安全信号灯 + 等宽技术值。

**对标**：Linear（hairline 边框、8px 网格、⌘K、150ms 收敛动效）、Grafana（状态色约定、深色面板、等宽数字、sparkline）、Stripe Dashboard（筛选 chip、审计"主体-动作-对象"叙事行）。刻意避开 Tailwind 默认 indigo 与 Datadog 紫（触碰 P0 紫粉红线邻域）。

**首屏反模板**：概览页不放"大标题+副标题+CTA"，直接是安全状态条 + 实例健康条 + 热资产表 + 最近高危审计事件流。

### 8.2 主色裁决：钢青蓝双档

PM 建议"深蓝主色 + 琥珀警示"——**方向采纳，实现修正**：

- 采纳深蓝：买家信任心智由 K8s / Azure / Datadog 生态训练而成，Product 寄存器标杆是熟悉感
- 修正纯藏青 `#1e3a5f`：明度 L≈0.3，压在深色底（L 0.16）上作选中态/链接/焦点环时不可辨 —— "授权状态一眼确认"会直接失败
- 解法：**同一 hue 家族（≈240）、按主题分亮度两档** —— 深色主题用亮钢青（L 0.66）作操作色，浅色主题压到企业深蓝（L 0.44）。品牌家族不分裂，两主题都达标
- 琥珀升格为**可见性/危险状态的唯一警示色**，不是普通语义色

### 8.3 Design Token（核心摘录，完整 CSS 见交付物）

```css
:root {
  --bg: oklch(0.16 0.008 240);          /* #101317 页面底 */
  --bg-2: oklch(0.19 0.008 240);        /* #151a1e 凹陷区/表头 */
  --surface: oklch(0.205 0.008 240);    /* #181d22 卡片/面板 */
  --surface-hover: oklch(0.235 0.009 240);
  --surface-raise: oklch(0.26 0.009 240);
  --fg: oklch(0.93 0.006 240);          /* #e6e9ee */
  --fg-2: oklch(0.76 0.008 240);
  --muted: oklch(0.6 0.01 240);
  --meta: oklch(0.47 0.01 240);
  --border: oklch(0.3 0.01 240);        /* hairline */
  --border-soft: oklch(0.26 0.009 240);
  --accent: oklch(0.66 0.12 240);       /* #4a93d8 钢青蓝，每屏≤2处 */
  --accent-on: oklch(0.16 0.03 250);
  --accent-hover: oklch(0.71 0.11 240);
  --accent-soft: oklch(0.66 0.12 240 / 0.14);
  --brand-navy: oklch(0.32 0.08 250);   /* #1e3a5f 仅登录页/浅色主题源 */
  --success: oklch(0.72 0.14 155);
  --warn: oklch(0.78 0.13 85);          /* 琥珀 = 安全警示专用信号灯 */
  --danger: oklch(0.66 0.18 25);
  --security-warn-bg: oklch(0.78 0.13 85 / 0.1);
  --security-warn-border: oklch(0.78 0.13 85 / 0.35);
  --font-mono: 'JetBrains Mono','Fira Code',ui-monospace,SFMono-Regular,Menlo,monospace;
  --text-base: 0.8125rem;               /* 13px 控制台正文基准 */
  --radius-sm: 4px; --radius-md: 6px; --radius-lg: 10px;
  --sidebar-w: 216px; --header-h: 48px; --container-max: 1440px;
  --motion-fast: 100ms; --motion-base: 150ms; --motion-enter: 220ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
}
[data-theme="light"] {
  --bg: oklch(0.975 0.003 240); --surface: oklch(0.995 0.002 240);
  --fg: oklch(0.22 0.012 240); --border: oklch(0.88 0.005 240);
  --accent: oklch(0.44 0.13 250);       /* #1e56b0 企业深蓝 */
  --accent-on: oklch(0.99 0.002 240);
  --warn: oklch(0.6 0.12 85); --danger: oklch(0.55 0.19 25);
}
```

Tailwind 映射：`colors` 全部指向 CSS 变量，禁止组件里出现裸 hex。

### 8.4 图标系统

**唯一图标库 `lucide-react` ^1.59.0**，按需 ESM import，统一 `size={16|20|24}` / `strokeWidth={1.75}` / `currentColor`。禁止 emoji、禁止第二套图标库、禁止用 ✓/✕ 字符当图标。

| 语义 | 图标 |
|---|---|
| 概览/市场/资产/凭证/分组/审计/实例 | `LayoutDashboard` / `Store` / `Server` / `KeyRound` / `FolderLock` / `ScrollText` / `Activity` |
| 可见性三态 | `Globe`=全员 / `Users`=指定组 / `User`=仅自己 |
| 公开可见警示 | `Globe` + 琥珀色 |
| 凭证已配置/缺失 | `ShieldCheck` / `ShieldAlert`(warn) |
| 高危审计事件 | `TriangleAlert` |
| 复制/导出 | `Copy` / `Check` / `Download` / `ClipboardList` |
| 连接状态 | **状态圆点 + 文字**双通道（不用图标） |

### 8.5 信息架构

**骨架**：左侧 Sidebar（216px，折叠 48px）+ 顶部 Header（48px：面包屑/⌘K/主题切换/用户菜单）+ 内容区（max-w 1440px）

**导航**：概览 `/` · 市场 `/market` · 资产 `/assets` · 凭证 `/credentials` · 分组 `/groups` · 审计 `/audit` · 实例 `/instances`(admin) · 系统组：成员 `/users`、设置 `/settings`(admin)

| 路由 | 核心区块 | 关键交互 |
|---|---|---|
| `/login` | 品牌藏青 `--brand-navy` 作视觉锚 | 错误内联，不暴露账号存在性差异 |
| `/` | **安全状态条**（公开可见资产 n · 凭证缺失 m · 今日拦截 k，非零琥珀警示）+ 实例健康条 + 热资产 Top5 + 最近高危审计事件流 + 端点复制区 | 安全条项点击带筛选直达对应列表/审计页 |
| `/market`(v1 必修) | 搜索 + 分类侧栏 + MCP 卡片网格（卡片含名称/一句话描述/类别/运行时/已添加徽章） | 卡片进详情；**空态与加载态必须实现**（目录为静态资源，请求失败要能重试而非白屏） |
| `/market/:key` | 左信息（工具清单/运行要求/仓库链接）/ 右添加面板（名称 + **可编辑配置** + 槽位取值） | 一键添加，全程不见 schema/JSON；底部折叠区"查看将生成的配置"供高级用户核对；添加成功后 → 直达 `/assets/:id`；**配置可编辑（表单 / JSON 两种方式）**：在目录默认配置上追加参数、env、kv，槽位按最终配置实时重算；**槽位取值与新建资产一致**：输入框直接填值（资产自带直填值，ADR-027）或点右侧 `+` 选择已有凭证，二者互斥 |
| `/assets` | 筛选栏 + 表格：名称/类型/**执行模式**/状态/凭证状态/**可见范围**/近24h调用/操作 | **分页 50/页** + 类型/分组/状态/可见范围筛选 + 搜索（资产平铺，用户确认可接受）；行内"审计"按钮直达 `/audit?asset=`；勾选题批量改分组/停用/设置 `allow_private_network`；**"新建主机"走原生表单**（host/port/username/认证凭证/tags），不经过 Market（ADR-022）；**"新建 MCP 资产"入口二选一**：① 按钮跳 `/market`（推荐路径）② "高级：手填配置"展开 command/args/env 表单（直调 `POST /servers`，供目录未收录的 MCP 使用）——**两条路径都必须能完成凭证绑定** |
| `/assets/:id` | 概要卡 + Tab（**凭证绑定**/可见性/调用统计/审计记录） | **凭证绑定 Tab（v1 缺陷必修）**：列出全部 `credentialSlots`，每行 = 槽位名 + 中文标签 + 当前绑定凭证（或"未绑定"琥珀警示）+ 下拉换绑 + 解绑；下拉数据源 `GET /credentials/candidates`（仅本人凭证）；换绑/解绑写治理审计；**全部槽位未绑定时顶部红色警示条"该资产当前不可用"**；支持"手动补槽位"（应对 Market 自动识别漏判）。**编辑入口唯一（ADR-035）**：头部「编辑」弹窗改基础信息/标签/连接目标，可见性 Tab 只读展示（标签、连接信息）+ 安全开关（私网、TLS），不在页面内联编辑；形态与执行配置不提供编辑入口 |
| `/credentials` | 表格：名称/类型/**被引用数**/**实际使用者**/更新时间/操作 | 列表**只显示自己创建的 + 自己实际在用的**（admin 见全部）；被引用 0 时数字琥珀色；"实际使用者"从绑定资产可见者去重推导 |
| `/credentials/:id` | 概要 + 引用资产列表 + 可见性 + 轮换 | 删除前强制展示将被断开的资产名单；**归属显示用户名**（非 id）；**值提示右侧眼睛图标**可查看明文（仅归属人 + admin，操作写 `credential_reveal` 审计）；**引用资产按资产去重**（一凭证绑同资产多槽位只列一行，附「绑定槽位」列） |
| `/groups` | 分组卡片：组名/资产数/**工具数**/成员数/端点 | **不预置任何分组**（ADR-026），全部由管理员自由创建；工具数恒定但资产数大时琥珀提示条 + 建议 tag 收窄；抽屉编辑（资产+成员勾选） |
| `/audit` | 检索条 + 时间预设 + 筛选 chip + 统计条 + 结果表 | 五要素列映射；默认视图"高危操作"；**「日志范围」下拉区分管理后台操作 / 资产具体操作**（按动作性质划分）；用户列显示**用户名**、资产列显示**资产名**（写入时快照，不给 id 片段） |
| `/instances` | 类型/PID/内存/CPU/连接数/uptime | 按内存排序；重启二次确认；**顶部区分两个池**：MCP 实例池 / SSH 连接池（活跃/空闲/指纹校验失败） |
| `/native-tools`(admin) | 原生工具清单：id / category / connector / risk / 命中次数 / 启用开关 | **新增原生工具 = 加一个文件，无需登记**（§5.9.5）；停用即从 `tools/list` 移除，用于灰度与故障隔离 |
| `/users` | 成员表：账号 / **身份（管理员·成员 两态）** / 最近活跃 / 已创建 API Key 数 | 身份下拉仅两项，**无角色矩阵** |
| `/settings` | Tab：**运行时参数** / 通用 / 安全策略 / 审计保留 / 接入端点 | **运行时参数 = 配置字典（§5.10）**，按 category 分区卡片（实例池 / SSH 连接池 / 工具暴露 / 文件传输 / 审计 / 通用）；每行：标签 + 说明 + 当前值（inline 编辑）+ 默认值（灰）+ 范围/单位；`requires_restart` 项带"需重启"徽章，改动后顶部出现"N 项待重启生效"琥珀提示条并**同时显示当前生效值**；每行有"恢复默认"；`is_secret` 项掩码显示。**安全策略 = 规则库管理**（两个区块：高危标记规则可增删改 / 拦截规则内置不可关），规则行含命中次数，支持"用样例文本测试"；表单分组，保存 toast |
| `/settings/guard-rules` | 同上的规则库主界面（若设置页 Tab 放不下则独立路由） | 新增规则模态：名称/类型(mark\|block)/匹配维度(tool\|arg\|asset_type\|group)/正则/优先级/说明；正则保存前做 ReDoS 校验，不通过内联报错 |

### 8.6 六条 P0 安全可见性规则（违反任何一条 = 退回重做）

> 设计目标：把买家（运维主管）对 Obot CVSS 9.6 类授权绕过的恐惧，转化为"任何授权状态不点进详情就能在列表行内确认"的硬规则。

**V1 · 列表行内可见性列（资产/凭证两个列表页强制）**
资产列表固定含"可见范围"列，图标 + 文字双通道（禁止只放图标）。凭证列表固定含"被引用数"（mono 数字，0 时琥珀色，点击跳"引用该凭证的资产"）与"**实际使用者**"（人数，从绑定资产的可见者去重推导）。筛选栏提供"可见范围"下拉，让主管能一键列出所有"全员可见"的资产。

**⚠ 凭证列表不含"引用范围 / 共享范围"列**（ADR-020 取消引用权，ADR-028 也未恢复按人共享）。共享后出现**「等级」列**（ADR-028，仅展示）与**「实际使用者 N 人」**——后者回答"现在有多少人在用"。共享开关在凭证**详情页**按分组维护，不在列表页。人数 > 阈值时该行琥珀警示。

**⚠ 资产绑定凭证的下拉列表只包含当前用户自己创建的凭证**（admin 见全部）。这不是前端过滤而已 —— 服务端绑定接口同样校验同主，否则返回 400。前端过滤是体验，服务端校验才是边界。

**V2 · public/危险状态禁止中性样式**
任何"全员可见"的资产 → 单元格用**琥珀警示徽章**（`Globe` 14px + "全员可见"，`--security-warn-bg` 底 / `--security-warn-border` 边 / `--warn` 字）。禁止用普通灰徽章蒙混。凭证侧对应的警示是"实际使用者 N 人"超阈值（§8.6 V1），不再有"全员可引用凭证"这一项。概览页安全状态条三项任一非零 → 琥珀高亮可点击；全部为零 → 整条 muted 安静显示（安静本身也是安全状态的传达）。

**V3 · 凭证引用关系双向可见**
凭证详情 → 引用资产列表；资产详情绑定表 → 凭证可点击跳转；删除凭证确认模态必须列出**完整名单**（不是数量），Danger 按钮文案"断开 N 个资产并删除"。

**V4 · 授权变化必入审计且界面可查**
换绑/新建/删除凭证、改可见性、改分组全部产生审计事件，落在治理类 `action` 枚举上。审计页内置视图 chip"授权变更"直接过滤治理动作 —— 主管要审计的是"人改了授权"，这正是 Obot 事故的教训。

**V5 · 状态用双通道，永不只靠颜色**
可见性/凭证状态/审计结果：图标或圆点 + 文字标签同时出现（色盲用户与截图汇报场景都成立）。

**V6 · 审计五要素一眼定位**

| 买家问句 | 界面落点 |
|---|---|
| 谁 | "操作者"列：账号 13px + 其下 11px meta `via Claude Desktop` |
| 在几点 | "时间"列：mono 12px（当日省日期，hover 完整 ISO） |
| 用哪个账号 | 操作者行内二级信息 + 展开详情的"凭证/账号"键值 |
| 对哪台机器 | "资产"列：mono `prod-mysql-03:3306`，点击跳资产详情 |
| 执行了什么 | "工具/动作" + "参数摘要"列：mono 工具名 + truncate 参数（敏感值 `•••`） |

### 8.7 资产详情【可见性】Tab（已修正：无角色列）

```
【Tab2 可见性】
- 顶部说明行：可见范围三态徽章 + 一句说明
  · Globe  "全员可见"  (琥珀警示徽章, --security-warn-*)
  · Users  "分组可见：核心数据库"
  · User   "仅自己可见"
  说明文案："拥有可见权即拥有调用权 —— 列表中出现的成员均可通过 AI agent 调用本资产"
- 成员表列：账号 | 来源(继承分组 / 单独授权) | 最近活跃
  （不设角色列；如需体现管理能力，仅一个"可管理配置"标记，
    并注明"来源于归属人或平台管理员，非角色"）
- 右上角 ghost "管理分组" 仅 owner/admin 可见
```

### 8.8 组件与无障碍基线

- **卡片**：`--surface` + 1px `--border` + radius-md + 无阴影；hover 仅改 border-color
- **表格**：行高 40px；表头 12px muted 大写 0.06em；数字/主机名/耗时 mono + tabular-nums；行操作 hover 才显示
- **按钮**：高 32/26px；Danger 实底仅用于不可逆操作；Loading 内置 spinner 禁重复提交
- **5 态强制**：Loading 骨架 / Empty 图标+引导+CTA / Error 具体错误+重试 / Edge truncate+虚拟滚动 / Success toast
- **破坏性确认**：必须列对象清单，禁止原生 `confirm`/`alert`
- **无障碍**：正文 ≥4.5:1（深色 fg/bg ≈ 12.6:1）；图标按钮全 aria-label；状态双通道；focus-visible 双层环；`prefers-reduced-motion` 全局降级为 opacity-only；模态焦点圈定 + Esc
- **响应式**：<768px 表格转卡片列表但**可见范围徽章保留在卡片首行**（安全信息不降级）

**Do**：hairline 代替阴影 · 技术值 mono+tabular-nums · 可见性列在列表行内 · public 用琥珀警示徽章 · 凭证引用双向可查 · 治理动作入审计 · 每屏 accent ≤2 处 · 凭证值 write-only UI
**Don't**：紫粉渐变/发光边框/毛玻璃 · emoji 图标 · schema/JSON 暴露给添加流程 · 原生 confirm · 等大统计卡网格首屏 · public 用中性灰徽章 · 侧边色条卡片 · 弹跳缓动 · "Welcome to"式占位文案

---

## 9. 验收标准（78 条 EARS，重点摘录）

1. **default-deny**：新增任一路由未声明 `accessMode` 时，编译不通过
2. **default-deny**：注册清单外的 `public` 路由时，进程启动失败并打印违规路由
3. **default-deny**：请求任一未注册路径返回 403（非 404）
4. **write-ahead audit**：审计写入失败时，tools/call 返回 -32003 且未执行任何下游操作
5. **write-ahead audit**：审计通道不可用时，不存在任何跳过审计的开关或配置
6. **授权一致性**：对全部可见性组合，`can('view') === can('invoke')` 参数化测试通过
7. **授权**：无 Bearer key 请求 `/mcp` 返回 401（不存在默认放行分支）
8. **授权**：跨用户复用 MCP sessionId 返回 403
9. **凭证**：任何 API 响应、日志、`tools/list` 中均不出现凭证明文，仅掩码
10. **资源**：300 资产登记 + 80 活跃实例下，网关进程 RSS < 4GB（部署机 16GB）
11. **资源**：实例空闲超过 TTL 后被回收，稳态实例数不随用户数增长
12. **审计**：每次调用可检索到"人 / 时间 / 凭证账号 / 资产 / 工具+参数"五要素
13. **Market**：从目录选中到连通测试成功的转化率（北极星指标：3 分钟内完成）
14. **审计保留**：12 个月内记录可检索，超期归档
15. **规则库**：`locked=1` 的内置拦截规则，通过任何 API 路径修改/删除均返回 403
16. **规则库**：提交含嵌套量词或回溯引用的正则时，保存接口返回 400 并说明 ReDoS 风险
17. **规则库**：命中标规则的请求，审计记录中 `risk=high` 且展开区显示命中的规则名
18. **规则库**：被 `kind=block` 规则拒绝的调用，同样先写 intent（status='blocked'）再返回 -32004
19. **工具暴露**：`tools/list` 超过 200 个工具时返回 -32005，不静默截断
20. **SSRF**：`allow_private_network=0` 的资产访问私网地址时，连接在建立前被拒绝
21. **凭证授权**：把凭证设为 `public` 后，未被授权任何绑定资产的用户调用时仍返回 403 —— 引用权 ≠ 使用权
22. **凭证授权**：凭证的使用权判定不读凭证自身的 `visibility` / `shared_with_user_ids`，仅由绑定资产的 `can('invoke')` 派生
23. **凭证轮换**：轮换后，所有绑定该凭证的资产在下一次调用时重建实例，不复用旧实例（实例键含凭证 `updated_at`）
24. **凭证共享**：同一凭证被 N 个资产绑定时，`server_credentials` 有 N 行、凭证表 1 行；N 个资产的实例互不影响
25. **凭证私有**：资产绑定凭证时，返回的候选列表不含他人创建的凭证；服务端收到跨主绑定请求返回 400（admin 除外）
26. **凭证私有**：`credentials` 表无 `visibility` / `shared_with_user_ids` 列；不存在任何按凭证可见性判定使用权的分支
27. **凭证私有**：Alice 的凭证绑在她的资产上、资产授权给 Bob 后，Bob 调用成功且审计 `credential_id` 指向该凭证
28. **凭证私有**：凭证详情页"实际使用者 N 人"与绑定资产可见者并集一致（去重后）
29. **工具聚合**：资产数从 10 增长到 300 时，同一端点的 `tools/list` 工具数**不变**（回归测试断言：工具数与资产数无关）
30. **工具聚合**：`tools/list` 中不出现任何凭证槽位参数（`${HOST}` / `${USER}` 等），agent 无法覆盖连接目标
31. **工具描述**：每个暴露工具的 description 均含 `asset` 取值指引；缺失时 `/mcp/preview` 校验返回不通过（R3 可回归验证）
32. **工具描述**：`tools/list` 全量 schema 序列化后 < 15k token（28 工具 × 200 字描述 + schema）
33. **零分发引导**：仅配置 endpoint + API Key 的裸客户端（未装任何 skill / 提示词），首次连接即能在 `initialize.instructions` 中读到工作流约束
34. **引导裁剪**：A 用户与 B 用户连接同一分组时，`instructions` 中出现的资产类型/数量按其各自可见性裁剪，不泄露对方资产
35. **错误即引导**：`asset` 填错时返回 -32006，且对"存在但无权"与"根本不存在"返回完全相同的 message（防探测）
36. **单入口 + 元工具暴露（ADR-032 制定，ADR-033 修订）**：`/mcp` 是唯一入口，裸 `/mcp` 初始化的 `tools/list` 恒为 **7 个平台工具**（`opsgate_list_assets` / `view_asset` / `list_groups` / `view_group` / `list_asset_tools` / `invoke` / `select_scope`），不派生任何品类/资产工具；请求 `?group=_all` 仍返回 400（不做兼容保留）。子项：
    - **36a 默认路径（ADR-033）**：`opsgate_list_asset_tools({asset})` 返回该资产的工具名 + schema（不含 `asset` 参数）；`opsgate_invoke({asset, tool, args})` 执行。`tool` 不属于该资产当前可用工具集时 → `-32601`；`args` 非对象 → `-32602`；资产不可见 → `-32006`（与不存在同口径）。该路径不依赖客户端消费 `notifications/tools/list_changed`。
    - **36b 可选路径（ADR-032）**：`opsgate_select_scope({group?, category?, tag?})` 按范围重算工具集并**替换**本会话视图（不累积），成功后 `sendToolListChanged()`。不取代 36a，两者共用同一份 `toolsOfAsset()` 真值源。
    - **36c 品类动态**：`?category=` / `select_scope({category})` 的合法取值来自 `servers.category ∪ market_entries.categories`；不存在的品类 → 400/-32602 并列出实际存在的品类；不在任何白名单里的新品类（如 elasticsearch/mq/monitor）只要存在资产即可收窄。
    - **36d 工具名唯一**：同一视图内 `tools/list` 的工具名不重复；原生工具与派生工具同名时保留先注册者，被省略者记入 `violations`（不静默丢弃）。
    - **36e schema 自洽**：`tools/list` 与 `list_asset_tools` 返回的每个 `inputSchema` 中，`required` 的每一项都必须存在于 `properties`。
    - **36f instructions 骨架可替换（2026-11-18 修订，取代"仅可追加"）**：`initialize.instructions` 由上到下为 动态头（视图/台数/工具数）→ 模式段（仅 platformOnly）→ 分组说明 → 骨架段。骨架段取 `mcp.instructions`；为空白时回退内置 `DEFAULT_WORKFLOW_INSTRUCTIONS`。动态三段是事实信息，不受该设置影响（不允许设置项改掉台数/工具数）。`/mcp/preview` 返回的 `instructions` 与真实 `initialize` **逐字节一致**。
37. **原生执行**：`execution_mode='native'` 的资产调用时，进程内**不产生任何子进程**（断言 `process` 子进程数不变），不走实例池
38. **原生执行**：300 台主机资产全部 native 时，实例池内 MCP 实例数 ≤ 34（MySQL 30 + K8s 4）
39. **原生执行**：`host_execute_command` 的审计记录含 command 全文、exit_code、stdout/stderr 摘要；缺失任一字段视为不通过
40. **文件传输**：文件本体不经过 MCP 工具参数 —— `host_request_upload` / `host_request_download` 的返回与 `host_upload_status` 的返回中均不含文件内容；tools/call 的 JSON-RPC 报文中文件内容字节数恒为 0
41. **文件传输**：上传走"申请入口 → HTTP PUT → 状态查询"三步；PUT 传输完成后网关自动 SFTP 推送并原子 rename（`.opsgate.tmp.` 前缀），中途失败时目标路径不存在残留
42. **文件传输**：申请时声明 size >200MB 直接返回 -32007，入口不发放；PUT 实际字节数超过声明值时连接被中止且暂存删除
43. **文件传输**：一次性 transfer-token 单次使用 —— 第二次 PUT/GET 复用同一 token 返回 401；TTL 5min 过期后同 401
44. **文件传输**：sha256 校验不匹配时拒收、入口作废、暂存删除，且状态可经 `host_upload_status` 查询到 failed 原因
45. **文件传输**：上传到 `/etc/`、`/root/.ssh/`、cron 目录、shell rc 文件在 `host_request_upload` 申请阶段即被内置 block 规则拒绝（-32004），入口不发放
46. **文件传输审计**：一次完整上传在审计中留三条事件（request intent / 传输完成 / 落位完成）；下载留一条（拉取即审计，无论是否 GET）
47. **主机指纹**：首次连接未经 `trust-fingerprint` 的主机被拒绝；指纹变更时拒绝连接并告警（不做自动信任）
48. **凭证复用**：原生主机资产的 SSH 凭证仍走 `server_credentials` 槽位，凭证归属人私有 + 可按分组共享使用（ADR-028）、审计到人（ADR-004）语义不变
49. **扩展框架**：新增一个原生工具只需在 `src/native/tools/<category>/` 下加一个文件，**不修改** `mcpEntryService` / 规则引擎 / 审计服务；CI 断言核心链路文件在加工具前后 diff 为空
50. **扩展框架**：`src/native/tools/**` 中出现 `import ... from 'ssh2'` / `authorize` / `auditService` / `credentialService` 时，ESLint 检查失败
51. **扩展框架**：契约测试遍历注册表 —— 在注册表里注入一个 mock 工具后，无权 asset / 审计不可用 / block 命中三组断言自动对其生效，无需新增用例
52. **扩展框架**：工具 id 重复或声明了不存在的 connector 时，进程启动失败并打印违规项（不静默降级）
53. **扩展框架**：原生工具与派生工具共用同一 `can('invoke')`；存在任一原生工具绕过它的路径即视为不通过
54. **扩展框架**：审计 `tool` 字段格式为 `native:<id>` 或 `derived:<tool>`，两者不混用，规则 `target=tool` 可按命名空间命中一类
55. **配置字典**：全部运维策略值（实例池预算/TTL/排队、SSH 池、输出截断、命令超时、传输上限、审计保留期等）在 `/settings` 运行时参数页可改；**改任一热生效项后无需重启进程即生效**，并能在下一次调用中观察到新值作用于行为
56. **配置字典**：`system_settings` 中只存偏离默认值的行；新装实例在**零 INSERT** 前提下，`settings.get()` 对全部 schema 项返回默认值
57. **配置字典**：`PATCH /settings/:key` 传入越界值或类型不符时返回 -32008 且**不落库**；`is_secret` 项的审计记录中 value 恒为 `***`
58. **配置红线**：`SETTINGS_SCHEMA` 中不存在匹配 `/audit.*(enable|disable|skip)|accessMode|authorize/i` 的 key；CI 静态检查失败即不通过
59. **配置启动校验**：`system_settings` 中存在 schema 未声明的孤儿 key 时，启动打印告警；存在类型/范围非法值时**启动失败**并打印违规 key
60. **需重启项可见性**：改动 `requires_restart=true` 的项后，UI 同时显示"已保存值"与"当前生效值"，并显示待重启提示条；**重启前行为确实未变**（以实际调用验证，非仅 UI 文案）
61. **配置来源单一**：业务代码中不存在对 `process.env.OPSGATE_*` 的直接读取（L0 八项除外）与策略值硬编码；CI 静态检查 `src/` 下除 `src/config/` 外不得出现 `process.env`
62. **Market 目录可用**：`GET /market/catalog` 返回的每条目录条目，`command` 均带显式版本（`pkg@x.y.z`），不存在裸 `-y pkg`；条目数 ≥12；`/market` 页面可搜索/按类别筛选并进入详情
63. **Market 槽位自动识别**：任取一条含 `${VAR}` env 的目录条目，展开预览返回的槽位清单覆盖全部占位符 + 全部命中敏感键启发式的键；`file:true` 判定与"私钥/kubeconfig"类键一致
64. **Market 一键实例化**：从 `/market/:key` 填名称 + 逐槽位选凭证 → 提交后 `servers` 落库且 `server_credentials` 绑定数与填写槽位数一致；`marketKey` 记录来源；**全程用户未编辑任何 JSON**
65. **Market 与运行时解耦**：实例化成功后删除/修改目录条目（模拟），已创建资产的工具调用行为**完全不变**（配置已快照固化）
66. **凭证绑定 UI 闭环（v1 缺陷必修）**：**仅通过 UI**（不使用 curl/API 工具）可完成"新建资产 → 绑定槽位凭证 → 连通性测试成功"全流程；有未绑定槽位时 `/assets/:id` 显示提示条（提示补齐，但**不阻止调用**）
67. **槽位换绑与解绑**：换绑凭证后实例键变化（旧实例被回收），审计出现 `credential_bind`；解绑后写入 `credential_unbind`。**未绑定的槽位不注入该变量**（2026-11-17 用户决策：取消槽位必填拦截 —— 平台不替产品判必填，缺失由连通性测试/产品进程报真实错误；不得注入空串冒充"已提供"）
68. **Market 非运行时依赖**（ADR-029 修订）：停用或删除任一 `market_entries` 行后，已从该条目创建的资产工具调用行为**完全不变**（配置在实例化时已快照固化到 `servers`）；`market_key` 仅用于已添加徽章与重复检测，不参与 `tools/call` 链路
69. **槽位直填值**（ADR-027）：资产槽位可直接填值 —— ① 填写后 `credentials` 表行数**不变**、凭证列表不出现该值（直填值不是凭证）；② 值加密落库（DB 中非明文）；③ 运行时按该值注入槽位；④ 改值后实例键变化（旧实例回收）；⑤ 与凭证绑定互斥（绑凭证 → 直填值清空，反之亦然）；⑥ 非归属人写入返回 403
70. **凭证等级标签**（ADR-028）：创建/编辑凭证可设 `privileges`（root/rw/wo/ro 多选）；列表与详情显示彩色徽标；**该字段不参与任何授权判定** —— 清空等级后凭证的使用权与取值行为完全不变
71. **按分组共享**（ADR-028）：凭证归属人可在详情页按分组逐个开启/关闭共享（写 `credential_group_shares`）；非归属人打开该面板为只读（开关数 0，显示只读徽标）；共享到 G 组的凭证，G 组成员**可查看详情、可使用**；未共享的分组访问详情返回 403
72. **共享≠可绑**（ADR-028）：成员绑定候选仍只有自己创建的凭证；尝试绑定他人凭证返回 400 且消息含"非本人"
73. **一槽多凭证**（ADR-028）：`server_credentials` 主键 `(server_id, slot_name, user_id)`；同一槽位可同时存在归属人的 asset 绑定与多个成员的 personal 绑定；槽位列表只向成员暴露「自己的全部 + 他人的 asset」，他人 personal 不暴露
74. **取值顺序**（ADR-028）：直填值 > 指定 credential > personal > asset（多 asset 按 privileges 排序 root→rw→wo→ro→无）；`tools/call` 可传可选 `credential` 参数指定凭证，无权使用返回 `-32006`；不传 userId 的系统路径只取 asset
75. **成员变动**（ADR-028）：① 移出分组 → personal 绑定保留，但不复能用该组的共享凭证 ② 删除成员 → 凭证/资产保留且 `owner_id` 置 NULL、personal 绑定清理、已签发 API Key 撤销、admin 可 `POST /admin/reassign-owner` 重新指派 ③ 禁用成员 → Web 登录被拒（登录页明确提示"账号已被禁用"，密码错误时仍返回通用提示不泄露状态），**API Key 的 MCP 调用不受影响**
76. **工具描述凭证可见性**（ADR-028）：派生工具描述列出「可用凭证：名称(私有/共享/等级)」；只含自己的绑定与他人 asset 绑定，他人 personal 不出现
77. **资产编辑范围**（ADR-035）：`PATCH /servers/:id` 对 `category` / `executionMode` / `type` / `command` / `args` / `env` / `headers` 任一字段返回 **400 且 message 含"不可修改"**；请求若同时含合法字段与上述任一字段，**整批拒绝、合法字段也不落库**；`name` / `displayName` / `description` / `tags` / `hostConn` / `url` / 安全开关 / `visibility` / `credentialSlots` / `enabled` 照常可改（对照组证明拒绝不是一刀切）
78. **资产编辑不产生隐式副作用**（ADR-035）：不可改字段被拒时，实例不被回收、不写 `asset_update` 审计、`updated_at` 不变

---

## 10. 决策状态

### 10.1 已确认（用户 2026-10-20 拍板）

| # | 决策 | 落地位置 |
|---|---|---|
| **A** | **高危定义做成字典表 + 正则匹配，WAF 规则库形态** | §4.7 guard_rules 表、§5.8 规则引擎、/settings 安全策略页；原硬编码的 toolCallGuard 两层规则一并外部化为 locked=1 内置数据 |
| **A2** | **高危只标记（kind=mark），不拦截**；拦截是同一张表的 kind=block，职责分离 | §5.8 执行顺序（先 block 后 mark） |
| **B** | **批量实例化放 v1.1**，MVP 先手工接入少量资产验证闭环 | §11 里程碑 |
| **B2** | **主机清单格式 = CSV** | v1.1 导入器列定义：name, host, category, tags, credential_ref, group |
| **B3** | **SSH 凭证大部分相同** → CSV 的 credential_ref 列可留空，留空时回落到该品类的默认凭证 | v1.1 导入器 |
| **B4** | ~~**默认分组按资产类型**：host / mysql / k8s 三组，Market 实例化时按模板品类自动归入~~ —— **前半已被 ADR-026 取代**（分组为自由组织单元，不预置、不自动归组）；后半的"分组收窄候选集"结论保留，见 §5.5.6 | §4.1 category 字段、§5.5、§8.5 /groups |
| **B5** | **资产列表平铺可接受**，前端分页 50/页 + 筛选 + 搜索 | §8.5 /assets |
| **C** | **allow_private_network 保持 fail-closed**，按资产显式开启；支持列表勾选批量设置，但不做全局默认开 | §4.1 字段、§5.6 |

### 10.2 已确认（用户 2026-10-20 第二轮拍板）

| # | 决策 | 落地位置 |
|---|---|---|
| **D** | **部署机 16GB 内存** → 实例预算 40 提至 **80**（权重预算 200），RSS 上限 2GB 改 **4GB**；原资源约束解除 | §5.4 配额表、§9 AC-10 |
| **H** | **凭证不做第二套使用授权**。使用权从资产 `can('invoke')` 派生：能调用任一绑定该凭证的资产 ⇒ 能用该凭证 | §4.2、§6 约束 3 `canCredential` |
| **H2** | **凭证管理权（改值/轮换/删除/定引用范围）= 创建者 + 平台 admin** | §4.2 四能力表 |
| **H3** | **引用权**（绑到自己资产）由创建者通过 `visibility` + `shared_with_user_ids` 授予；**引用权 ≠ 使用权** | §4.2、§8.6 V1 用词硬约束 |
| **H4** | **一凭证绑多资产**（300 台主机共用 SSH 密钥）为常态；`server_credentials` 多对多，实例键含 `serverId` 故各主机实例独立 | §4.3、§4.2 副作用说明 |
| **H5** | **禁止凭证转授权**：使用权只能由凭证归属人名下的资产传播，写入侧 fail-closed 前置校验 | §4.2、§6 `canCredential`、ADR-019 |
| **H6** | **凭证 = 创建者私有资源 + 可按分组共享使用（ADR-028 修订）**：① 凭证只能绑到自己创建的资产（共享凭证只可「用」不可「绑」）② 绑定下拉只列自己的凭证 ③ 归属人可按分组逐个开启共享（`credential_group_shares`），不默认跨组 ④ 使用权 = admin ∨ 归属人 ∨ 共享到所在分组（不再从绑定资产派生）⑤ `privileges` 仅展示不授权 | §4.2、§6、§8.5、§8.6 V1、ADR-020（共享部分被 ADR-028 取代）、§9 AC-25~28 / AC-70~76 |

| **J（已确认，第七轮）** | **工具按品类聚合暴露**：聚合单元 =(category, implementation)，工具名 `{category}_{tool}`，资产降为 `asset` 入参；平台注入 `opsgate_list_assets`（永远第一位）+ `opsgate_request_access`(V1.1)；引导由服务端 `initialize.instructions` 动态下发，**替代需分发的 skill** | §5.5.1~5.5.4、ADR-021、§9 AC-29~35 |
| **J2（已确认，否决混合枚举）** | **统一走发现工具**，资产数多少都不把资产注入 `asset` 枚举 —— 行为一致、零漂移，多一轮 ~200 token 的发现调用是可接受代价 | §5.5.2、§9 AC-35 |
| **J3（已确认，**被 ADR-032/033 取代**）** | **`_all` 元工具模式直接删除**，不做兼容保留 —— 原判断"工具数已恒定，元工具没有存在理由"。该前提在品类涨到 11 个后失效；ADR-032 先改单入口分层暴露，ADR-033 又因 opencode 2.2.6 不消费 `list_changed` 而把元工具（`opsgate_list_asset_tools` + `opsgate_invoke`）定为**默认路径**。`?group=_all` 的 400 保留不变 | §5.5.6、§9 AC-36 |
| **J4（已确认，第八轮）** | **SSH 远程执行命令 / 文件上传 / 文件下载作为平台原生 MCP tool**：协议级原子能力原生化（ssh2 进程内直连、无子进程、连接池复用），语义级能力（MySQL/K8s）仍代理社区实现。300 台主机不进实例池，痛点 6 的解法从"实例池优化"升级为"去掉子进程前提" | §2.4 修订、§3.4、§4.1 execution_mode/host_conn、§5.4 重算、§5.5.7（含临时入口传输模型，第八轮用户纠正内联方案）、§5.6 注入点五类、ADR-022、§9 AC-37~48 |
| **J5（已确认，第九轮）** | **原生工具扩展框架（ADR-023）**：Connector（协议）× Tool（能力）两层正交；工具只写 `execute` + schema，鉴权/审计/规则/连接/截断由框架承担；边界用 ESLint + 启动 fail-fast + 遍历注册表的契约测试强制。属内部架构决策，无产品取舍风险 | §5.9、ADR-023、§8.5 `/native-tools`、开发任务 O/P、§9 AC-49~54 |
| **Q（已确认，第十轮）** | **配置做成 UI 可维护的配置字典，而非文件 / 环境变量**：三层模型 L0 引导（≤8 项，死锁判据逐条证明）/ L1 系统设置（`system_settings` 表，UI 改）/ L2 代码常量（结构契约）；声明式 schema + DB 只存偏离默认值的行；六条不可配置红线保护三条硬约束；write-ahead 审计记 before/after | §4 表清单、§5.10、§7 系统设置端点 + `-32008`、§8.5 `/settings` 运行时参数 Tab、ADR-024、§9 AC-55~61、project-facts §4 层级标注、project-rules §12 |
| **R（已确认，第十一轮）** | **Market 目录 + 单条实例化提级为 v1 必修（ADR-025）**；`batch-instantiate` 仍 v1.1（决策 B 不变）。同时**"新建资产后无法绑定凭证"定性为 v1 缺陷必修**（API 已实现但 UI 无入口，FR-ASSET"已实现"表述不成立）。Market 仍只是创建期模板，实例化后与目录彻底解耦 | §5.3（重写）、§7 Market 端点契约、§8.5 `/market`+`/market/:key`+`/assets/:id` 凭证绑定 Tab、ADR-025、§9 AC-62~68、§11 M6 |

**决策 R 的缺口论证（记录在案，防止再次遗忘）**：

1. §0 痛点表的第 1 条"MCP 添加复杂度高，要手写配置"，其对应解法写的是"内置 Market 目录，选中即展开为资产"。Market 不落地 = **痛点 1 的解法落空**，添加下游 MCP 回退为手搓 JSON。
2. 更严重的是：v1 实现态下**前端 `slots` 零引用**，即新建的资产（含原生主机）**绑不了凭证**——建出来不可用。这是"API 已实现 ≠ 产品可用"的典型假通过，DELIVERY.md 的 FR-ASSET 状态表述必须一并修正。
3. 决策 B 原意是"MVP 先手工接入少量资产验证闭环"，**验证阶段成立、交付阶段不成立**。故只把"目录 + 单条实例化"提前，批量（300 台 CSV）仍按 v1.1 —— 批量走的是原生 host CSV 直建，本就不依赖 Market。

### 10.3 开发实测任务（无需决策，排期执行）

| # | 事项 | 说明 |
|---|---|---|
| E | guard_rules 表 + 规则引擎 + 内置规则播种 | ReDoS 校验（safe-regex2）必须在入库前拦截非线性正则；locked=1 规则禁止通过 API 修改 |
| F | uvx 实例内存实测校准 | 开发首周用真实 mysql_mcp_server / k8s 类实现实测 RSS（host 已原生化，不再有 ssh-mcp 子进程），校准 §5.4 权重参数（当前按 40-80MB 估，实测 60-120MB）。16GB 下 80 实例即便按 120MB/实例 算约 9.9GB 仍安全，此项为校准而非阻塞 |
| G | 分组工具数上限保护 | §5.5，tools/list 超 200 返回 -32005 而非静默截断 |
| I | 写入侧转授权校验 | 改资产可见性 / 换绑槽位凭证两处前置校验，返回 400 且提示带凭证名与创建者；需覆盖 admin 短路路径的审计 |
| K | 真实 `tools/list` 实测校准 | 开发首周对 mysql / k8s 两个社区实现实测工具数与 schema（host 已原生化为 4 个工具，无需实测），校准 §5.5.1 的 6/12 估算与 R6 的 token 预算 |
| L | 描述规范回归器 | `/mcp/preview` 内置 R1–R8 静态校验（工具名前缀、asset 指引、描述长度、参数 description 非空），纳入 CI |
| M | 原生 SSH 执行层 | ssh2 连接池（键 = assetId + 凭证指纹）+ 四个原生工具 + 主机指纹信任流程 + 内置 block 规则（敏感路径上传，申请阶段拦截）。**注意 ssh2 已锁定为直接依赖**，凭证注入走 `host_conn.authSlot`（§5.6 注入点第五类） |
| N | SSH 连接内存实测 | 300 台全活跃下的 ssh2 连接池 RSS 实测（当前估 0.6–1.5GB），校准 §5.4 重算表；同时实测空闲 TTL 回收行为 |
| O | 原生工具扩展框架骨架 | **与第一个原生工具同时落地**（§5.9）：Connector 接口 + 注册表 + 启动 fail-fast 校验 + R1–R8 静态校验器 + **遍历注册表的契约测试** + ESLint 禁用 import 规则。不做完骨架就不许加第二个原生工具 |
| P | `execution_mode` 与 category 枚举扩展检查 | 新增品类时只需扩 category 枚举 + 表单，无框架改动（§5.9.7 验证表） |

**§10 无未决项 —— Spec 冻结为开发基线（2026-10-20，九轮确认完毕）。**

冻结范围确认：

| 类 | 项 | 状态 |
|---|---|---|
| 产品模型 | A / A2 / B / B2–B5 / C / D | 已确认 |
| 凭证模型 | H / H2–H6（收敛为创建者私有） | 已确认 |
| 工具暴露 | J / J2 / J3 / J4 / J5（按品类聚合 + 原生分层 + 扩展框架） | 已确认 |
| 配置模型 | Q（三层配置 + 配置字典，ADR-024） | 已确认 |
| Market 与凭证绑定 | **R（Market 单条实例化提级 v1；凭证绑定缺陷必修，ADR-025）** | 已确认（第十一轮） |
| 分组语义 | **S（分组为自由组织单元，不与资产品类绑定，取消默认分组，ADR-026）** | 已确认（第十二轮，2026-11-05） |
| 开发实测 | E / F / G / I / K / L / M / N / O / P | 排期执行，不阻塞冻结 |

**后续变更原则**：任何对已确认项的修改走**新增 ADR** 而非就地改写 —— 就地改写会让"当初为什么这么定"丢失，这是上一版文档漂移的根因。

### 10.4 已知限制（需写入部署文档）

- **Windows 不支持部署**：tree-kill / stdio 信号模型面向 Linux
- **版本漂移风险**：npx -y pkg 会拉最新版。Market 展开时把 command 固化为 npx -y pkg@x.y.z
- **类型组需按 tag 收窄**：host 组 300 台主机虽只有 5 个工具，但候选集会稀释 LLM 注意力，建议用 ?tag= 收窄到 30 台以内（§5.5.6）
- **原生 SSH 为非交互 shell**：无 PTY，不支持 sudo 交互输密码与 vim/tail -f 等交互命令（§5.5.7）
- **文件传输走 HTTP 旁路**：MCP 仅申请一次性入口（TTL 5min），本体经 `PUT/GET /mcp/transfer/:id` 传输；单文件 ≤200MB、暂存盘配额 2GB，更大需分批（§5.5.7）

---

## 11. 里程碑与工作量

估算 **5–6 人月**，AI 辅助 **5.5–6.5 周**（较原估增加约 1.5 周，增量来自 ADR-022 原生执行层与文件传输旁路 +0.5~1 周、ADR-025 Market 与凭证绑定 +0.5 周）。

| 阶段 | 内容 | 周期 |
|---|---|---|
| **M0 工程基线** | 文档路由校正 + 工作分支 + 脚手架 + 构建/测试/CI 命令 + 代码常量表 + **`SETTINGS_SCHEMA` 落地**（ADR-024） | 0.5 周 |
| M1 骨架 | 数据模型 + 迁移 + 路由注册表（default-deny）+ better-auth + API Key + **配置服务（`settings.get` / 启动期校验）** | 0.5 周 |
| **M2 原生执行层** | **扩展框架骨架（任务 O，前置）** + ssh2 connector + 4 个原生工具 + 文件传输旁路 + 主机指纹 | 1.5 周 |
| M3 实例池 | 生命周期 + 配额 + LRU + 串行队列 + 崩溃清理（**只服务 34 个 MCP 资产**） | 1 周 |
| M4 MCP 入口 | 按品类聚合 + `initialize.instructions` + 描述规范 R1–R8 + 发现工具 | 1 周 |
| M5 审计与授权 | write-ahead + `can()` + 规则引擎 + 预聚合 + 审计 API | 1 周 |
| M6 管理端 | Token + 组件库 + 页面（含 `/native-tools`、`/instances` 双池、`/settings` 运行时参数 Tab 含待重启提示条）+ **`/market` 与 `/market/:key`（ADR-025）+ `/assets/:id` 凭证绑定 Tab（v1 缺陷必修）+ `/assets` 新建 MCP 资产入口** | 1.5 → **2 周** |
| M7 加固与验收 | prewarm + sweep + 渗透式验收（default-deny / write-ahead / 授权一致性） | 0.5 周 |

**顺序硬约束**：**M2 的扩展框架骨架必须先于任何第二个原生工具**——骨架不做完就加工具，等于把横切逻辑复制粘贴，ADR-012/013 会随工具数量线性劣化（§5.9）。

**原生化的工作量账**：+1.5 周（M2 新增）；−0.5 周（M3 实例池从 1.5 周降到 1 周，只需覆盖 34 个 MCP 资产，且不再需要调试社区 ssh-mcp 集成）。净 +1 周，换来运维期 300 台主机从"子进程态"变"连接态"（§5.4 重算表）。

**最高风险四点**（PM 视角）：
1. 授权绕过 —— 需渗透式验收，不是"测试通过"
2. 共享凭证下审计到人的可信度完全靠网关保证 —— 审计可绕过则核心价值归零
3. **原生执行层资源模型** —— ssh2 连接池的内存估算（0.6–1.5GB/300 台）与 ssh2 的并发稳定性**未经实测**（任务 N），是 M2 唯一未验证假设
4. 槽位识别覆盖率 —— MVP 市场只收录 mysql / kubernetes 等验证过的品类（host 已原生化，不再依赖社区实现）；**自动识别漏判由 `/assets/:id` 的"手动补槽位"兜底**（ADR-025），不允许把识别率当作唯一入口

---

## 附：ADR 索引

| 编号 | 决策 |
|---|---|
| ADR-001 | Fastify 5 作为后端框架 |
| ADR-002 | SQLite(WAL) + Drizzle ORM，审计按月分表 |
| ADR-003 | 单 Node 进程，不引入 Redis |
| ADR-004 | 共享凭证 + 按 credentialId 实例键（与 mcphub per-user 根本分叉） |
| ADR-005 | 实例串行队列 + 降级开第二实例 |
| ADR-006 | Virtual Server 分组路由为 MCP 入口（按品类聚合，ADR-021/022 修订后：分组控制资产候选集而非工具数；`_all` 元工具已删除） |
| ADR-007 | better-auth 认证 + 每人一个 API Key，审计归属 Key→人 |
| ADR-008 | lucide-react ^1.59.0 为唯一图标库 |
| ADR-009 | 预热 = 只拉包不常驻 |
| ADR-010 | 审计 input/output 双通道脱敏，client_name 白名单规范化（原始 UA 不落库） |
| ADR-011 | 路由注册表强制 accessMode + 根级 default-deny（四层防线） |
| ADR-012 | write-ahead audit，审计不可用即拒绝调用，无降级旁路 |
| ADR-013 | 资产授权单一真值源 `can()`，view≡invoke 参数化断言 |
| ADR-014 | 高危与拦截统一为 WAF 式 `guard_rules` 规则表（kind=mark / block），内置规则 locked 不可关闭 |
| ADR-015 | 默认分组按资产类型（host/mysql/k8s）〔**前半已被 ADR-026 取代**〕；类型组不可直接作 agent 端点，须 `?tag=` 收窄 |
| ADR-016 | `allow_private_network` 保持 fail-closed，按资产显式开启，支持批量设置但不设全局默认开 |
| ADR-017 | 凭证不做第二套使用授权：使用权从绑定资产的 `can('invoke')` 派生；凭证自身可见性仅控制"引用权"，由创建者负责 |
| ADR-018 | 部署机 16GB：实例预算 80（权重 200）、RSS 上限 4GB，原 2GB 约束解除 |
| ADR-019 | 凭证使用权传播只能由归属人发起：通过"把自己创建的资产授权出去"实现，不设凭证级使用授权（原"禁止转授权"并入 ADR-020 的私有模型） |
| ADR-020 | 凭证为创建者私有资源：取消引用权与 `visibility`/`shared_with_user_ids` 字段；绑定候选仅本人凭证（admin 例外）。**⚠「取消共享」结论已被 ADR-028 取代**（恢复按分组共享）；创建者私有与防转授权仍有效 |
| ADR-021 | **按品类聚合工具暴露**：聚合单元 =(category, implementation)，资产降为 `asset` 入参，工具数恒定（~28）；引导由 `initialize.instructions` 服务端动态下发，替代上一版需分发的 skill |
| ADR-022 | **执行分层**：协议级原子能力原生实现（SSH 执行 + SFTP 文件传输，ssh2 进程内直连、连接池复用、不产生子进程），语义级能力（MySQL / K8s）仍代理社区 MCP。host 品类默认 `execution_mode='native'`，不进实例池。**文件传输因 JSON-RPC 纯文本协议 + LLM 上下文约束，采用一次性 HTTP 临时入口（MCP 申请 / HTTP 传本体），不内联 base64** |
| ADR-023 | **原生工具扩展框架**（用户 2026-10-20 确认 J5）：Connector（协议）× Tool（能力）两层正交扩展；工具只写 `execute` + schema（≤50 行），鉴权/审计/规则/连接/截断由框架统一承担；边界由 ESLint 规则 + 启动 fail-fast + 遍历注册表的契约测试强制，不靠约定 |
| **ADR-024** | **配置字典（三层配置模型）**（用户 2026-10-20 确认 Q）：L0 引导配置（≤8 项，须由"读它之前连不上数据库 / 它被用来保护数据库内容"的死锁判据逐条证明）/ L1 系统设置（`system_settings` 表，admin 在 UI 改，热生效）/ L2 代码常量（结构契约不可改）。声明式 `SETTINGS_SCHEMA` 为唯一定义源，DB 只存偏离默认值的行（零 INSERT 可用）。六条不可配置红线（审计开关 / 路由 accessMode / `can()` / 加密主密钥 / DB 路径 / locked 内置规则）保护三条硬约束不被"可配置化"架空。配置变更 write-ahead 审计记 before/after，secret 项掩码。与 ADR-014 的 guard_rules 字典表同一思路在平台运行参数上的推广 |
| **ADR-025** | **Market 目录与凭证绑定（用户 2026-10-21 确认 R）**：① Market 的"目录浏览 + 单条实例化 + 槽位自动识别"提级为 **v1 必修**（原决策 B 只推迟了 `batch-instantiate`，但实现态把整块 Market 一起推迟，导致 §0 痛点 1 的解法落空）；目录为**内置静态 JSON（12–20 条，版本固化到 `pkg@x.y.z`）**，不落库、不是运行时实体，`servers.marketKey` 仅用于徽章与重复检测，实例化后与目录彻底解耦（沿用 ADR-003 精神）。② 自动识别是启发式，**允许漏判**，故 `/assets/:id` 必须提供"手动补槽位"作为人工出口。③ **"新建资产后无法绑定凭证"定性为 v1 缺陷**：API 已实现（`POST /servers/:id/slots`）但前端零引用，导致新建资产不可用 —— 属"API 通过 ≠ 产品可用"的假通过，必须补 `/assets/:id` 凭证绑定 Tab（绑定/换绑/解绑/未绑定警示条），AC-66 要求**仅通过 UI** 走通"新建→绑定→连通测试成功" |
| **ADR-026** | **分组是自由组织单元，不与资产品类绑定（用户 2026-11-05 确认 S）**：① 取消 ADR-015 / 决策 B4 的前半"默认分组按资产类型"——**不预置 host/mysql/k8s 三组，也不按 `category` 自动归组**；`category` 的唯一作用是 `asset_type` 规则匹配维度。② 分组的职责收敛为**管理性**三件事：关联资产、授权成员、快速筛选；分组**不构成对资产的业务限定**（资产能否调用仍只由 `can()` 单一真值源决定，ADR-013/ADR-020 不变）。③ 分组对 agent 侧的作用**仅限筛选与上下文提供**（§5.5.6）——分组说明通过 `opsgate_list_groups` / `opsgate_view_group` 工具暴露（**不注入 instructions 前言**，`buildInstructions` 未接 `groupDesc`），这是"筛选/上下文"而非"业务约束"。**实现态事实校正**：MCP 入口的 `?group=` 查询参数当前是按 `category` 过滤（`servers.category = group`），**不是**按 `groups` 表的分组实体；分组实体目前只参与授权派生（`group_servers` / `group_users` → `can()`）与元信息。此参数与实体的历史混用登记在此，**不在本 ADR 范围内**改动 MCP 公开契约（另议）。④ 实现层另一处校正：代码从未实现"按品类自动归组"（`group_servers` 仅由 `POST /groups/:id/servers` 手工写入），本 ADR 把 Spec 与实现对齐，并移除 seed 中的预置分组 | §4.1 category 字段、§5.5.2 工具数核算表、§5.5.4 instructions 模板、§5.5.6、§8.5 /groups、ADR-015（前半作废）、决策 B4（前半作废）、seed |
| **ADR-028** | **凭证共享恢复 + 一槽多凭证 + 等级标签**（用户 2026-11-06 确认 16 条规则，**取代 ADR-020 的"取消共享"结论**）：① 凭证仍为创建者私有资源（管理权=归属人+admin），但**恢复按分组的显式共享**：归属人在凭证详情页按分组逐个开关，写 `credential_group_shares` 表；不默认跨组。② 共享凭证**只能"用"不能"绑"**：绑定候选仍只有自己创建的凭证（防转授权）。③ 一槽多凭证：`server_credentials` 主键改为 `(server_id, slot_name, user_id)`，新增 `scope`（`asset`=归属人绑定、整组可用；`personal`=成员自绑、仅本人）与 `label`。④ `credentials.privileges`（root/rw/wo/ro 可多选）**仅展示性元信息**，不参与任何授权判定。⑤ 取值顺序：直填值 > 指定 credential > personal > asset（多 asset 按 privileges 排序 root→rw→wo→ro→无）。⑥ `tools/call` 新增可选 `credential` 参数；工具描述列出调用者可用凭证。⑦ 成员变动：移出分组保留 personal 绑定、删除成员资源转无主（`owner_id=NULL`，admin 可重新指派）、禁用只阻断 Web 登录不阻断 MCP。⑧ 凭证使用权 = admin ∨ 归属人 ∨ 共享到用户所在分组（**不再从绑定资产派生**） | §4.2/§4.3/§4.4、§5.3、§6 `canCredential`、§7（`/credentials/:id/shares/:groupId`、`/users/:id` DELETE、`/admin/reassign-owner`）、§8.5 `/credentials/:id`、§9 AC-70~76、`docs/adr-028.md` |
| **ADR-029** | **Market 目录落库 + 后台条目管理**（用户 2026-11-06，**取代 ADR-025 的三项结论**）：① 目录载体从内置静态 JSON 改为数据库表 `market_entries`（字段与 `CatalogEntry` 一一对应）；JSON 降级为**种子源**。② 条目状态机 `draft`（仅 admin 可见）→ `verified`（所有人可见）→ `disabled`（不可见、不可实例化，不影响已创建资产）。③ **提供管理员后台管理**（`/market/entries`：增删改、连通性测试、状态变更）；删除前校验 `servers.market_key` 引用。④ 分类由 `categories` JSON 数组动态聚合，前端不再硬编码。⑤ README 运行时抓取（PyPI/npm/GitHub，**域名白名单**防 SSRF）+ 24h 缓存；版本检测对比锁定版本给升级提示。⑥ **AC-68 修订**：从"无任何 market 表时调用正常"改为"停用/删除条目不影响已创建资产的工具调用"（真实意图不变：Market 仍是创建期模板） | §5.3、§7 Market 端点、§8.5 `/market` `/market/:entry`、§9 AC-62~68、`docs/adr-029.md` |
| **ADR-027** | **槽位直填值：直填值不是凭证**（用户 2026-11-05 纠正）：资产槽位允许**直接输入密钥**，与"绑定已有凭证"二选一。① **直填值属于资产自身**，不进 `credentials` 表、不出现在凭证列表、不参与 ADR-020 的创建者私有模型、不能被别的资产引用 —— 新增 `server_slot_values` 表（`server_id + slot_name` 联合主键，AES-256-GCM 加密，AAD=`slot:<serverId>:<slotName>`，`value_fingerprint` 参与实例键）。② **不写进资产 `env` 明文列** —— env 是明文列，密钥不能明文落库；`${VAR}` 占位符保持不变，注入时用直填值替换。③ 与 `server_credentials` **互斥**（写入侧保证），绑定与直填值二者只存其一。④ 凭证模型本身不变：凭证仍是"创建者私有、可多资产共享、可轮换"的一等资源；直填值是"这个资产自己的密钥"，不具备共享与轮换语义（改值即改值，无影响面清单）。⑤ UI：槽位主控件是输入框（直填值直接显示在框内），右侧 `+` 打开已有凭证选择下拉 | §4.3.1 新表、§4.8 ER、§9 AC-69、`src/routes/assets.ts`（`PUT/DELETE /servers/:id/slots/:slotName/value`）、`src/services/credentials.ts`（`setSlotValue`/`clearSlotValue`/`slotValuesOf`）、`src/services/instancePlan.ts`（实例键约定 `inline:<fp>`）、前端 `SlotValueEditor`/`SlotBinder`/`AssetCreateModal` |
| **ADR-031** | **槽位绑定显式指定凭证键**（用户 2026-11-18 提出并逐项拍板，起因：`AUTH_PASS` 绑 `ssh_key` 凭证取不到 `passphrase`）：① `server_credentials` 新增 `credential_key text NULL` —— **NULL = 按槽位名匹配**，有值 = 精确取该键；不进主键（同槽同凭证取两个键的诉求不存在）。② 取值口径改为"精确匹配，不再猜"：保留「键名完全一致」与「归一化后一致」（剥品类前缀 + 小写 + 去下划线，属确定性等价而非启发式），**删除**「凭证只有 1 个键就用它」与「唯一敏感别名」两级猜测；都不中 → 抛错并提示"请在绑定上指定键名"。③ **不改变**槽位是否绑凭证的口径：未绑定不校验、不拦（沿用既有结论）。④ 与 `ref.<凭证名>.<键名>`（§5.3）并存不合并：前者按凭证名写在配置值里、不参与权限模型；本 ADR 属于绑定关系属性、完全参与 `scope`/`privileges`/成员自绑。⑤ 存量**不自动回填**（用户决策）：开发库 20 条绑定中 15 条靠同名/归一化继续可用，5 条（`AUTH`←`password`×3、`REDIS_PWD`←`REDIS_PASSWORD`、`AUTH_PASS`←`passphrase`）在显式指定键名前报错，由用户手改。⑥ 前端 `SlotBinder` 选凭证后同面板出现「用哪个键」下拉（数据源复用 `/credentials/candidates` 的 `keys`），默认选同名键；`slotMatches` 候选过滤保持不变 | §4.3 `credential_key` 列、§5.3、§7 `/servers/:id/slots`、§8.5 `/assets/:id` 槽位绑定、`src/services/credentials.ts`（`resolveSlotValues`/`pickSlotValue`）、`src/services/sshCredential.ts`、迁移 0015、`docs/adr-031.md` |
| **ADR-032** | **MCP 单入口分层暴露**（用户 2026-11-18 提出，起因：品类从 3 涨到 11、裸 `/mcp` 245 工具 > `tools.list_max`=200 直接 500，`office-k8s/ES/Kafka/Prometheus` 等只能走 `?group=` 而该入口同样超限）：① **`/mcp` 是唯一入口**，初始化**只返回平台工具**（初版 5 个），不再派生任何品类/资产工具——裸连接的工具数恒定，结构上不可能再撞上限。② 新增 `opsgate_select_scope({group?, category?, tag?})`：按**范围**（不是资产清单）重算工具集并**替换**本会话视图（不累积），成功后 `sendToolListChanged()`。③ **派生粒度仍是品类**：300 台虚拟机同属 `host`，共用同一套 11 个工具，靠 `asset` 入参区分；工具数与资产数解耦（这才是 Spec §5.5.1 的原始目标，被前几版实现漂移成"全量平铺"）。④ 带 `?group=`/`?category=`/`?tag=` 的 URL 视为"初始化即选定该范围"，仍是同一入口同一范式；不加参数则停在平台工具层。⑤ **推翻了 J2/J3 的"无元工具"结论**：当年否决的理由是"按品类聚合后工具数恒定"，但实际品类数随接入增长，恒定假设不成立。⑥ 顺带修四个暴露层缺陷：D1 `pruneDerivedSchema` 同步裁剪 `required`（原留下"必填但无法填"的幽灵参数）；D5 审计意图记录凭证失败不再阻断调用（原把槽位错误吞成 "Audit unavailable"）；P1 原生与派生工具共享同一张查重表（原 `host_execute_command` 在同视图出现两次）；D3 `?category=` 校验改为从 `servers.category ∪ market_entries.categories` 动态取（原 `TOOL_CATEGORIES` 硬编码白名单让 5 个品类完全不可达）。⑦ `nacos_health` 改调 `/v1/console/server/state` + `/v1/console/health/readiness`（`/v1/ns/operator/servers` 在 Nacos 2.x 已移除，实测 501）。⑧ instructions 的内置安全骨架不可被覆盖，新增 `mcp.instructions` 设置项（`system_settings`，无需重启）由管理员追加，前端 Settings 页多行 Markdown 编辑 + 预览 | §5.5.1、§5.5.2、§5.5.4、§5.10.6、§9 AC-29/30/36、`src/services/toolAggregation.ts`、`src/services/mcpEndpoint.ts`、`src/config/settingsSchema.ts`、`frontend/src/pages/Settings.tsx`、`docs/adr-032.md` |
| **ADR-033** | **元工具 `opsgate_invoke` 定为默认调用路径**（用户 2026-11-18 拍板，起因：ADR-032 的 `select_scope` 依赖客户端消费 `notifications/tools/list_changed`，而 **opencode 2.2.6 Code Mode 在同一轮对话内只构建一次工具目录**——`select_scope` 后本轮 `tools.*` 仍是 5 个平台工具，跨轮 `--continue` 也不刷新；服务端协议层实测正常，故不能把"客户端会刷新"当作可用性前提）：① 平台工具从 5 个增到 **7 个**，新增 `opsgate_list_asset_tools({asset})` 与 `opsgate_invoke({asset, tool, args})`。② `opsgate_invoke` 的 `tool` 必须属于该资产**当前可用工具集**（与 `list_asset_tools` 共用同一份 `toolsOfAsset()`），否则 `-32601` —— **不新开任意透传口**，`tool_filters`/品类过滤/停用开关/槽位归因全部照常生效。③ `list_asset_tools` 返回的 schema **去掉 `asset` 参数**（已提升为元工具外层参数）。④ `opsgate_select_scope` **保留为可选优化**（支持 `list_changed` 的客户端可少一层嵌套），不删除。⑤ **取代 J3 的"元工具不做兼容保留"**：元工具现在是默认路径而非旁路。⑥ `dispatchDerived` 形参由 `ExposedTool` 收窄为 `toolRef: string`，两条入口共用同一派生链路 | §5.5.1、§5.5.6、§9 AC-36a、`src/services/toolAggregation.ts`（`toolsOfAsset`）、`src/services/mcpEndpoint.ts`（`listAssetTools`/`invokeOnAsset`）、`docs/adr-033.md` |
| **ADR-034** | **同槽位多凭证的确定性择优**（用户 2026-11-19 拍板，起因：v1→v2 数据迁移后发现 73 个槽位存在多条绑定；`privileges` 回填前有 66 个槽位的取舍不确定，回填后仍有 7 个槽位候选凭证**权限等级相同**，旧实现仅按 `privileges` 排序，同分时结果取决于 SQLite 返回行序 —— 同一份数据在不同机器/不同查询计划下可能取到不同账号，属隐式不确定）：① 排序键改为三级：**权限等级**（沿用 ADR-028 §2.4 的 root→rw→wo→ro→无）→ **管理类账号优先**（凭证名或绑定用户名匹配 `root`/`admin`/`administrator`/`superuser`/`superadmin`，按词边界匹配，避免误命中 `rootfs` 之类）→ **`credentialId` 字典序**。② 该规则只影响「多条绑定都已经可选、现在要挑一条」的场景，**不改变** personal 优先于 asset 的层级，也不改变任何授权判定（`privileges` 仍是展示性元信息，ADR-028 §④ 不变）。③ 实现集中在 `pickBestBinding()`，`resolveSlotValues` 与 `slotCredentialKey` 共用，避免两处口径漂移。④ `src/credential-tiebreak.test.ts` 锁定行为：业务账号先插入时仍应取到 root 账号，且重复调用结果一致。⑤ **不为存量数据伪造等级**：同等级绑定的取舍一律由本规则确定，不靠改写 `privileges` 让排序"看起来对"。迁移数据实测（`verify-real-resolve.mjs`，用 `.60` 上真实 `CredentialService`）：7 处同等级槽位 **7/7 落到管理账号**（其中 3 处是绑定用户名=`root` 的 `k8s-vm` 凭证，按"凭证名或绑定用户名"判定为管理账号）。 | §4.3、§5.3 槽位取值、`src/services/credentials.ts`（`pickBestBinding`）、`src/credential-tiebreak.test.ts` |
| **ADR-035** | **资产形态与执行配置创建后不可改**（用户 2026-11-21 纠正"编辑功能放太开了"）：① 新建资产时可调的只有**标签、凭证绑定、基础信息与名称**；编辑时同样只能改这些，外加**连接目标**（原生 host 的 `hostConn{host,port,username,authSlot,authPassSlot}`）与**安全开关**（`allowPrivateNetwork` / `allowInsecureTls`）——用户选择口径为"基础信息 + 连接目标"。② `PATCH /servers/:id` 对 `category` / `executionMode` / `type` / `command` / `args` / `env` / `headers` **显式 400 拒绝**，且**整批拒绝**（含合法字段的混合请求也不落库），不做静默忽略（静默忽略会让调用方以为改成功了）。③ **推翻 ADR 前序实现**：`79b5c56` 曾开放形态字段修改并做形态自洽矩阵校验，`a38ac69` 曾开放执行配置修改 —— 两者均回撤，`src/asset-shape-edit.integration.test.ts`（9 例）随之删除。④ UI 同步收敛：详情页「可见性」Tab 的标签/地址/私网/TLS 内联编辑全部移除，改为**只读展示 + 顶部「编辑」弹窗**，单一入口避免两处可写；TLS 开关按用户二次确认回到可见性 Tab（属资产级安全开关，非形态）。⑤ 建错形态的唯一路径是**重建资产**，不在旧资产上换形态 —— 换形态会让已绑槽位、已签发工具名（`{category}_{tool}`）与既有审计语义同时失效 | §4.1 字段、§7 `PATCH /servers/:id` 可改字段、§8.5 `/assets/:id`、§9 AC-77/78、`src/routes/assets.ts`（`immutable` 前置拒绝）、`frontend/src/components/AssetEditModal.tsx`、`src/asset-immutable-fields.integration.test.ts` |
