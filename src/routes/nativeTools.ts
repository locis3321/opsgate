/**
 * 原生工具管理端点（Spec §8.5 `/native-tools` / §5.9.5 启用开关，admin-only）：
 * GET 列表（enabled + 命中次数）；PATCH /:id {enabled} 写配置字典 native_tools.disabled（热生效）。
 * 命中次数 = 当月审计表该工具 tool_call 行数。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from 'better-sqlite3';
import * as schema from '../db/schema.js';
import type { Settings } from '../config/settings.js';
import type { NativeToolDefinition } from '../framework/types.js';
import type { AuditService } from '../services/audit.js';
import { governanceAudit } from './assets.js';
import type { RouteDefinition } from './registry.js';

export interface NativeToolRouteDeps {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database;
  settings: Settings;
  audit: AuditService;
  registry: NativeToolDefinition[];
}

function disabledSet(settings: Settings): Set<string> {
  return new Set<string>(settings.get<readonly string[]>('native_tools.disabled') ?? []);
}

export function makeNativeToolRoutes(deps: NativeToolRouteDeps): RouteDefinition[] {
  const { db, sqlite, settings, audit, registry } = deps;
  const monthTable = () => {
    const d = new Date();
    return `audit_log_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
  };

  return [
    {
      method: 'GET',
      url: '/api/v1/native-tools',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const disabled = disabledSet(settings);
        let hits: Map<string, number> = new Map();
        try {
          const rows = sqlite
            .prepare(`SELECT tool, COUNT(*) c FROM ${monthTable()} WHERE action='tool_call' GROUP BY tool`)
            .all() as Array<{ tool: string; c: number }>;
          hits = new Map(rows.map((r) => [r.tool, r.c]));
        } catch {
          // 当月审计表尚未创建
        }
        const data = registry.map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          connector: t.connector,
          risk: t.risk,
          enabled: !disabled.has(t.id),
          hitCount: hits.get(`native:${t.id}`) ?? 0,
        }));
        return reply.send({ code: 0, data, message: 'ok' });
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/native-tools/:id',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const body = req.body as { enabled?: boolean };
        if (typeof body.enabled !== 'boolean') {
          return reply.code(400).send({ code: 400, data: null, message: 'enabled 必填（boolean）' });
        }
        if (!registry.some((t) => t.id === id)) {
          return reply.code(404).send({ code: 404, data: null, message: '原生工具不存在' });
        }
        const next = new Set(disabledSet(settings));
        if (body.enabled) next.delete(id);
        else next.add(id);
        const value = JSON.stringify([...next]);
        await db
          .insert(schema.systemSettings)
          .values({
            key: 'native_tools.disabled',
            value,
            valueType: 'json',
            category: 'tools',
            defaultValue: '[]',
            isSecret: false,
            requiresRestart: false,
            updatedBy: p.userId,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: schema.systemSettings.key,
            set: { value, updatedBy: p.userId, updatedAt: new Date() },
          })
          .run();
        settings.setCache('native_tools.disabled', [...next]); // 热生效（聚合层逐次读取）
        await governanceAudit(audit, p, 'native_tool_toggle', { toolId: id, enabled: body.enabled });
        return reply.send({ code: 0, data: { id, enabled: body.enabled }, message: 'ok' });
      },
    },
  ];
}
