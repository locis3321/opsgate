/**
 * 运行时端点（Spec §7）：实例池状态（T6）/ SSH 连接池与暂存区摘要（T8 补齐）/ Prometheus 指标。
 * 2026-11-18 T4：实例列表补资产名与主进程资源快照，并支持按 entryKey 强制关闭实例。
 * 2026-11-21 Task 9：新增 CLI 在飞进程观测（/runtime/cli）与关闭、CLI 执行计数指标。
 */
import { eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import type { InstancePool } from '../services/instancePool.js';
import type { SshConnector } from '../native/connectors/ssh.js';
import type { RedisConnector } from '../native/connectors/redis.js';
import type { KafkaConnector } from '../native/connectors/kafka.js';
import type { TransferService } from '../services/transfer.js';
import { sampleProcesses } from '../services/processSampler.js';
import type { AuditService } from '../services/audit.js';
import type { CliRunner, CliHealthStatus } from '../services/cliRunner.js';
import { toCliAssetView } from '../services/mcpEndpoint.js';
import type { RouteDefinition } from './registry.js';

export interface RuntimeRouteDeps {
  pool?: InstancePool;
  ssh?: SshConnector;
  /** 长连接池（ADR-036）：与 HTTP connector 不同，这里有真实连接需要观测与回收 */
  redis?: RedisConnector;
  kafka?: KafkaConnector;
  transfer?: TransferService;
  db?: BetterSQLite3Database<typeof schema>;
  audit?: AuditService;
  /** CLI 一次性执行器（Task 9 装配）；缺省时 /runtime/cli 返回空观测、删除 404 */
  cliRunner?: CliRunner;
}

export function makeRuntimeRoutes(deps: RuntimeRouteDeps): RouteDefinition[] {
  return [
    {
      method: 'GET',
      url: '/api/v1/runtime/instances',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const pool = deps.pool;
        if (!pool) return reply.send({ code: 0, data: { stats: { ready: 0, spawning: 0, failing: 0 }, instances: [] }, message: 'ok' });
        const stats = pool.stats();
        const rows = pool.list();
        // 资产名：pool 不依赖 DB，名称在这里补
        const serverIds = [...new Set(rows.map((r) => r.serverId))];
        const names = new Map<string, string>();
        if (deps.db && serverIds.length > 0) {
          const servers = await deps.db
            .select({ id: schema.servers.id, name: schema.servers.name, displayName: schema.servers.displayName })
            .from(schema.servers)
            .where(inArray(schema.servers.id, serverIds))
            .all();
          for (const s of servers) names.set(s.id, s.displayName || s.name);
        }
        const samples = await sampleProcesses(rows.map((r) => r.pid).filter((p): p is number => p !== null));
        return reply.send({
          code: 0,
          data: {
            stats: { ready: stats.ready, spawning: stats.spawning, failing: stats.failing },
            instances: rows.map((r) => {
              const s = r.pid !== null ? samples.get(r.pid) : undefined;
              return {
                ...r,
                serverName: names.get(r.serverId) ?? null,
                // 采样失败保留 null：前端显示「—」，不伪造 0
                cpuPercent: s?.cpuPercent ?? null,
                rssBytes: s?.rssBytes ?? null,
              };
            }),
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/runtime/instances/:entryKey',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { entryKey } = req.params as { entryKey: string };
        const pool = deps.pool;
        if (!pool) return reply.code(404).send({ code: 404, data: null, message: '实例池未启用' });
        const serverId = pool.assetOfEntry(entryKey);
        if (serverId === null) {
          return reply.code(404).send({ code: 404, data: null, message: '实例不存在或已关闭' });
        }
        const closed = pool.closeByEntryKey(entryKey);
        let assetName = serverId;
        if (deps.db) {
          const row = await deps.db
            .select({ name: schema.servers.name, displayName: schema.servers.displayName })
            .from(schema.servers)
            .where(eq(schema.servers.id, serverId))
            .get();
          if (row) assetName = row.displayName || row.name;
        }
        await deps.audit?.writeIntent({
          principal: req.principal!,
          asset: { id: serverId, name: assetName },
          tool: 'system_setting',
          args: { entryKey },
          risk: 'normal',
          status: 'success',
          action: 'runtime_instance_close',
        });
        return reply.send({ code: 0, data: { closed }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/runtime/cli',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const runner = deps.cliRunner;
        // 未装配执行器：不伪造"有执行器但空"（§2 原则 2）。available 是唯一的装配事实来源——
        // 空 runs/stats/health 与"装配了但零在飞"同形，只靠它们的形状无法区分（与 long-connections 同口径）。
        const available = runner !== undefined;
        const runs = runner?.list() ?? [];
        const stats = runner?.stats() ?? { active: 0, total: 0 };
        // health 覆盖**全部** cli 资产（不只是在飞的）：管理员要看"哪些资产现在跑不起来"，
        // 只报在飞进程等于只在出事时才有信号。
        let health: Array<{ assetId: string; name: string; status: CliHealthStatus['status'] }> = [];
        if (runner && deps.db) {
          const rows = await deps.db
            .select()
            .from(schema.servers)
            .where(eq(schema.servers.executionMode, 'cli'))
            .all();
          health = await Promise.all(
            rows.map(async (row) => ({
              assetId: row.id,
              name: row.displayName || row.name,
              status: (await runner.health(toCliAssetView(row))).status,
            })),
          );
        }
        return reply.send({ code: 0, data: { available, runs, stats, health }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/runtime/cli/:runId',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { runId } = req.params as { runId: string };
        const runner = deps.cliRunner;
        if (!runner) return reply.code(404).send({ code: 404, data: null, message: 'CLI 执行器未启用' });
        // 先取在飞登记再 kill：kill 只负责发信号，登记要等进程 close 才移除，
        // 所以此刻的登记仍是该 runId 资产归属的权威来源（审计的 asset 从这里补，不靠猜）。
        const run = runner.list().find((r) => r.runId === runId);
        if (!run) return reply.code(404).send({ code: 404, data: null, message: 'CLI 运行不存在或已结束' });
        const killed = runner.kill(runId);
        if (!killed) return reply.code(404).send({ code: 404, data: null, message: 'CLI 运行不存在或已结束' });
        let assetName = run.assetId;
        if (deps.db) {
          const row = await deps.db
            .select({ name: schema.servers.name, displayName: schema.servers.displayName })
            .from(schema.servers)
            .where(eq(schema.servers.id, run.assetId))
            .get();
          if (row) assetName = row.displayName || row.name;
        }
        await deps.audit?.writeIntent({
          principal: req.principal!,
          asset: { id: run.assetId, name: assetName },
          tool: 'system_setting',
          args: { runId, argvSummary: run.argvSummary },
          risk: 'normal',
          status: 'success',
          action: 'runtime_cli_kill',
        });
        return reply.send({ code: 0, data: { killed }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/runtime/ssh-connections',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const s = deps.ssh?.stats();
        return reply.send({
          code: 0,
          data: {
            active: s?.active ?? 0,
            idle: s?.idle ?? 0,
            total: s?.total ?? 0,
            fingerprintFailures: deps.ssh?.fingerprintFailureCount() ?? 0,
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/runtime/transfer-staging',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const st = deps.transfer?.stagingStats() ?? { entries: 0, files: 0, bytes: 0 };
        return reply.send({ code: 0, data: st, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/runtime/long-connections',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        // Redis/Kafka 是有状态长连接（ADR-036）：stats() 的 active 表示"有调用在用"，
        // idle 表示"连接还开着但没人用"（等 idle TTL 回收）——两者相加才是实际打开的连接数。
        const r = deps.redis?.stats() ?? { active: 0, idle: 0, total: 0 };
        const k = deps.kafka?.stats() ?? { active: 0, idle: 0, total: 0 };
        return reply.send({
          code: 0,
          data: {
            redis: { ...r, available: deps.redis !== undefined },
            kafka: { ...k, available: deps.kafka !== undefined },
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/runtime/metrics',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const stats = deps.pool?.stats();
        const mem = process.memoryUsage();
        const ssh = deps.ssh?.stats();
        const staging = deps.transfer?.stagingStats();
        const redis = deps.redis?.stats();
        const kafka = deps.kafka?.stats();
        const cli = deps.cliRunner?.stats();
        const lines = [
          '# HELP opsgate_instances_ready MCP 实例池 ready 实例数',
          '# TYPE opsgate_instances_ready gauge',
          `opsgate_instances_ready ${stats?.ready ?? 0}`,
          '# TYPE opsgate_instances_spawning gauge',
          `opsgate_instances_spawning ${stats?.spawning ?? 0}`,
          '# TYPE opsgate_instances_failing gauge',
          `opsgate_instances_failing ${stats?.failing ?? 0}`,
          '# TYPE opsgate_process_rss_bytes gauge',
          `opsgate_process_rss_bytes ${mem.rss}`,
          '# TYPE opsgate_process_uptime_seconds gauge',
          `opsgate_process_uptime_seconds ${Math.floor(process.uptime())}`,
          '# TYPE opsgate_ssh_connections_active gauge',
          `opsgate_ssh_connections_active ${ssh?.active ?? 0}`,
          '# TYPE opsgate_ssh_connections_idle gauge',
          `opsgate_ssh_connections_idle ${ssh?.idle ?? 0}`,
          '# TYPE opsgate_ssh_fingerprint_failures_total counter',
          `opsgate_ssh_fingerprint_failures_total ${deps.ssh?.fingerprintFailureCount() ?? 0}`,
          '# TYPE opsgate_transfer_staging_files gauge',
          `opsgate_transfer_staging_files ${staging?.files ?? 0}`,
          '# TYPE opsgate_transfer_staging_bytes gauge',
          `opsgate_transfer_staging_bytes ${staging?.bytes ?? 0}`,
          '# TYPE opsgate_redis_connections_active gauge',
          `opsgate_redis_connections_active ${redis?.active ?? 0}`,
          '# TYPE opsgate_redis_connections_idle gauge',
          `opsgate_redis_connections_idle ${redis?.idle ?? 0}`,
          '# TYPE opsgate_kafka_connections_active gauge',
          `opsgate_kafka_connections_active ${kafka?.active ?? 0}`,
          '# TYPE opsgate_kafka_connections_idle gauge',
          `opsgate_kafka_connections_idle ${kafka?.idle ?? 0}`,
          '# TYPE opsgate_cli_executions_active gauge',
          `opsgate_cli_executions_active ${cli?.active ?? 0}`,
          '# TYPE opsgate_cli_executions_total counter',
          `opsgate_cli_executions_total ${cli?.total ?? 0}`,
          '',
        ];
        return reply.type('text/plain; version=0.0.4').send(lines.join('\n'));
      },
    },
  ];
}
