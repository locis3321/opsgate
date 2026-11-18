/**
 * MCP 路由（GET/POST/DELETE /mcp）+ 管理端预览（GET /mcp/preview）。
 * 访问模式：/mcp 三方法 = api-key（T3 起，AC-7）；preview = session。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { McpEndpoint } from '../services/mcpEndpoint.js';
import type { RouteDefinition } from './registry.js';

export function makeMcpRoutes(endpoint: McpEndpoint): RouteDefinition[] {
  return [
    {
      method: 'GET',
      url: '/mcp',
      accessMode: 'api-key',
      handler: (req: FastifyRequest, reply: FastifyReply) => endpoint.handle(req, reply),
    },
    {
      method: 'POST',
      url: '/mcp',
      accessMode: 'api-key',
      handler: (req: FastifyRequest, reply: FastifyReply) => endpoint.handle(req, reply),
    },
    {
      method: 'DELETE',
      url: '/mcp',
      accessMode: 'api-key',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const group = (req.query as { group?: string }).group ?? 'all';
        await endpoint.closeSession(p.userId, group);
        // DELETE 终止会话：交给 transport 处理（若无会话则直接 200）
        return endpoint
          .handle(req, reply)
          .then((r) => r)
          .catch(() => reply.code(200).send({ code: 0, data: null, message: 'session closed' }));
      },
    },
    {
      method: 'GET',
      url: '/mcp/preview',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const q = req.query as { group?: string; category?: string; tag?: string };
        const group = q.group ?? 'all';
        const preview = await endpoint.preview({
          group,
          category: q.category,
          tag: (req.query as { tag?: string }).tag,
          principal: p,
        });
        return reply.send({ code: 0, data: preview, message: 'ok' });
      },
    },
  ];
}
