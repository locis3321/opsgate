/**
 * 运行时端点（Spec §7）：实例池状态（T6）/ SSH 连接池与暂存区摘要（T8 补齐）/ Prometheus 指标。
 * 2026-11-18 T4：实例列表补资产名与主进程资源快照，并支持按 entryKey 强制关闭实例。
 */
import { eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import type { InstancePool } from '../services/instancePool.js';
import type { SshConnector } from '../native/connectors/ssh.js';
import type { TransferService } from '../services/transfer.js';
import { sampleProcesses } from '../services/processSampler.js';
import type { AuditService } from '../services/audit.js';
import type { RouteDefinition } from './registry.js';

export interface RuntimeRouteDeps {
  pool?: InstancePool;
  ssh?: SshConnector;
  transfer?: TransferService;
  db?: BetterSQLite3Database<typeof schema>;
  audit?: AuditService;
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
      url: '/api/v1/runtime/metrics',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const stats = deps.pool?.stats();
        const mem = process.memoryUsage();
        const ssh = deps.ssh?.stats();
        const staging = deps.transfer?.stagingStats();
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
          '',
        ];
        return reply.type('text/plain; version=0.0.4').send(lines.join('\n'));
      },
    },
  ];
}
