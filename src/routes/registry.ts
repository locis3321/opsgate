/**
 * default-deny 路由注册表（R-1 / ADR-011，Spec §6 约束 1）。
 * 四层防线：
 *  1. TS 编译期：accessMode 必填（不声明编不过；registry.typecheck.ts 用 @ts-expect-error 断言）
 *  2. 启动期断言：public 路由必须命中 PUBLIC_ROUTE_WHITELIST，否则抛错（进程启动失败）
 *  3. 运行期根级 preHandler：authorizeRequest 对每个请求执行；未注册路径 → 403（非 404）
 *  4. 403 ≠ 404：不泄露路径存在性
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** authorizeRequest 放行后填充（session / api-key / transfer-token 主体） */
    principal?: Principal;
  }
}

export type AccessMode = 'public' | 'session' | 'admin' | 'api-key' | 'transfer-token';
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT' | 'ALL';

export interface Principal {
  userId: string;
  isAdmin: boolean;
  /** API Key / transfer-token 主体时填充 */
  apiKeyId?: string;
  clientName?: string;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** 支持 :param 段与尾部 * 通配（如 /api/v1/auth/*） */
  url: string;
  /** 必填：不声明编译不过（R-1 第一层） */
  accessMode: AccessMode;
  handler: (req: FastifyRequest, reply: FastifyReply) => unknown;
}

/** 暴露给 handler 的会话/主体验证器（server.ts 装配） */
export interface AuthorizeContext {
  getSessionUser(headers: Record<string, string | string[] | undefined>): Promise<Principal | null>;
  verifyApiKey(token: string): Promise<Principal | null>;
  verifyTransferToken(token: string, pathname: string, method: string): Promise<Principal | null>;
}

/**
 * 硬编码 public 白名单（Spec §6 约束 1 类比）。
 * 注意：Spec §7 列 `/auth/login`、§6 白名单列 `/api/v1/auth/login`——按 §6 + §7「统一前缀 /api/v1」落地；
 * better-auth 的登录路径为 /sign-in/username（username 插件），故白名单为实际注册的 public 路径（决策记录 T3）。
 */
export const PUBLIC_ROUTE_WHITELIST = [
  'POST /api/v1/auth/sign-in/username',
  'GET /healthz',
  'GET /',
  'GET /assets/*',
] as const;

export function assertPublicWhitelist(defs: readonly RouteDefinition[]): void {
  const publics = defs
    .filter((d) => d.accessMode === 'public')
    .map((d) => `${d.method} ${d.url}`);
  for (const p of publics) {
    if (!(PUBLIC_ROUTE_WHITELIST as readonly string[]).includes(p)) {
      throw new Error(`default-deny: 白名单外的 public 路由: ${p}`);
    }
  }
}

interface MatchResult {
  def: RouteDefinition;
  params: Record<string, string>;
}

/** 匹配：精确 > 模式（:param / 尾部 *）。query 不参与匹配（按 pathname）。 */
export function matchRoute(
  method: string,
  pathname: string,
  defs: readonly RouteDefinition[],
): MatchResult | undefined {
  const m = method.toUpperCase();
  const url = pathname.split('?')[0] ?? '';
  for (const d of defs) {
    if (d.method !== 'ALL' && d.method !== m) continue;
    if (d.url === url) return { def: d, params: {} };
  }
  let best: (MatchResult & { score: number }) | undefined;
  for (const d of defs) {
    if (d.method !== 'ALL' && d.method !== m) continue;
    const params = matchPattern(d.url, url);
    if (!params) continue;
    const score = patternScore(d.url);
    if (!best || score > best.score) best = { def: d, params, score };
  }
  return best ? { def: best.def, params: best.params } : undefined;
}

function matchPattern(pattern: string, url: string): Record<string, string> | undefined {
  const pSegs = pattern.split('/').filter(Boolean);
  const uSegs = url.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i]!;
    if (p === '*') return params; // 尾部通配：任意剩余段
    const u = uSegs[i];
    if (u === undefined) return undefined;
    if (p.startsWith(':')) params[p.slice(1)] = u;
    else if (p !== u) return undefined;
  }
  return pSegs.length === uSegs.length ? params : undefined;
}

function patternScore(pattern: string): number {
  let score = 0;
  for (const seg of pattern.split('/').filter(Boolean)) {
    if (seg === '*') score -= 1000;
    else if (seg.startsWith(':')) score += 10;
    else score += 100;
  }
  return score;
}

/** bearer token 解析（api-key / transfer-token 共用） */
export function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

/**
 * 运行期根级授权（R-1 第三层）：由 server.ts 挂在 preHandler。
 * 未注册路径 → 403；session 无会话 → 401；api-key 无/无效 token → 401；
 * admin 非管理员 → 403；transfer-token（T5 实现校验）无效 → 401。
 * 返回 true 表示放行（req.principal 已填充），false 表示已回复。
 */
export async function authorizeRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  defs: readonly RouteDefinition[],
  ctx: AuthorizeContext,
): Promise<boolean> {
  const url = (req.url ?? '').split('?')[0] ?? '';
  const hit = matchRoute(req.method, url, defs);
  if (!hit) {
    void reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
    return false;
  }
  const mode = hit.def.accessMode;
  if (mode === 'public') return true;

  const headers = req.headers as Record<string, string | string[] | undefined>;
  if (mode === 'session' || mode === 'admin') {
    const principal = await ctx.getSessionUser(headers);
    if (!principal) {
      void reply.code(401).send({ code: 401, data: null, message: 'Unauthorized' });
      return false;
    }
    if (mode === 'admin' && !principal.isAdmin) {
      void reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
      return false;
    }
    (req as FastifyRequest & { principal?: Principal }).principal = principal;
    return true;
  }
  if (mode === 'api-key') {
    const token = bearerOf(req);
    if (!token) {
      void reply.code(401).send({ code: 401, data: null, message: 'Missing bearer key' });
      return false;
    }
    const principal = await ctx.verifyApiKey(token);
    if (!principal) {
      void reply.code(401).send({ code: 401, data: null, message: 'Invalid bearer key' });
      return false;
    }
    (req as FastifyRequest & { principal?: Principal }).principal = principal;
    return true;
  }
  // transfer-token（T5 实现具体校验）
  const token = bearerOf(req);
  const principal = token ? await ctx.verifyTransferToken(token, url, req.method) : null;
  if (!principal) {
    void reply.code(401).send({ code: 401, data: null, message: 'Invalid transfer token' });
    return false;
  }
  (req as FastifyRequest & { principal?: Principal }).principal = principal;
  return true;
}
