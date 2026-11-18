# 阶段交付范围声明（DELIVERY.md）

## 阶段信息

- 阶段名称: OpsGate v1 阶段交付（M0–M6）
- 阶段目标: 自托管 MCP 网关与控制平面 v1 最小闭环——资产/凭证/分组登记、default-deny 网关、原生 SSH 执行与文件传输、MCP 入口聚合（发现工具+instructions+session 归属）、审计/授权/规则引擎、配置字典、管理端 Web 控制台、**Market 目录与单条实例化（ADR-025，v1 必修）**；批量导入（300 台 CSV）/request_access 属 v1.1，不入本阶段；审计超期归档作业（AC-14，2026-10-22 已实现：按月分表保留期清理+每小时作业）
- 对应需求条目: Spec `docs/opsgate-spec-v1.md` §9（**68 条 AC**）+ §7（API）+ §8（前端）
- 基线提交: `406cbd2`（后续修复提交追加，以最后送测 HEAD 为准）

## 构建与运行

- 构建命令: `pnpm install && pnpm run build && pnpm --dir frontend run build`
- 启动命令: `OPSGATE_DATA_DIR=<dir> OPSGATE_ADMIN_INIT=<user>:<pass> pnpm exec tsx src/server.ts`
- 服务端口: 8080（OPSGATE_PORT 可覆盖）
- 运行入口: `src/server.ts`（单 Node 进程；SQLite WAL；迁移/审计分表/首启管理员自动执行）
- 健康检查端点: `GET /healthz`（200 `{"code":0,"data":{"status":"ok"}}`）

## 依赖服务

| 依赖 | 来源 | 就绪 |
|---|---|---|
| SQLite（内置，better-sqlite3） | 进程内 `<data>/opsgate.db` | ✅ |
| 测试用 sshd（仅 E2E 集成用） | `test/docker/sshd`（Docker 构建，127.0.0.1:2222） | ✅ |
| 社区 MCP 实现（派生工具取样） | PyPI `mysql-mcp-server`（uvx，实测 3 工具） | ✅ 网络可用 |

## 功能清单（本阶段声明范围）

| 功能 ID | 描述 | 端点/页面 | 实现状态 |
|---|---|---|---|
| FR-AUTH | 本地账号（username+password）+ session；管理员建号 | POST /api/v1/auth/sign-in/username、/api/v1/auth/*、/api/v1/users | 已实现 |
| FR-APIKEY | Agent API Key（签发一次/哈希/吊销/归属） | /api/v1/api-keys | 已实现 |
| FR-DENY | default-deny 四层防线（未注册 403、public 白名单断言、accessMode 必填） | 根级 preHandler | 已实现 |
| FR-ASSET | 资产（原生 host + mcp 品类）列表/创建/详情/修改/删除/**槽位绑定（API 层）** | /api/v1/servers* | 已实现（API 层） |
| FR-ASSET-UI-BIND | **凭证槽位绑定/换绑/解绑/手动补槽位的 UI 入口** | `/#/assets/:id` 凭证绑定 Tab | 已实现（2026-10-21：SlotBinder + 未绑定警示 + 换绑/解绑 + 手动补槽位；AC-66 浏览器 E2E：登录→建凭证→建主机(认证槽位)→绑定→信任指纹→连通性测试成功） |
| FR-CRED | 凭证（创建者私有、加密存储、轮换失效、同主校验） | /api/v1/credentials | 已实现 |
| FR-GROUP | 默认三组 + 成员/资产勾选 | /api/v1/groups | 已实现 |
| FR-NATIVE | 原生 SSH 执行层（连接池/指纹/无子进程/截断/无 PTY） | tools `host_*` | 已实现 |
| FR-TRANSFER | 文件传输旁路（一次性 token/暂存/原子落位/三事件审计/敏感路径拦截） | PUT/GET /mcp/transfer/:id | 已实现 |
| FR-MCP | MCP 入口（聚合/发现工具/instructions 裁剪/session 归属/_all 400） | GET/POST/DELETE /mcp、/mcp/preview | 已实现 |
| FR-MARKET | Market 目录浏览 + 单条实例化 + 槽位自动识别 | `/api/v1/market/*`、`/#/market`、`/#/market/:key` | 已实现（2026-10-21：目录 **13 实测条目**+版本固化（AC-62 满足）/ 详情预览+槽位识别 / instantiate+missingSlots+异步预热 / batch-instantiate 未注册 403） |
| FR-AUDIT | write-ahead 审计 + 查询（跨月/统计/详情） | /api/v1/audit* | 已实现 |
| FR-RULES | guard_rules（locked 保护/ReDoS 校验/试跑） | /api/v1/guard-rules* | 已实现 |
| FR-AUTHZ | can() 单源授权（无角色矩阵；view≡invoke） | services/authorize.ts | 已实现 |
| FR-CFG | 配置字典三层（L0 env / L1 系统设置 /settings + -32008 + write-ahead + 待重启） | /api/v1/settings* | 已实现 |
| FR-RUNTIME | 实例池 + runtime 视图 + reconciler | /api/v1/runtime/* | 已实现 |
| FR-UI | 管理端 SPA（12 页面：登录/概览/资产/详情/凭证/分组/审计/安全策略/运行时参数/工具/运行时/成员） | `#/...`（hash 路由，静态托管 / 与 /assets/*） | 已实现（浏览器 E2E 属本阶段送测项） |

> 状态仅允许：已实现 / 未实现。

## 范围文件

- src/（全部：config/routes/services/framework/native/db + server/app）
- frontend/src/（全部页面）
- scripts/check-redlines.mjs、scripts/load-ssh.mjs、scripts/load-uvx.mjs
- test/docker/sshd、test/fixtures/mock-mcp-server.mjs
- docs/（opsgate-spec-v1.md、project-rules.md、project-facts.md、memory/tasks-2610-1618-00/*）

## 自洽声明

- [x] 本阶段声明"已实现"的功能不依赖任何后续阶段未实现的部分即可运行（2026-10-21：FR-MARKET/FR-ASSET-UI-BIND 已补齐；AC-62 已满足（13 条实测）；残留边界 = 规模类 AC-10/19/38（静态推算，已标注非阻塞；AC-14 归档作业已于 2026-10-22 实现））
- [x] 无阻断性 TODO/FIXME/stub 残留在声明范围内（/mcp 无 stub；501 占位仅出现在"未装配 McpEndpoint"的测试骨架路径）
