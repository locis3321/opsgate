#!/bin/sh
# 容器入口（幂等）：
# 1) seed = 迁移 + 默认分组(host/mysql/k8s) + 内置 guard_rules（ADR-015 / §4.7 安全基线）
# 2) server = 业务进程（首启管理员由 OPSGATE_ADMIN_INIT 处理；审计归档作业随服务启动）
set -e
node dist/db/seed.js
exec node dist/server.js
