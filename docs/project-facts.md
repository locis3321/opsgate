# project-facts.md — OpsGate 项目事实清单

> 本文件只放**可复核的硬事实**：版本锚定、关键常量、环境约束、文档路由。
> 规范与"怎么做"在 `docs/project-rules.md`；设计与"为什么"在 `docs/opsgate-spec-v1.md`。
> 三者冲突时按 AGENTS.md §0 处理，不得静默取一方。
>
> 最后更新：2026-10-20（Spec 冻结后首次建立）

---

## 1. 权威文档与路由

| 问题 | 位置 | 状态 |
|---|---|---|
| 产品 / 架构 / 数据模型 / API / 验收（**唯一权威**） | `docs/opsgate-spec-v1.md` | ✅ 2026-10-20 冻结（九轮确认，61 条 AC + 24 条 ADR） |
| 工程规范（顶层） | `AGENTS.md` | ✅ |
| 项目专属规范 | `docs/project-rules.md` | ✅ 本次建立 |
| 项目事实（本文件） | `docs/project-facts.md` | ✅ 本次建立 |
| 任务过程与历史决策 | `docs/memory/tasks-*/` | 进行中 |
| 前端规范 | `docs/opsgate-spec-v1.md` §8 | ✅（旧 `fronted-design-rules.md` 已删） |

**v0 历史文档已全部删除**（2026-10-20，用户指令"不遗留任何历史包袱"）：`docs/mcp-gateway-design.md`、`docs/mcp-gateway-research.md`、`docs/权限体系讨论.md`、`docs/fronted-design-rules.md`、`docs/skill-development-guide.md`、`docs/Redis故障降级逻辑讨论.md`（最后一份删除曾被安全中心拦截，后由用户手动删除，16:53 确认）。删除前均已确认在 Git 版本库内受跟踪，需要回溯时用 `git show <旧提交>:docs/<文件名>` 取回，无需担心丢失。

被取代的关键结论（**不得复活**）：

| v0 结论 | v1 取代者 |
|---|---|
| 凭证可共享 / 授权给他人 | §4.4 + ADR-004、ADR-020：创建者私有，引用权整体取消 |
| 三实体资产模型（资产 + MCP 服务 + 凭证） | §4：单实体 Server = 一条社区原生 MCP 配置 |
| 前端"AI platform visual language" | §8：深色机房控制台 |
| skill 分发引导 Agent | §5.5.4：`initialize.instructions` 服务端动态注入 |
| Redis 为必选依赖 | §5.4：Node 单进程持有全部 stdio 子进程，Redis 非必选 |

**历史包袱清理完毕**：全部 6 份 v0 文档已从工作区删除（最后一份 `Redis故障降级逻辑讨论.md` 由用户手动删除，16:53 确认）。全仓检索旧文件名零死链；后续检索无需再 `--exclude` 该文件。

---

## 2. 目标规模（设计基线，不是当前状态）

| 项 | 值 |
|---|---|
| 主机资产 | 300 台 Linux（`category=host`，默认 `execution_mode=native`） |
| MySQL | 30 个（`category=mysql`，`execution_mode=mcp`） |
| K8s 集群 | 4 个（`category=k8s`，`execution_mode=mcp`） |
| 用户 | 20 人（本地账号，每人一个 API Key） |
| 部署机内存 | **16 GB** |
| 部署 OS | Linux（**Windows 不支持部署**：tree-kill / stdio 信号模型） |
| 网络位置 | 全部内网地址 → `allow_private_network` 实际每个资产都要开一次 |

---

## 3. 技术栈版本锚定（§5.1，Spec 锁定）

| 层 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 运行时 | Node.js | 22 LTS | stdio 子进程管理、单进程事件循环 |
| 后端 | Fastify | ^5.2 | 内建 JSON Schema 校验、OpenAPI 自动导出 |
| ORM | Drizzle | ^0.44 | SQL-like、类型来自 schema、迁移内建 |
| DB | SQLite（better-sqlite3）+ WAL | ^12 | 单进程自托管零依赖 |
| MCP SDK | `@modelcontextprotocol/sdk` | ^1.29 | 官方主线 |
| 认证 | better-auth | ^1.6 | session + API Key 双主体 |
| **SSH 客户端** | **ssh2** | **^1.16** | 原生执行层（ADR-022） |
| 前端 | React + Vite SPA | ^19.2 / ^6.3 | 纯管理后台无 SEO |
| UI | Tailwind CSS 4 + shadcn/ui + TanStack Query v5 + react-router-dom 7 | — | — |
| **图标** | **lucide-react** | **^1.59.0** | 全项目**唯一**图标库，禁止 emoji，禁止第二套 |
| 其他 | `tree-kill` ^1.2、`ipaddr.js` ^2.4、`zod` ^4、Node 内建 `node:crypto` | — | ReDoS 校验另需 `safe-regex2` |

> `lucide-react` 版本曾误判为 0.x，经 `npm view lucide-react version` 实测确认 latest = 1.59.0。**实现时以 lock 文件锚定，不要凭记忆写版本号。**

---

## 4. 关键常量（实现时直接引用，不要重新推导）

> **⚠ 层级标注（ADR-024，§5.10）**：下表每一项都标了归属层。
> **L1** = 进 `system_settings` 表，admin 在 `/settings` 运行时参数页可改，**实现时必须走 `settings.get()`，不得硬编码**；
> **L2** = 代码常量（`src/config/constants.ts`），是结构契约，UI 不可改。
> 除了 §4.0 的 8 项 L0，本节其余策略值**一律 L1**。

### 4.0 L0 引导配置（仅此 8 项走 env / key file，UI 不可改）

| 变量 | 默认 | 为什么不能进 DB |
|---|---|---|
| `OPSGATE_DATA_DIR` | `./data` | 连数据库的路径本身不能来自数据库 |
| `OPSGATE_DB_PATH` | `<data>/opsgate.db` | 同上 |
| `OPSGATE_CREDENTIAL_KEY` | `<data>/credentials.key`（0600，首启生成） | 用它加密凭证，不能存在它保护的数据旁边（循环） |
| `OPSGATE_PORT` | `8080` | 服务没起来就没有 UI 可改 |
| `OPSGATE_BIND` | `127.0.0.1` | 同上 |
| `OPSGATE_SESSION_SECRET` | 首启生成 | 同上，且属密钥 |
| `OPSGATE_ADMIN_INIT` | — | 首次启动建账号，此时表是空的（仅首次生效）。**格式 `username:password`**（T3 定义；密码 ≥10 位） |
| `OPSGATE_LOG_LEVEL` | `info` | 数据库还没连上时就要能打日志（排障刚需） |

> 补充事实：`OPSGATE_SESSION_SECRET` 未设置时首启生成并持久化到 `<data>/session-secret`（0600，T3 定义）。

新增 L0 项必须在本表补一行"为什么不能进 DB"。**默认答案是"能进 DB 就进 DB"。**

### 4.1 实例池（§5.4，仅服务 `execution_mode='mcp'` 的资产）— **全部 L1**

| 常量 | 值 | settings key |
|---|---|---|
| 全局实例预算 | **80**（硬上限 96） | `instance_pool.global_budget` |
| 全局权重预算 | **200**（Node 类权重 3 / uvx 类权重 2；**实测 F 校准 2026-10-20**：uvx 实例总内存 ≈39MB（uv 13 + python 22，估 60-120MB 低取），Node 类可按 npx 实例再校准；权重 2 维持） |
| 单资产实例数 | 2（可配 1–4） |
| 单用户排队长度 | 8（超出 429） |
| 全局并发调用上限 | 64（信号量） |
| idle TTL | 5 min |
| 并发降级阈值 | 等待 >3s 且 `maxInstances≥2` 且预算允许 → 开第二实例 |
| 排队超时 | 15s → `-32002` |
| 实例键 | `hash(serverId + configHash + sorted([(slotName, credentialId, credentialUpdatedAt)]))` |
| 预热 | 只拉包不常驻：`拉起 → handshake → listTools → 立即关闭`；并发上限 2，10min 退避 |
| uvx 实测（F） | 冷启动首启 4.4–6.4s（含下载）、缓存后 ~1.1s；`mysql-mcp-server` **真实工具数 = 3**（Spec §5.5.1 估 6，任务 K 校准值）；孙进程必须 tree-kill（SDK close 只杀父，实测残留） |

**实例池覆盖规模**：host 原生化后实例池只需覆盖 **34 个 MCP 资产**（30 MySQL + 4 K8s），80 预算充裕。

### 4.2 原生 SSH 连接池（§5.5.7）— **全部 L1**

> 对应 settings key：`ssh_pool.*`。完整 key/默认/范围清单见 **Spec §5.10.6**（本文件不重复维护，避免两处漂移）。

| 常量 | 值 |
|---|---|
| 连接键 | `(assetId, credentialFingerprint)` |
| idle TTL | 5 min |
| 并发 | 每连接 FIFO 串行；全局信号量 32 |
| 排队/超时 | 同实例池（3s 降级 / 15s `-32002`） |
| 主机指纹 | 管理端显式 trust，不一致拒绝连接；**不做自动信任** |
| 单条成本（**实测校准，2026-10-20，任务 N**） | **~0.03MB/连接**（300 连接 RSS 增量 9MB；原估算 2–5MB/0.6–1.5GB 大幅高估，无需回调 §5.4 配额） |
| 并发稳定性（实测） | 300 连接并发 25 零失败；平均建连 ~1.26s（首批）；300 全量 ~18s。测试环境 Docker sshd（test/docker/sshd，MaxStartups/MaxSessions 需放开） |

### 4.3 工具暴露（§5.5）— **全部 L1**（`tools.*`）

> key 清单见 Spec §5.10.6。**例外**："工具数 ~28" 是结构结果不是配置项；"全量 schema token 预算" 是验收阈值，作为 `tools.schema_token_budget` 用于 CI 断言。

| 常量 | 值 |
|---|---|
| 工具数 | 全端点 **~28**（host 6 / mysql 8 / k8s 14），**与资产数无关**。**任务 K 实测校准（2026-10-20）**：`mysql-mcp-server` 真实工具 = **3**（execute_sql / get_schema_info / get_table_sample），工具名 `mysql_execute_sql` 等；k8s 待接入实测 |
| `tools/list` 上限 | 200，超过 → `-32005`，**不静默截断** |
| 工具 description 上限 | 200 字；参数 description 上限 80 字 |
| 全量 schema token 预算 | < 15k |
| 命令输出截断 | stdout/stderr 各 4 KB，置 `truncated=true` |
| 命令 timeout | 默认 30s，上限 300s |

### 4.4 文件传输（§5.5.7 临时入口）— **全部 L1**（`transfer.*`）

> key 清单见 Spec §5.10.6。**例外**：传输 token 32B 随机是结构常量（L2）。

| 常量 | 值 |
|---|---|
| 上传/下载单文件上限 | **200 MB** |
| 入口 TTL | 5 min（上传用后即焚，下载单次使用） |
| 传输 token | 32 B 随机，**不是 API Key** |
| 暂存目录 | `<data>/transfer-staging/`（0700），TTL 15 min 清理，配额 **2 GB** |
| sha256 | 申请时提供则强校验，不匹配拒收并作废入口 |

### 4.5 审计（§4.5、§5.6、§5.7）— **L1 与 L2 混合**

> L1：`audit.retention_months`（12）、`audit.arg_truncate_bytes`（4096）。
> **L2（结构契约，UI 不可改，改了就是改代码）**：分表命名 `audit_log_YYYY_MM`、脱敏 key 正则、加密格式 `v1.<iv>.<tag>.<ciphertext>`、AAD = credentialId、上传审计固定 3 条事件。
> ⚠ **"是否启用审计"永远不是配置项**（R-2）。

| 常量 | 值 |
|---|---|
| 分表 | `audit_log_YYYY_MM`，按月 |
| 保留期 | 12 个月，超期归档 |
| 入参脱敏 key 正则 | `password\|secret\|token\|key\|passwd\|credential`（忽略大小写）→ `***` |
| 截断 | 入参 4 KB；output 前 4 KB + 结构摘要 |
| 上传审计事件 | **3 条**：request intent（pending）→ 传输完成 → 落位完成 |
| 凭证加密 | AES-256-GCM，格式 `v1.<iv b64>.<tag b64>.<ciphertext b64>`，AAD = credentialId |

### 4.6 凭证槽位（§5.3）— **L1 与 L2 混合**

> L1：`credentials.max_slots`（32）。
> **L2**：占位符正则 `/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/`、敏感键启发式、槽位结构四字段 —— 这些是**协议形状**，UI 可改会导致配置与已存数据不兼容。

| 常量 | 值 |
|---|---|
| 占位符正则 | `/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/` |
| 敏感键启发式 | key 含 `secret\|token\|password\|api_key\|private_key\|passwd\|credential` |
| 槽位结构 | `{target: env\|args\|headers, name, label, file: boolean}`，≤32 个 |

---

## 5. 错误码（唯一清单）

| 码 | 含义 | 触发点 |
|---|---|---|
| `-32002` | 实例忙 / 排队超时（SSH 连接复用此码） | 15s 超时 |
| `-32003` | 审计不可用 → **拒绝调用**（无降级旁路） | write-ahead 失败 |
| `-32004` | 被 `kind=block` 规则拒绝 | 返回 ruleId + ruleName，**不含 pattern** |
| `-32005` | 分组工具数超限（需 `?tag=` 收窄） | `tools/list` > 200 |
| `-32006` | 资产不存在 **或** 无权（**两者不区分**） | asset 解析失败 |
| `-32007` | 文件超出大小限制 / 暂存配额不足 | >200MB |
| `401` | 无 Bearer key | `/mcp` 全方法 |
| `403` | 未注册路径或未授权 | default-deny 根级 |
| `400` | 业务校验失败（如跨主绑定凭证） | 写入侧 |
| `429` | 单用户排队超限 | 队列 > 8 |

---

## 6. Git 事实（2026-10-20 16:58 更新，含拓扑）

### 6.1 分支拓扑（实测）

```
master @ 7cc05a3 —— 旧项目完整代码（185 个文件），是 9177f9a 的祖先
mcp-gateway-v1 @ 9177f9a「清理实现错误的代码，以便轻装上阵，重新开发」
                  树 = 仅 7 个文件（AGENTS.md + 6 份 v0 文档），零代码
当前工作区（未提交）= 删 6 份 v0 文档 + 新增 Spec v1 / 工程文档 / 任务包 / AGENTS.md 修订
```

| 项 | 值 |
|---|---|
| 默认分支 | `master`（**HEAD 7cc05a3 含旧代码，不能作为 v1 基准**） |
| 当前分支 | `mcp-gateway-v1`（HEAD = `9177f9a` = v1 基准提交） |
| **工作分支（已确认）** | **`feature/opsgate-v1-core`** |
| 工作区未提交 | 上述全部文档变更；`.workbuddy/` 为本地会话数据不入库 |
| 远程 | `origin`（含 `master` / `mcp-gateway-v1` / `greenfield-policy-gateway-v1`） |

### 6.2 建分支步骤（T1 执行，⚠ 基准必须是 9177f9a）

1. 先把工作区文档变更（删 6 份 + 新增 v1 文档 + AGENTS.md 修订）落成一个 `docs:` 提交——不与脚手架混在一起。`.workbuddy/` 先加入 `.gitignore`；
2. `git checkout -b feature/opsgate-v1-core`（**当前 HEAD 就是 9177f9a，直接建即可；未提交变更会原样带到新分支，不会丢**）；
3. 后续全部开发在新分支进行。

**禁止从 `master` HEAD（7cc05a3）建分支** —— 那会把 185 个文件的旧代码全部带回来。

**树干净 ≠ 历史干净**：从 9177f9a 建分支后工作树无任何旧代码/旧文档，但 git 历史仍含旧项目提交链。这是刻意保留的回溯安全网（删除 v0 文档前验证过"Git 内受跟踪可回溯"；旧决策 D1–D36、旧代码均可 `git show` 查证）。**不做孤儿分支**。远程 master 上的旧代码与 v1 的关系（v1 完工后 master 如何处置：指向 v1 / 新默认分支 / 保持归档）在 M7 交付前再定，届时走用户确认。

---

## 7. 待办 / 未决（实现前必须关闭）

| # | 事项 | 状态 |
|---|---|---|
| F-1 | `AGENTS.md` §17 路由指向已废弃的 `mcp-gateway-design.md` | ✅ 已关闭（2026-10-20，§17 改为指向 Spec v1 + 新增 §17.1 禁止复活清单） |
| F-2 | 旧设计文档物理清理 | ✅ 已关闭（6 份全部删除；Redis 那份由用户手动删除，16:53 确认） |
| F-3 | `docs/fronted-design-rules.md` 与 Spec §8 冲突 | ✅ 已关闭（旧文件已删，前端规范统一指向 Spec §8） |
| F-4 | 构建 / 测试 / 格式化命令尚未建立（项目当前无代码） | ✅ 已关闭（2026-10-20，T1 建立并回填 §8：build/dev/test/lint/typecheck/migrate/seed/check:redlines + CI） |
| F-5 | 工作分支名 | ✅ 已关闭（2026-10-20 16:53 用户确认 `feature/opsgate-v1-core`，T1 执行创建） |
| **F-6** | **Market 模块整块被推迟 + 凭证绑定无 UI**（2026-10-21 审核发现） | ⏳ **未关闭 → v1 必修（ADR-025）**。新增任务包 T11（Market 目录与实例化）/ T12（凭证槽位绑定 UI）。证据：`src/routes/market.ts` 与 `src/data/market-catalog.json` 不存在；`frontend/src` 中 `slots` 零引用；`servers.market_key` 字段不存在；`GET /credentials/candidates` Spec §7 有写但漏实现 |
| **F-7** | **AC-13 被标注"Market（v1 不适用）"** | ⏳ 未关闭。该标注是缺口被漏过的证据之一，ADR-025 后撤销，改由 AC-62~65 覆盖（`AC-映射表.md` 已注明） |

---

## 8. 命令（唯一命令来源，T1 建立）

命令一律以 `package.json` scripts 为准，**禁止在对话里临时发明命令**（AGENTS.md §1.6）。

```bash
pnpm install            # 安装依赖（pnpm 10；lock 锚定）
pnpm run dev            # tsx watch 启动开发服务（T3 起可用）
pnpm run build          # tsc -p tsconfig.build.json（排除 *test.ts）
pnpm run typecheck      # tsc --noEmit（含测试文件）
pnpm run lint           # eslint .（flat config；T4 将追加 tools/** 禁 import 规则）
pnpm run test           # vitest run（node 环境，src/**/*.test.ts）
pnpm run test:watch     # vitest 交互模式
pnpm run migrate        # drizzle-kit migrate（T2 起可用）
pnpm run seed           # tsx src/db/seed.ts（T2 起可用）
pnpm run check:redlines # 红线静态检查：AC-58（schema 不可配置 key）/ AC-61（process.env 泄漏）/ emoji 扫描
```

CI（`.github/workflows/ci.yml`）：`lint + typecheck + check:redlines + test + build`，Node 22 + pnpm 10。

**工具链版本锚定（T1 实测，2026-10-20）**：

| 包 | 版本 | 备注 |
|---|---|---|
| typescript | ~6.0.3 | **7.0.2 超出 typescript-eslint peer `<6.1.0`，勿升**（安装时 peer 警告） |
| eslint | ^9.39.5 | eslint 10 未采用（flat config 行为待验证） |
| @eslint/js | ^9.39.5 | 与 eslint 9 配套 |
| typescript-eslint | ^8.72.0 | 支持 eslint 9 / TS <6.1 |
| vitest | ^5.0.5 | node 环境；后续前端复用 |
| @types/node | ^22.20.5 | 与 Node 22 LTS 匹配 |
| globals | ^17.13.0 | eslint 的 node 全局声明（.mjs 脚本） |
| drizzle-orm | ~0.44.7 | 与 better-sqlite3 配套；列上 `.eq` 不可用，用 `eq()` 导入 |
| better-sqlite3 | ~12.11.1 | **原生模块**：pnpm 10 需 package.json `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` 批准构建脚本，否则 bindings 找不到 |
| drizzle-kit | ~0.31.11 | 迁移生成/执行；`drizzle.config.ts` 在根级（AC-61 只扫 src/） |
| tsx | ~4.23.15 | dev/seed 的 TS 直接执行器 |

