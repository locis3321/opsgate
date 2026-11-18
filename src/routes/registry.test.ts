/**
 * default-deny 注册表单元测试：匹配优先级 / 白名单断言 / 编译期强制（registry.typecheck.ts）。
 */
import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  assertPublicWhitelist,
  matchRoute,
  type AuthorizeContext,
  type RouteDefinition,
} from './registry.js';

const handler = (async () => undefined) as unknown as RouteDefinition['handler'];

const defs: RouteDefinition[] = [
  { method: 'GET', url: '/healthz', accessMode: 'public', handler },
  { method: 'POST', url: '/api/v1/auth/sign-in/username', accessMode: 'public', handler },
  { method: 'ALL', url: '/api/v1/auth/*', accessMode: 'session', handler },
  { method: 'GET', url: '/api/v1/servers/:id', accessMode: 'session', handler },
  { method: 'GET', url: '/api/v1/servers', accessMode: 'session', handler },
];

describe('matchRoute（精确 > 参数 > 通配）', () => {
  it('精确路径优先于通配', () => {
    const hit = matchRoute('POST', '/api/v1/auth/sign-in/username', defs);
    expect(hit?.def.accessMode).toBe('public');
  });

  it('通配匹配 auth 其余子路径为 session', () => {
    const hit = matchRoute('GET', '/api/v1/auth/get-session', defs);
    expect(hit?.def.accessMode).toBe('session');
  });

  it('参数路径匹配并捕获 params', () => {
    const hit = matchRoute('GET', '/api/v1/servers/abc-123', defs);
    expect(hit?.params.id).toBe('abc-123');
  });

  it('method 不匹配则不命中', () => {
    expect(matchRoute('PATCH', '/healthz', defs)).toBeUndefined();
  });

  it('未注册路径不命中（default-deny）', () => {
    expect(matchRoute('GET', '/api/v1/nonexistent', defs)).toBeUndefined();
  });
});

describe('assertPublicWhitelist（R-1 第二层，AC-2）', () => {
  it('白名单内 public 路由通过', () => {
    expect(() => assertPublicWhitelist(defs)).not.toThrow();
  });

  it('白名单外 public 路由 → 抛错（启动失败）', () => {
    const rogue: RouteDefinition[] = [
      { method: 'GET', url: '/api/v1/secret/debug', accessMode: 'public', handler },
    ];
    expect(() => assertPublicWhitelist(rogue)).toThrowError(/secret\/debug/);
  });
});

describe('authorizeRequest 未注册路径（R-1 第三层，AC-3）', () => {
  it('未注册路径由根级授权返回 403 而非 404', async () => {
    const req = { method: 'GET', url: '/api/v1/nonexistent', headers: {} } as FastifyRequest;
    let sent = false;
    const reply = {
      code(code: number) {
        expect(code).toBe(403);
        return this;
      },
      send(payload: unknown) {
        sent = true;
        expect(payload).toMatchObject({ code: 403 });
        return this;
      },
    } as unknown as FastifyReply;
    const ctx = {
      getSessionUser: async () => null,
      verifyApiKey: async () => null,
      verifyTransferToken: async () => null,
    } satisfies AuthorizeContext;
    const ok = await (
      await import('./registry.js')
    ).authorizeRequest(req, reply, defs, ctx);
    expect(ok).toBe(false);
    expect(sent).toBe(true);
  });
});
