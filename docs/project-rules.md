# project-rules.md — OpsGate 项目专属规范

> 动手前必读。本文件是 `AGENTS.md` 的项目级补充，只写**本项目特有的、违反会造成返工**的规则。
> 顶层流程规范见 `AGENTS.md`；硬事实见 `docs/project-facts.md`；设计依据见 `docs/opsgate-spec-v1.md`。
>
> 最后更新：2026-10-20（Spec 冻结后首次建立）

---

## 0. 三条不可协商的硬约束（违反 = 退回重做）

这三条对应 ADR-011 / 012 / 013，是本项目**存在的理由**，不是"安全最佳实践"：

| # | 约束 | 代码层要求 |
|---|---|---|
| **R-1** | **default-deny 路由注册表**（ADR-011） | 每条 Fastify 路由必须显式声明 `accessMode`；启动时断言不在白名单的 `public` 路由 → **进程启动失败**；根级 `preHandler` 兜底 → 未注册路径 **403 而非 404** |
| **R-2** | **write-ahead audit**（ADR-012） | `tools/call` 先写 intent（`status='pending'`）再执行；审计写入失败 → 返回 `-32003` 且**未执行任何下游操作**；**代码中不得存在任何跳过审计的开关、配置或 try-catch 旁路** |
| **R-3** | **授权单一真值源 `can()`**（ADR-013） | 全项目资产授权判定**只有** `services/authorize.ts` 的 `can()`；`view` 与 `invoke` **共享同一布尔表达式**；DB 层不做行级过滤（SQLite 无 RLS）；调用方仅四处：mcpEntryService / serverService / auditService / 前端经 REST |

**R-2 的自检方式**：全局搜索 `auditService` 调用点，任何被 `if` 条件、环境变量或 `try/catch` 包裹的路径都是违规。

---

## 1. 权限模型红线（上版失败根因，不得复活）

1. **没有角色矩阵**。不存在 admin / operator / viewer 三态权限。`users` 身份只有**两态**：管理员 / 成员。
2. **没有"可见但不可用"**。可见 ≡ 可调用（AC-6 参数化断言 `can('view') === can('invoke')`）。
3. **凭证不做第二套使用授权**。凭证使用权**只能从绑定资产的 `can('invoke')` 派生**（ADR-017 / 020）。`credentials` 表**没有** `visibility` / `shared_with_user_ids` 列，任何"按凭证可见性判使用权"的分支都是违规。
4. **凭证创建者私有**：凭证只能绑到自己创建的资产；资产绑定下拉只列本人凭证；服务端同主校验 `credential.ownerId === asset.ownerId || isAdmin`，否则 400。
5. 前端文案禁止出现"引用权 / 共享范围"等会误导为"可转授"的措辞（§8.6 P0）。

---

## 2. 原生工具扩展框架（ADR-023）—— 编码约束

原生工具**必须**走框架，不得绕过（AC-49~54）：

| 规则 | 要求 |
|---|---|
| 目录 | `src/native/tools/<category>/<id>.ts`，barrel 自动 import，**不手工登记** |
| 契约 | 实现 `NativeToolDefinition`：`id` / `category` / `connector` / `risk` / `audit` 为声明，`name` / `description` / `inputSchema` / `execute` 为作者实现 |
| **禁止 import** | `src/native/tools/**` 内**禁止** `ssh2` / `authorize` / `auditService` / `credentialService` / `instancePool` —— 由 ESLint 规则强制 |
| `asset` 参数 | **由框架注入**，工具的 `inputSchema` 里不得出现 |
| `execute` 规模 | 通常 ≤50 行；超出说明该拆 connector |
| 命名空间 | 审计与规则用 `native:<id>`；派生工具用 `derived:<serverId>:<tool>`；两者不混用 |
| 启动校验 | id 重复 / category 冲突 / connector 不存在 / 与派生工具同名 → **进程启动失败并打印违规项** |
| 契约测试 | **遍历注册表**，新工具自动被覆盖；作者无需手写用例 |
| 不做版本化 | `tools/list` 每次连接重拉，schema 变更只需 changelog（§5.9.8） |

**反模式（写进 CONTRIBUTING，见 §5.9.9）**：自己 `ssh2.connect()` / 自己判权限 / 自己写审计 / description 里写资产清单 / 把大文件内容塞进返回值 / 破坏性动作不声明 `risk:'destructive'`。

---

## 3. 工具暴露与描述（§5.5）—— LLM 可调用性的硬要求

1. 工具名 **动词开头 + 品类前缀**：`host_execute_command` 而非 `execute`。
2. 描述**四段式**缺一不可：What（动词开头）→ `Use when:`（2–3 个"用户会这样说"的自然语句）→ `Required:`（asset 取值指引，**必填**）→ `Risk:`（仅破坏性工具）。
3. **描述里绝不写死资产清单**（R2）——会随权限变更漂移，且等于把拓扑写进上下文。
4. 参数 `description` **必填**；`asset` 参数描述必须含"取值来自 `opsgate_list_assets`，不要编造"。
5. `opsgate_list_assets` **永远排在 `tools/list` 第一位**。
6. **统一走发现工具**，不做 `asset` 枚举注入（J2 已否决混合枚举）。
7. **`_all` 元工具已删除**，不留兼容分支；收窄一律用 `?tag=`。
8. 引导由 `initialize.instructions` **服务端动态生成、按权限裁剪**；不得依赖客户端安装任何 skill/提示词。

---

## 4. 文件传输（§5.5.7）—— 不得内联

- **JSON-RPC 是纯文本协议**，且内联内容会进 LLM 上下文（1MB ≈ 30 万 token）。文件本体**必须**走一次性 HTTP 临时入口：`PUT/GET /mcp/transfer/:id`。
- 传输 token 是 32B 随机值，**不是 API Key**，与 `{userId, assetId, path, direction}` 绑定，TTL 5min。
- 上传审计**三条事件**（申请 intent / 传输完成 / 落位完成）缺一不可；下载**拉取即审计**。
- 敏感路径（`/etc/`、`/root/.ssh/`、cron 目录、shell rc）在**申请阶段**即被 block 规则拦截。

---

## 5. 数据层约定

| 项 | 规则 |
|---|---|
| ORM | Drizzle + SQLite WAL；schema 是类型的唯一来源 |
| 迁移 | 每次 schema 变更必须生成迁移文件；**禁止手写裸 SQL 改表**（除审计分表） |
| 审计分表 | `audit_log_YYYY_MM` 按月；跨月查询由 service 层拼接，调用方不感知 |
| 软删 | 本项目的删除均为**硬删**，但凭证/资产删除前**必须**展示将被断开的影响清单 |
| 时间字段 | 全部 `integer`（Unix ms），不用 datetime 字符串 |
| 布尔 | `integer(0/1)` |
| JSON 字段 | 存 JSON 字符串；读取后校验，不信任库内内容 |

---

## 6. 错误处理

- 使用 § project-facts.md §5 的**唯一错误码清单**，不得自造码。
- **不吞异常**：`catch` 后必须要么上抛、要么返回明确错误码 + 语义化 message；禁止 `catch { return null }`。
- 错误信息面向调用方：说清"什么错了 + 下一步怎么做"（例：`-32006` 回带可见集内最近似候选）。
- **不泄露存在性**：asset 不存在与无权返回**完全相同**的 message（防探测）。
- 日志**禁止**出现凭证值、Token、完整敏感载荷。

---

## 7. 前端规范（摘要，详细见 Spec §8）

- **深色机房控制台**风格：深色底 + 钢青蓝操作色 + 琥珀警示色 + 等宽技术值。对标 Linear / Grafana / Stripe Dashboard。
- 图标**只用** `lucide-react ^1.59.0`（16/20/24px 三档）；**禁止 emoji 作功能图标**；禁止第二套图标库。
- **禁止紫色→粉色渐变**主视觉（项目级 P0 红线）。
- 颜色**全部走 Design Token**，禁止硬编码色值（唯一例外 `#fff` / `#000`）。
- 资产列表**平铺 + 分页 50/页** + 筛选 + 搜索（用户已确认接受，不要自作主张改成树形）。
- 身份列**两态**（管理员 / 成员），无角色下拉。

---

## 8. 测试纪律

- 验收以 Spec §9 的 **54 条 AC** 为唯一依据；每条 AC 必须有对应测试或可复核证据。
- **契约测试遍历注册表**（§5.9.4）：新增原生工具自动被覆盖。
- 参数化断言 `can('view') === can('invoke')` 对全部可见性组合成立。
- 渗透式验收（不是"测试通过"）：未注册路径 403、无 key 401、审计不可用 -32003、跨用户 session 403。
- 测试失败**保留证据**、修复后记录复测；禁止删除失败用例或改断言使其通过。
- 区分"未验证"与"验证失败"，不得把前者写成后者。

---

## 9. 明确不做（§2.4，实现中遇到直接拒绝）

角色矩阵 · JSON Schema 编辑器 · 自研**语义级**运维能力（SQL 语义 / K8s 资源模型） · 多协议联邦 · 每用户私有凭证 · 内置 chat UI / agent 编排 · 每 server 容器化隔离 · emoji 图标 · 紫粉渐变

> 注意 ADR-022 的边界：**协议级原子能力原生实现（SSH/SFTP）是允许且必要的**，只有"语义级"才属于不做。

---

## 10. 提交约定

- 分支：`feature/opsgate-v1-*` / `fix/*` / `refactor/*`；**不得直接在 `master` 开发**；一个工作分支只承载一个任务包。
- commit 前缀：`feat:` / `fix:` / `refactor:` / `test:` / `docs:`，信息关联任务编号（如 `T1`）。
- `git push`、远程 PR、数据库写入/删除、生产环境操作**均需单独授权**。
- 提交前检查：无凭据、无生成文件、无日志入库。

---

## 11. 配置管理（ADR-024）—— 编码约束

**配置三层，放错层就是 bug**：

| 层 | 放哪 | 读取方式 | 规模 |
|---|---|---|---|
| L0 引导 | env / `<data>/credentials.key` | 仅 `src/config/bootstrap.ts`，**仅 8 项** | 8 |
| L1 系统设置 | `system_settings` 表 | `settings.get('<namespace>.<key>')` | 全部运维策略 |
| L2 代码常量 | `src/config/constants.ts` | 直接 import | 结构契约 |

硬要求：

1. **`src/` 下除 `src/config/` 外不得出现 `process.env`** —— CI 静态检查，命中即失败（AC-61）。业务代码需要配置时一律 `settings.get()`。
2. **禁止硬编码策略值**：超时、预算、截断长度、TTL、上限一律来自 `settings.get()`。代码里出现 `4096` / `30000` / `80` 这类数字而没有常量名，评审打回。
3. **`SETTINGS_SCHEMA` 是唯一定义源**：新增配置项 = schema 加一行（零迁移）。DB 里没有的行 = 用默认值。不要在迁移里 INSERT 配置种子。
4. **六条不可配置红线**（§5.10.5）：审计开关 / 路由 `accessMode` / `can()` 判定 / 凭证加密主密钥 / DB 路径 / `locked=1` 内置规则。CI 检查 schema 中不得出现匹配 `/audit.*(enable|disable|skip)|accessMode|authorize/i` 的 key。
5. **越界与类型不符必须 -32008 且不落库**，不得静默夹取（R-1 fail-fast 哲学）。
6. **配置变更走 write-ahead 审计**，记 `key` + before + after；`is_secret` 项 value 记 `***`。
7. **`requires_restart` 项修改后 UI 必须同时显示"已保存值"与"当前生效值"**，不得只显示其中一个。
8. **L0 新增项必须补死锁理由**：新加 env 变量时，必须在 §5.10.1 表格补一行"为什么不能进 DB"，否则评审打回。默认答案是"能进 DB 就进 DB"。

---

## 12. 变更原则

对 Spec 已确认项的修改走**新增 ADR**，不就地改写 —— 就地改写会让"当初为什么这么定"丢失，这是上一版文档漂移的根因。
