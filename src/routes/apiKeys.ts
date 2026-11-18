/**
 * API Key 管理端点（§7 /api-keys，T3）：session 主体；
 * 明文只在 POST 签发时返回一次，此后仅掩码/元信息。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import { createApiKey, deleteRevokedApiKey, listApiKeys, revokeApiKey } from '../services/apiKey.js';
import type { RouteDefinition } from './registry.js';

export function makeApiKeyRoutes(
  db: BetterSQLite3Database<typeof schema>,
): RouteDefinition[] {
  return [
    {
      method: 'GET',
      url: '/api/v1/api-keys',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const rows = await listApiKeys(db, p.userId, p.isAdmin);
        return reply.send({ code: 0, data: rows, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/api-keys',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const body = (req.body ?? {}) as { name?: string; clientName?: string };
        if (!body.name || String(body.name).length > 64) {
          return reply.code(400).send({ code: 400, data: null, message: 'name 必填且 ≤64 字符' });
        }
        const { plainKey, info } = await createApiKey(db, p.userId, body.name, body.clientName);
        return reply.send({
          code: 0,
          data: { ...info, plainKey },
          message: 'ok',
        });
      },
    },
    {
      /**
       * 吊销（2026-11-18 T6）：保留行，标记 revoked_at。
       * 语义从"DELETE 即吊销"拆开——吊销可追溯，删除是清理已作废的行。
       */
      method: 'POST',
      url: '/api/v1/api-keys/:id/revoke',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const { id } = req.params as { id: string };
        const target = await db
          .select({ userId: schema.apiKeys.userId })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.id, id))
          .get();
        if (!target) {
          return reply.code(404).send({ code: 404, data: null, message: 'API Key 不存在' });
        }
        if (target.userId !== p.userId && !p.isAdmin) {
          return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        }
        const changed = await revokeApiKey(db, id);
        return reply.send({ code: 0, data: { revoked: changed }, message: 'ok' });
      },
    },
    {
      /**
       * 删除（2026-11-18 T6）：只能删**已吊销**的 Key。
       * 有效 Key 必须先吊销——否则审计里的 api_key_id 会指向不存在的行。
       */
      method: 'DELETE',
      url: '/api/v1/api-keys/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const { id } = req.params as { id: string };
        const target = await db
          .select({ userId: schema.apiKeys.userId, revokedAt: schema.apiKeys.revokedAt })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.id, id))
          .get();
        if (!target) {
          return reply.code(404).send({ code: 404, data: null, message: 'API Key 不存在' });
        }
        if (target.userId !== p.userId && !p.isAdmin) {
          return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        }
        if (!target.revokedAt) {
          return reply.code(400).send({ code: 400, data: null, message: '只能删除已吊销的 API Key，请先吊销' });
        }
        const deleted = await deleteRevokedApiKey(db, id);
        return reply.send({ code: 0, data: { deleted }, message: 'ok' });
      },
    },
  ];
}
