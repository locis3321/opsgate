# 部署说明（OpsGate v1）

> Linux 部署机（Windows 不支持部署：tree-kill / stdio 信号模型，facts §2）。

## Docker 单容器（v1 推荐，Spec §5.2）

网关 + 前端静态资源 + SQLite 数据卷 `/data` 全部在一个容器内。

```bash
cp .env.docker.example .env.docker     # 填 OPSGATE_SESSION_SECRET（32+ 随机串）与 OPSGATE_ADMIN_INIT
docker compose build
docker compose up -d
docker compose logs -f opsgate         # 看到 Server listening at http://0.0.0.0:8080
```

- 访问 `http://<主机>:8080`；数据持久化在 Docker 命名卷 `opsgate-data`（SQLite / credentials.key / 暂存区）
- 镜像内已装：Node 22、`npx`、`uvx`（pypi MCP 条目）、`procps`（tree-kill 依赖 ps）、`tini`（PID1 回收 stdio 子进程）
- 升级：`docker compose build && docker compose up -d`（启动时自动执行迁移，幂等）
- 健康检查：`GET /healthz`（compose HEALTHCHECK 30s）；停止宽限 30s（等待子进程退出）
- MCP 包缓存在容器可写层（首次调用/预热时下载）；需要持久化缓存可额外挂载 `/root/.npm`、`/root/.cache/uv`
- 详细运维、数据备份与已知限制见下文与 `docs/deploy.md`（本文件）

## 单机部署（systemd 备选）

```bash
# 1) 安装 Node 22 + pnpm 10
# 2) 代码与构建
git clone <repo> && cd opsgate && pnpm install && pnpm run build && pnpm --dir frontend run build
# 3) 数据目录与密钥（首启自动生成：credentials.key / session-secret；SQLite WAL 自动迁移）
export OPSGATE_DATA_DIR=/srv/opsgate/data
export OPSGATE_ADMIN_INIT=admin:<初始密码≥10位>   # 仅首次启动生效
export OPSGATE_BIND=127.0.0.1 OPSGATE_PORT=8080 OPSGATE_LOG_LEVEL=info
# 4) systemd 单元（示例/opt/opsgate/opsgate.service）：
#   [Service] ExecStart=/usr/bin/env pnpm exec tsx /opt/opsgate/src/server.ts
#            WorkingDirectory=/opt/opsgate  Environment=OPSGATE_DATA_DIR=...  Restart=on-failure
```

## 环境变量（L0，§5.10.1 全部 8 项）

`OPSGATE_DATA_DIR`（默认 ./data）· `OPSGATE_DB_PATH`（<data>/opsgate.db）· `OPSGATE_CREDENTIAL_KEY`（<data>/credentials.key，0600，首启生成）· `OPSGATE_PORT`（8080）· `OPSGATE_BIND`（127.0.0.1）· `OPSGATE_SESSION_SECRET`（缺省首启生成至 <data>/session-secret）· `OPSGATE_ADMIN_INIT`（username:password，仅首次有效）· `OPSGATE_LOG_LEVEL`（info）。

## 备灾与迁移

- 备份：停止服务后复制整个 `OPSGATE_DATA_DIR`（含 opsgate.db[-wal/-shm]、credentials.key、session-secret、runtime-creds、transfer-staging）。
- 迁移：`drizzle-kit migrate` 于启动时自动执行（幂等）；升级 = 停服→替换代码→`pnpm run build`→启服（自动迁移）。
- 密钥随数据目录整体备份；**丢失 credentials.key 将无法解密已有凭证**。

## 已知限制（写入部署文档，§5.5.7/§10.4）

- 非交互 shell 无 PTY；不做命令白名单（guard_rules 职责）
- 输出截断 4KB；Windows 目标机不支持
- 上传/下载依赖网关暂存盘（配额 2GB，默认值），超大文件需分批
- uvx 实例树内核外内存 ~39MB/实例（实测）；迁移/审计跨月查询按表扫描（上限注明）
- 审计保留 12 个月：**超期归档作业已实现**（`audit.retention_months`，启动即扫 + 每小时；运行参数页可调）
- Market 目录与单条实例化属 v1（ADR-025）；`batch-instantiate` / 批量导入 / `opsgate_request_access` 属 v1.1
