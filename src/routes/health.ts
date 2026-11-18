/**
 * 健康检查（public 白名单路由，default-deny 断言清单内）。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export function healthzHandler(_req: FastifyRequest, reply: FastifyReply) {
  return reply.send({ code: 0, data: { status: 'ok' }, message: 'ok' });
}
