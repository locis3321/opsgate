/**
 * 认证路由：better-auth handler 挂载（/api/v1/auth/*）。
 * 注册表按路径授权（default-deny）：sign-in/username public；其余 session。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from '../services/auth.js';

export function makeAuthHandler(auth: Auth, isDisabledUser?: (username: string) => Promise<boolean>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const headers = fromNodeHeaders(req.headers as Record<string, string | string[] | undefined>);
    // better-auth 用 x-forwarded-for 解析客户端 IP 作为限流分桶键；该头缺失时（直连部署）
    // 会退化为全局共享桶——任一客户端触发限流即封锁所有用户。这里用 socket 对端地址补齐，
    // 并覆盖客户端自带的同名头，避免伪造 IP 绕过限流。
    if (req.ip) headers.set('x-forwarded-for', req.ip);

    // ADR-028 §2.5：禁用成员**在登录前**就明确拒绝。
    // 若等到 sign-in 成功后再拦，前端会「登录成功 → 拉会话为空 → 静默退回登录页」，
    // 用户完全不知道为什么进不去。在 password 校验之后判断可避免泄露"哪些账号存在"。
    const signInName = req.url?.includes('/sign-in/')
      ? (req.body as { username?: string } | undefined)?.username
      : undefined;
    let disabledAfterAuth = false;

    const body = req.body ? JSON.stringify(req.body) : undefined;
    const r = new Request(url.toString(), {
      method: req.method,
      headers,
      body,
    });
    const res = await auth.handler(r);
    if (req.url?.includes('/sign-in/')) {
      // 仅掩盖凭据类失败（400/401），防用户名枚举（§8.5 /login）
      if (res.status === 400 || res.status === 401) {
        return reply.code(401).send({ code: 401, data: null, message: '用户名或密码不正确' });
      }
      // 限流（429）必须透传真实状态：伪装成"密码错误"会让用户反复重试而永远解封不了
      if (res.status === 429) {
        const retryAfter = res.headers.get('x-retry-after') ?? '10';
        return reply.code(429)
          .header('x-retry-after', retryAfter)
          .send({ code: 429, data: null, message: `尝试过于频繁，请 ${retryAfter} 秒后重试` });
      }
      // 到这里密码已经正确；再看账号是否被禁用（此时告知禁用不构成用户名枚举）
      if (res.ok && signInName && isDisabledUser && (await isDisabledUser(signInName))) {
        disabledAfterAuth = true;
      }
    }
    if (disabledAfterAuth) {
      // 立刻作废刚建立的会话，避免留下"能拿 cookie 但进不去"的半登录态
      return reply
        .code(403)
        .header('set-cookie', 'better-auth.session_token=; Path=/; Max-Age=0; HttpOnly')
        .send({ code: 403, data: null, message: '账号已被禁用，无法登录控制台（MCP 调用不受影响）' });
    }
    reply.status(res.status);
    res.headers.forEach((value, key) => reply.header(key, value));
    const text = res.body ? await res.text() : null;
    return reply.send(text ?? undefined);
  };
}
