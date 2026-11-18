# OpsGate v1 — 单容器镜像（Spec §5.2：网关 + 前端静态 + SQLite /data 卷）
# Linux only（tree-kill / stdio 信号模型，Spec §10.4）
# 构建：docker compose build
# 运行：docker compose up -d

# ---------- build ----------
FROM docker.1ms.run/library/node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
RUN cd frontend && pnpm install --frozen-lockfile
COPY . .
# 后端 tsc（postbuild 会把 migrations/meta + src/data 拷进 dist）+ 前端 vite build
RUN pnpm run build && cd frontend && pnpm run build

# ---------- runtime ----------
FROM docker.1ms.run/library/node:22-bookworm-slim AS runtime

# procps: tree-kill 依赖 ps；tini: PID1 回收 stdio 子进程；curl: 安装 uv
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*
# uvx：Market 目录中 pypi 条目运行时需要（uv 官方静态安装）
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
 && install -m 0755 /root/.local/bin/uv /usr/local/bin/uv \
 && install -m 0755 /root/.local/bin/uvx /usr/local/bin/uvx

ENV NODE_ENV=production \
    OPSGATE_DATA_DIR=/data \
    OPSGATE_PORT=8080 \
    OPSGATE_BIND=0.0.0.0 \
    OPSGATE_LOG_LEVEL=info

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/docker-entrypoint.sh"]
