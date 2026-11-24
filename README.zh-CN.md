# OpsGate

[English](README.md) · **简体中文**

自托管的 MCP 网关与控制平面，用于把多品类基础设施资产（Linux 主机、数据库、Kubernetes、中间件）统一暴露给 AI agent，并对每次调用做策略校验与审计留痕。

单个 Node 进程 + SQLite，无外部依赖，无 Redis，无消息队列。

---

## 目录

- [解决什么问题](#解决什么问题)
- [核心设计](#核心设计)
- [功能范围](#功能范围)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [配置](#配置)
- [架构](#架构)
- [安全模型](#安全模型)
- [错误码](#错误码)
- [开发](#开发)
- [项目文档](#项目文档)
- [已知限制](#已知限制)

---

## 解决什么问题

把基础设施资产接给 AI agent 时，通常会撞上四个问题：

| 问题 | 常见后果 |
|---|---|
| **工具数量随资产增长** | 300 台主机 = 300 份相同工具；超出客户端工具上限，上下文直接爆掉 |
| **引导要分发到客户端** | 20 个使用者各装一份 skill / 提示词，版本必然漂移 |
| **凭证散落在客户端** | 每人在自己机器上存一份生产密码 |
| **调用无审计** | 出了事故无法回答"谁、何时、对哪台机器、执行了什么" |

OpsGate 的做法：

- **按品类聚合工具**：300 台主机共用同一套工具，资产降为 `asset` 入参，工具数与资产数解耦
- **服务端下发引导**：`initialize.instructions` 随连接自动下发，客户端零安装
- **凭证集中托管**：加密存储，按资产绑定，调用时在网关内注入，使用者看不到明文
- **写入前审计**：审计不可用即拒绝调用，没有降级旁路

---

## 核心设计

### 1. 单入口分层暴露

`/mcp` 是唯一的 MCP 入口。裸连接只暴露 **7 个平台工具**，工具数恒定：

| 工具 | 用途 |
|---|---|
| `opsgate_list_assets` | 列出当前连接可见的资产（id / name / category / tags） |
| `opsgate_view_asset` | 查看单个资产详情（不含任何密钥值） |
| `opsgate_list_groups` | 列出分组及其业务说明 |
| `opsgate_view_group` | 查看分组构成 |
| `opsgate_list_asset_tools` | 列出**某个资产**可用的工具与参数 schema |
| `opsgate_invoke` | 在某个资产上执行工具 |
| `opsgate_select_scope` | （可选）把本连接切换为某范围的完整工具集 |

标准调用链三步：

```
opsgate_list_assets          → 找到目标资产
opsgate_list_asset_tools     → 看这个资产能做什么、参数怎么填
opsgate_invoke({asset, tool, args}) → 执行
```

这条路径**不依赖客户端消费 `notifications/tools/list_changed`**，因此任何 MCP 客户端都可用。若客户端支持动态工具列表刷新，也可用 `opsgate_select_scope` 把某个分组/品类/tag 的工具铺开为一级工具。

### 2. 原生执行优先

| 资产类型 | 执行方式 | 每实例成本 | 冷启动 |
|---|---|---|---|
| `host`（Linux 主机） | 进程内 ssh2 连接池 | ~2–5 MB | 100–500 ms |
| `zabbix` / `rocketmq` / `nacos` | 进程内 HTTP 工具 | 无常驻 | 直接请求 |
| 其他社区 MCP 实现 | spawn 子进程（stdio / http / sse） | ~40–120 MB | 1–30 s（需拉包） |

只有必须复用社区实现的品类才走实例池。实例池有全局预算（实例数 / 加权内存 / 拉起并发三重门闩）、空闲回收、崩溃退避重建。

### 3. 三档配置

| 档位 | 载体 | 改动方式 | 例子 |
|---|---|---|---|
| **L0** | 环境变量 | 改环境变量 + 重启 | 数据目录、端口、会话密钥 |
| **L1** | `system_settings` 表 | 运行参数页即时生效（少数项需重启） | 实例预算、传输限额、审计保留期、MCP 引导文案 |
| **L2** | 代码常量 | 改代码 | 错误码、协议形状、加密格式 |

L1 采用**声明式 schema**：`src/config/settingsSchema.ts` 是唯一定义源，DB 只存偏离默认值的行，无行即用默认值。新增配置项 = 加一行，零迁移。

### 4. 授权单一真值源

全项目只有一个授权函数 `can()`（`src/services/authorize.ts`）。可见性判定与调用许可共用同一表达式 —— 能看见即能调用，不存在"看得见但调不动"或"调得动但看不见"的错位。

---

## 功能范围

### 资产管理

- 资产登记：品类、执行模式、连接参数、可见性（`owner` / `group` / `public`）、所属分组
- 编辑范围受限：名称、显示名、说明、标签、连接目标（host / port / 用户名 / 认证槽位）、地址与两个安全开关可改；**品类、执行模式、传输类型、command、args、env、headers 创建后固定** —— PATCH 接口直接 400 拒绝而不是静默忽略，形态建错应重建资产而非改造旧资产
- 批量启用 / 停用
- 支持自签 TLS 证书（按资产显式开启，默认关闭）

### 凭证管理

- AES-256-GCM 加密存储，密钥与本机数据目录绑定
- **一槽位多凭证**：同一人在同一槽位可同时持有个人凭证与共享凭证
- 绑定级登录用户名（同一凭证在不同资产上用不同账号）
- 精确键取值（`credential_key`），避免凭证改名后取到错值
- 凭证轮换即时生效（实例键含凭证指纹，轮换后自动新建实例）

### 分组

自由组织单元，不绑定品类。职责是：关联资产、授权成员、快速筛选、构成查看权。

### 安全策略

三级作用域 × 五档匹配维度，两者正交：

| 维度 | 取值 |
|---|---|
| **作用域**（对哪些资产生效） | `global` / `asset_type` / `asset` |
| **匹配维度**（拿什么去匹配） | `tool`（工具名）/ `arg`（参数值，递归展开）/ `body`（整份请求体，含键名）/ `asset_type` / `group` |
| **动作** | `mark`（标记高危）/ `block`（拒绝调用，返回 `-32004`） |

内置 8 条安全底线规则（云元数据地址、凭据路径读取、命令注入特征、敏感路径上传、SQL 写操作等），管理员可改可删，删除责任归管理员。正则入库前经 `safe-regex2` 校验，拒绝可回溯爆炸的表达式。

### 审计

- 每次调用写入 `谁 / 何时 / 用哪个凭证 / 对哪个资产 / 执行什么工具与参数`
- **write-ahead**：先写 pending 再执行，审计库不可用即拒绝调用
- 按月分表，保留期可配（默认 6 个月），超期自动清理
- 敏感字段入库前脱敏，参数按配置截断
- 支持按五要素检索、导出、单条/批量删除

### 文件传输

文件本体不经 MCP 工具参数传输：

```
申请入口（一次性 token，5 分钟有效）→ HTTP PUT/GET 传本体 → 状态查询确认落位
```

单文件上限可配（默认 200 MB），暂存区配额与清理 TTL 可配。

### Market 目录

16 条预置模板（MySQL / K8s / Redis / Docker / Prometheus / RocketMQ / Kafka / Nacos / Zabbix / 宝塔 等），一键实例化。条目状态机 `draft` → `verified` → `disabled`，管理员可在后台增删改、连通性测试、状态变更。

### 管理端控制台

React 单页应用，18 个页面：登录页 + 12 个一级页面（概览、资产、市场、凭证、分组、审计、策略、参数、原生工具、运行时实例、成员、API Key）+ 5 个详情/管理页（资产详情、凭证详情、分组详情、Market 条目详情、Market 后台管理）。深色优先，暗/亮/跟随系统三档主题。

---

## 技术栈

**后端**

| 组件 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 22 | 运行时 |
| TypeScript | 6.0 | 语言 |
| Fastify | 5.x | HTTP 服务 |
| MCP SDK | 1.32 | MCP 协议实现 |
| Drizzle ORM | 0.44 | 数据访问 |
| better-sqlite3 | 12.x | SQLite 驱动（WAL） |
| ssh2 | 1.17 | 原生 SSH / SFTP |
| better-auth | 1.7 | 会话认证 |
| Zod | 4.x | 参数校验 |

**前端**

| 组件 | 版本 | 用途 |
|---|---|---|
| React | 19 | UI 框架 |
| React Router | 7 | 路由（hash 模式） |
| TanStack Query | 5 | 服务端状态 |
| Tailwind CSS | 4 | 样式（设计令牌驱动） |
| Vite | 6 | 构建 |

**测试**：Vitest 5 — 53 个测试文件，525 个用例（517 通过 / 8 跳过）。

---

## 快速开始

### Docker（推荐）

```bash
cp .env.docker.example .env.docker
```

编辑 `.env.docker`，至少填写两项：

```bash
OPSGATE_SESSION_SECRET=<32 位以上随机串>
OPSGATE_ADMIN_INIT=admin:<初始密码，10 位以上>
```

启动：

```bash
docker compose build
docker compose up -d
docker compose logs -f opsgate
```

看到 `Server listening at http://0.0.0.0:8080` 后访问 `http://<主机>:8080`。

数据（SQLite、加密密钥、传输暂存区）持久化在命名卷 `opsgate-data`。

### 单机

```bash
# 前置：Node 22+、pnpm 10+
pnpm install
pnpm run build
pnpm --dir frontend install && pnpm --dir frontend run build

export OPSGATE_DATA_DIR=/srv/opsgate/data
export OPSGATE_ADMIN_INIT=admin:<初始密码，10 位以上>
pnpm exec tsx src/server.ts
```

首次启动自动执行数据库迁移，并创建管理员账号（仅 `users` 表为空时生效）。

### 接入 MCP 客户端

1. 登录控制台 → **API Key** → 新建，复制明文（只显示一次）
2. 在客户端配置：

```json
{
  "mcpServers": {
    "opsgate": {
      "type": "http",
      "url": "http://<主机>:8080/mcp",
      "headers": { "Authorization": "Bearer <API Key>" }
    }
  }
}
```

3. 连接后即可用 `opsgate_list_assets` 开始。

也可以带范围参数直接初始化：`/mcp?category=host`、`/mcp?group=prod`、`/mcp?tag=web`。

---

## 配置

### 环境变量（L0）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPSGATE_DATA_DIR` | `./data` | 数据根目录 |
| `OPSGATE_DB_PATH` | `<data>/opsgate.db` | SQLite 路径 |
| `OPSGATE_CREDENTIAL_KEY` | `<data>/credentials.key` | 凭证加密密钥（0600，首启生成） |
| `OPSGATE_PORT` | `8080` | 监听端口 |
| `OPSGATE_BIND` | `127.0.0.1` | 监听地址 |
| `OPSGATE_SESSION_SECRET` | 首启生成至 `<data>/session-secret` | 会话签名密钥 |
| `OPSGATE_ADMIN_INIT` | — | `username:password`，仅首次启动生效 |
| `OPSGATE_LOG_LEVEL` | `info` | `info` / `warn` / `error` |

> 丢失 `credentials.key` 将无法解密已有凭证。备份数据目录时必须整体备份。

### 运行参数（L1）

控制台「运行时参数」页可调，26 项，分 8 组：

| 分组 | 代表项 |
|---|---|
| 实例池 | 全局实例预算、加权内存预算、单资产实例数、单用户排队长度、空闲回收 TTL、排队超时、降级等待阈值 |
| SSH 连接池 | 空闲 TTL、全局并发上限 |
| 工具 | 工具列表上限、schema token 预算、输出截断字节、命令超时、停用原生工具 |
| 文件传输 | 单文件上限、入口 TTL、暂存配额、暂存清理 TTL |
| 审计 | 保留期（月）、入参截断字节 |
| 凭证 | 槽位上限、使用者告警阈值 |
| MCP | 工作流引导文案（注入每个连接的 `initialize.instructions`） |
| 通用 | npm / PyPI 镜像源 |

多数项**即时生效**，无需重启；标「需重启」的项会在页面提示已保存值 ≠ 当前生效值。

---

## 架构

```
                        ┌──────────────────────────────┐
   AI 客户端 ──MCP──────▶│  /mcp  （单入口）             │
   （Bearer API Key）    │  ├─ 平台工具 7 个             │
                        │  ├─ 工具聚合（按品类）         │
                        │  └─ initialize.instructions   │
                        └──────────────┬───────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌────────────────┐      ┌─────────────────┐     ┌──────────────────┐
     │ 安全策略引擎    │      │  执行层          │     │  审计（write-ahead）│
     │ 作用域 × 维度   │      │  ├─ ssh2 连接池  │     │  按月分表         │
     │ block / mark   │      │  ├─ HTTP 工具    │     │  脱敏 + 截断      │
     └────────────────┘      │  └─ 实例池 spawn │     └──────────────────┘
                             └────────┬────────┘
                                      │
                             ┌────────▼────────┐
                             │  凭证解析 + 注入  │
                             │  AES-256-GCM     │
                             └─────────────────┘

   控制台（React SPA）──REST /api/v1──▶ 同一进程
```

**目录结构**

```
src/
├── app.ts                  Fastify 装配与路由注册
├── server.ts               进程入口（配置、服务装配、后台作业）
├── config/                 L0 引导、L1 设置 schema、L2 常量
├── db/                     Drizzle schema、迁移、种子
├── framework/              原生工具契约与 dispatch
├── native/
│   ├── connectors/         ssh2 / HTTP / redis / kafka 连接器
│   └── tools/              host / zabbix / rocketmq / nacos / redis / kafka 原生工具
├── routes/                 REST 路由（15 个路由模块）
└── services/               领域服务（聚合、实例池、审计、凭证、策略…）
frontend/
└── src/pages/              18 个控制台页面
```

**关键技术决策**（完整记录含 ADR-001 至 ADR-036，见 `docs/opsgate-spec-v1.md` §10）

| 决策 | 内容 |
|---|---|
| ADR-021 | 按品类聚合工具，资产降为入参 |
| ADR-022 | 原生执行 vs 社区实现代理的分层 |
| ADR-030 | `?group=` 改为按分组实体过滤 |
| ADR-032 | MCP 单入口分层暴露 + `opsgate_select_scope` |
| ADR-033 | 元工具 `opsgate_invoke`，不依赖客户端刷新工具目录 |
| ADR-035 | 资产形态与执行配置创建后不可改 |
| ADR-036 | 原生运维能力扩容（Redis/Kafka connector、raw 工具准入） |

---

## 安全模型

### 分层防线

1. **传输**：Bearer API Key（`/mcp`）或会话 Cookie（控制台），二者不互通
2. **授权**：单一 `can()` 判定，可见 ≡ 可调用
3. **策略**：正则匹配工具名 / 参数 / 请求体，命中 `block` 直接拒绝
4. **审计**：write-ahead，写不进去就不执行
5. **凭证**：只在网关进程内解密，不返回给客户端，不写入审计
6. **SSRF**：内网地址与云元数据端点默认拦截，可按资产显式放开

### 明确不做

- **不做命令白名单**：那是安全策略的职责，执行层不做第二套判断
- **不做审计降级**：不提供"临时跳过审计"开关
- **不做角色矩阵**：身份只有管理员与成员两种
- **不信任客户端**：所有约束在服务端强制执行，客户端的引导文案只是提示

### 高危操作

以下操作默认标记为 `risk=high` 并写入审计：删除/写入/重启类工具、SQL 写操作、上传到敏感路径、命中命令注入特征的命令。

内置引导文案要求模型在执行前复述目标与完整命令、等待用户确认。该文案可由管理员在运行参数页修改 —— 修改后安全管理权转移给管理员，网关不提供第二道兜底。

---

## 错误码

MCP 调用错误遵循 JSON-RPC 扩展码：

| 码 | 含义 | 建议动作 |
|---|---|---|
| `-32002` | 实例忙 / 排队超时 / 连接失败 | 缩小范围重试 |
| `-32003` | 审计不可用，调用被拒绝 | 检查数据库状态；重试无用 |
| `-32004` | 命中安全策略（block 规则） | 不要绕过，联系管理员确认 |
| `-32005` | 工具数超出上限 | 用 `?tag=` 或 `?category=` 收窄 |
| `-32006` | 资产不存在或无权访问 | 不要重试；两者不区分以防探测 |
| `-32007` | 文件超出大小限制 / 暂存配额不足 | 分批传输 |
| `-32008` | 配置项校验失败 | 按 message 修正 |

REST 接口统一返回 `{ code, data, message }`，`code: 0` 为成功。

---

## 开发

```bash
pnpm install                 # 安装后端依赖
pnpm --dir frontend install  # 安装前端依赖

pnpm run dev                 # 后端开发模式（tsx watch）
pnpm --dir frontend run dev  # 前端开发模式（Vite，代理 /api 到 8080）

pnpm run typecheck           # 类型检查
pnpm run lint                # ESLint
pnpm test                    # 全量测试
pnpm run check:redlines      # 项目红线检查
pnpm run seed                # 写入种子数据（内置规则、Market 目录）
```

**测试要求**：`vitest.config.ts` 将并发上限固定为 4 个 worker（`maxWorkers: 4`）。按 CPU 核数铺满会同时起十几个 better-sqlite3 + Fastify 实例，把开发机 CPU 打满；集成测试以 IO/等待为主，4 个 worker 足以饱和。

**提交前门禁**：`typecheck` → `lint` → `test` → `check:redlines` 全部通过。

**新增配置项**：在 `src/config/settingsSchema.ts` 加一行，无需迁移。

**新增原生工具**：在 `src/native/tools/<category>/` 下加文件，描述必须包含 `Use when:` / `Required:` / `Risk:` 三段，否则启动期校验失败。

---

## 项目文档

| 文档 | 内容 |
|---|---|
| [`docs/opsgate-spec-v1.md`](docs/opsgate-spec-v1.md) | 设计权威：数据模型、工具暴露、安全约束、API、验收标准，以及 ADR-001 至 ADR-036 全部架构决策记录（§10） |
| [`docs/deploy.md`](docs/deploy.md) | 部署、备份、迁移、已知限制 |

---

## 已知限制

- **仅支持 Linux 部署**：Windows 不支持（依赖 `tree-kill` 与 stdio 信号模型）
- **非交互 shell**：无 PTY，不支持需要交互的命令
- **输出截断**：default 4 KB，超出置 `truncated: true`；需要完整内容时自行收窄命令
- **文件传输依赖网关暂存盘**：超大文件需分批
- **Windows 目标主机不支持原生 SSH 执行**
- **审计跨月查询按表扫描**：分表设计下跨月检索有性能上限
- 批量导入（CSV）、批量实例化属 v1.1，未包含在 v1

---

## 许可

尚未指定开源许可。使用前请联系维护者。
