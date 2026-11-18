/**
 * 前端静态资源（§8/T9）：hash router（SPA 页面在客户端路由，服务器只需 index + assets）。
 * default-deny 白名单显式两条：GET /（index.html）与 GET /assets/*（构建产物），无其他通配。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RouteDefinition } from './registry.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function makeStaticRoutes(distDir: string): RouteDefinition[] {
  const send = (rel: string, reply: FastifyReply, req: FastifyRequest) => {
    const file = path.join(distDir, rel);
    if (!existsSync(file)) return reply.code(404).send({ code: 404, data: null, message: 'Not Found' });
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    void req;
    reply.header('content-type', type);
    // index.html 不缓存（用户立即拿到新入口；哈希资源仍可长缓存——修复 SPA 改版后要靠强刷的痛点）。
    // 用 no-store 而非 no-cache：no-cache 仍允许启发式缓存生效，实测会出现"改了前端但页面还是旧的"。
    if (rel === 'index.html') reply.header('cache-control', 'no-store, must-revalidate');
    return reply.send(readFileSync(file));
  };
  return [
    {
      method: 'GET',
      url: '/',
      accessMode: 'public',
      handler: (_req: FastifyRequest, reply: FastifyReply) => send('index.html', reply, _req),
    },
    {
      method: 'GET',
      url: '/assets/*',
      accessMode: 'public',
      handler: (req: FastifyRequest, reply: FastifyReply) => {
        const rel = (req.params as { '*': string })['*'];
        return send(`assets/${rel}`, reply, req);
      },
    },
  ];
}
