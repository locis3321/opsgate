/**
 * default-deny（R-1）+ better-auth + API Key 集成测试（T3 验收）。
 * 真实 Fastify 实例 + :memory: SQLite + better-auth；app.inject() 驱动。
 */
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { makeAuthHandler } from './routes/auth-handler.js';
import * as schema from './db/schema.js';
import { createAuth, createUserWithPassword, ensureAuthTables, type Auth } from './services/auth.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

interface Ctx {
  app: FastifyInstance;
  auth: Auth;
  sqlite: Database.Database;
}

let ctx: Ctx;

beforeEach(async () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  const app = await buildApp({ db, auth, baseUrl: BASE_URL });
  ctx = { app, auth, sqlite };
});

afterEach(async () => {
  await ctx.app.close();
  ctx.sqlite.close();
});

async function login(username: string, password: string): Promise<string | null> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in/username',
    payload: { username, password },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  if (res.statusCode !== 200) return null;
  const cookies = res.headers['set-cookie'];
  const sc = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  return sc[0]?.split(';')[0] ?? null;
}

describe('default-deny（R-1，AC-2/3/7）', () => {
  it('未注册路径返回 403（非 404）', async () => {
    for (const url of ['/api/v1/nonexistent', '/random', '/api/v1/secret/debug']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(403);
    }
  });

  it('public 白名单：/healthz 200', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('ok');
  });

  it('AC-7 无 Bearer key 请求 /mcp 返回 401（无默认放行分支）', async () => {
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const res = await ctx.app.inject({ method, url: '/mcp' });
      expect(res.statusCode).toBe(401);
    }
  });

  it('未知 Bearer key → 401', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: 'Bearer ogk_live_unknown' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('better-auth 会话（本地账号 username+password）', () => {
  it('管理员登录 → 会话 cookie → get-session 解析 userId/isAdmin', async () => {
    await createUserWithPassword(ctx.auth, {
      username: 'admin',
      password: 'password-12345',
      isAdmin: true,
    });
    const cookie = await login('admin', 'password-12345');
    expect(cookie).toBeTruthy();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/get-session',
      headers: { cookie: cookie!, origin: BASE_URL },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.username).toBe('admin');
    expect(body.user.isAdmin).toBe(true);
  });

  it('密码错误 → 登录失败（401）', async () => {
    await createUserWithPassword(ctx.auth, {
      username: 'admin',
      password: 'password-12345',
      isAdmin: true,
    });
    expect(await login('admin', 'wrong-password')).toBeNull();
  });
});

/**
 * CSRF 同源校验（回归）：可信来源必须含**请求自身 Host** 派生的 origin。
 * 旧实现只信任 baseUrl（由 bind 地址推导，容器内为 0.0.0.0），而浏览器发送的 Origin
 * 是用户实际访问的地址（localhost / 局域网 IP / 域名）→ 带 cookie 的 better-auth
 * 请求（登录、退出）被判为跨站 → 403 INVALID_ORIGIN。
 *
 * 注：better-auth 默认在测试环境跳过 origin 校验（NODE_ENV=test → skipOriginCheck），
 * 本项目通过 `advanced.disableOriginCheck=false` 强制其始终生效，使本组用例能覆盖
 * "跨站被拒"，且生产与测试行为一致；断言用真实监听 + fetch 驱动（app.inject 不经过
 * cookie/origin 中间件）。
 */
describe('CSRF 同源校验（trustedOrigins 含请求 Host）', () => {
  it('同源 Origin（= 请求 Host）→ 放行；跨站 Origin → 仍 403 INVALID_ORIGIN', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
    await ensureAuthTables(auth);
    await createUserWithPassword(auth, { username: 'admin', password: 'password-12345', isAdmin: true });
    const app = await buildApp({ db, auth, baseUrl: BASE_URL });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    // 登录（无 cookie → 不触发 origin 校验）
    const signin = await fetch(`${base}/api/v1/auth/sign-in/username`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: 'password-12345' }),
    });
    expect(signin.status).toBe(200);
    const cookie = signin.headers.get('set-cookie')!.split(';')[0]!;

    // 同源 → 放行
    const same = await fetch(`${base}/api/v1/auth/sign-out`, {
      method: 'POST',
      headers: { cookie, origin: base },
    });
    expect(same.status).toBe(200);

    // 重新登录（sign-out 已销毁会话），验证跨站仍被拒
    const signin2 = await fetch(`${base}/api/v1/auth/sign-in/username`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: 'password-12345' }),
    });
    const cookie2 = signin2.headers.get('set-cookie')!.split(';')[0]!;
    const cross = await fetch(`${base}/api/v1/auth/sign-out`, {
      method: 'POST',
      headers: { cookie: cookie2, origin: 'http://evil.example' },
    });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { code?: string }).code).toBe('INVALID_ORIGIN');

    await app.close();
    sqlite.close();
  });
});

describe('API Key（§4.4：签发一次/哈希存储/吊销/归属）', () => {
  it('管理员创建 key → 明文一次可见 → /mcp 带 key 放行 → 吊销后 401', async () => {
    await createUserWithPassword(ctx.auth, {
      username: 'admin',
      password: 'password-12345',
      isAdmin: true,
    });
    const cookie = (await login('admin', 'password-12345'))!;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      payload: { name: 'ops-agent', clientName: 'claude-desktop' },
      headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
    });
    expect(created.statusCode).toBe(200);
    const { plainKey, id } = created.json().data;
    expect(plainKey).toMatch(/^ogk_live_/);

    // 带 key 请求 /mcp → 不是 401 而是 501（default-deny 已放行）
    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${plainKey}` },
    });
    expect(ok.statusCode).toBe(501);

    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/api-keys/${id}/revoke`,
      headers: { cookie, origin: BASE_URL },
    });
    expect(revoked.statusCode).toBe(200);
    const after = await ctx.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${plainKey}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('审计归属映射：verifyApiKey 返回 userId（key 所属人）', async () => {
    await createUserWithPassword(ctx.auth, {
      username: 'admin',
      password: 'password-12345',
      isAdmin: true,
    });
    const cookie = (await login('admin', 'password-12345'))!;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      payload: { name: 'agent-1' },
      headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
    });
    const { plainKey } = created.json().data;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${plainKey}` },
    });
    // 已通过默认拒绝层 → 501，说明 principal 已解析（归属服务在 apiKey.verify 覆盖）
    expect(res.statusCode).toBe(501);
  });
});

describe('admin-only 用户管理（无角色矩阵）', () => {
  it('非管理员访问 /api/v1/users → 403；管理员可建号', async () => {
    await createUserWithPassword(ctx.auth, {
      username: 'admin',
      password: 'password-12345',
      isAdmin: true,
    });
    await createUserWithPassword(ctx.auth, {
      username: 'alice',
      password: 'password-12345',
      isAdmin: false,
    });
    const adminCookie = (await login('admin', 'password-12345'))!;
    const aliceCookie = (await login('alice', 'password-12345'))!;

    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: aliceCookie, origin: BASE_URL },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: adminCookie, origin: BASE_URL },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toHaveLength(2);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: { username: 'bob', password: 'password-12345' },
      headers: { cookie: adminCookie, origin: BASE_URL, 'content-type': 'application/json' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.isAdmin).toBe(false);
  });

  it('管理员可切换成员为管理员（PATCH users/:id）', async () => {
    await createUserWithPassword(ctx.auth, {
      username: 'admin',
      password: 'password-12345',
      isAdmin: true,
    });
    const { user } = await createUserWithPassword(ctx.auth, {
      username: 'alice',
      password: 'password-12345',
      isAdmin: false,
    });
    const cookie = (await login('admin', 'password-12345'))!;
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${user.id}`,
      payload: { isAdmin: true },
      headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.isAdmin).toBe(true);
  });
});

/**
 * 登录失败语义（回归）：限流(429) 不得被伪装成"用户名或密码不正确"。
 * 旧实现把 better-auth 的所有非 200 登录响应统一改成 401，导致被限流的用户
 * 反复重试却永远看不到"请稍后再试"，误以为密码错误。
 */
describe('登录失败语义（限流透传，§8.5 /login）', () => {
  /** 用假 auth 精确控制 better-auth 的返回状态，隔离限流与凭据两条路径 */
  function fakeAuthApp(status: number, headers: Record<string, string> = {}) {
    const fakeAuth = {
      handler: async () =>
        new Response(JSON.stringify({ message: 'upstream' }), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        }),
    } as unknown as Auth;
    const app = Fastify();
    app.post('/api/v1/auth/sign-in/username', makeAuthHandler(fakeAuth));
    return app;
  }

  it('限流 429 → 透传 429 + x-retry-after + 「尝试过于频繁」，不是密码错误', async () => {
    const app = fakeAuthApp(429, { 'x-retry-after': '7' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/username', payload: {} });
    expect(res.statusCode).toBe(429);
    expect(res.headers['x-retry-after']).toBe('7');
    expect(res.json().message).toContain('尝试过于频繁');
    expect(res.json().message).not.toContain('用户名或密码不正确');
    await app.close();
  });

  it('凭据失败 401 → 仍统一为「用户名或密码不正确」（防用户名枚举）', async () => {
    const app = fakeAuthApp(401);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/username', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('用户名或密码不正确');
    await app.close();
  });

  it('密码正确但账号被禁用 → 403 + 明确文案 + 清空会话 cookie（ADR-028 §2.5）', async () => {
    const fakeAuth = {
      handler: async () =>
        new Response(JSON.stringify({ token: 'x' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': 'better-auth.session_token=abc; Path=/' },
        }),
    } as unknown as Auth;
    const app = Fastify();
    app.post('/api/v1/auth/sign-in/username', makeAuthHandler(fakeAuth, async (u) => u === 'disableduser'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/username',
      payload: { username: 'disableduser', password: 'correct-password' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('账号已被禁用');
    // 必须清掉刚下发的会话 cookie，不留半登录态
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    await app.close();
  });

  it('密码错误时即使账号被禁用 → 仍返回 401（不泄露禁用状态）', async () => {
    // better-auth 在密码错误时返回 401，早于禁用判定
    const app = fakeAuthApp(401);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/username',
      payload: { username: 'disableduser', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('用户名或密码不正确');
    await app.close();
  });

  it('客户端 IP 透传给 better-auth（限流按来源 IP 分桶），并覆盖客户端自带的 x-forwarded-for', async () => {
    const orig = ctx.auth.handler.bind(ctx.auth);
    let seen: string | null = null;
    (ctx.auth as unknown as { handler: unknown }).handler = async (r: Request) => {
      seen = r.headers.get('x-forwarded-for');
      return orig(r);
    };
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/username',
      payload: { username: 'admin', password: 'wrong' },
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect(seen).toBeTruthy();
    expect(seen).not.toBe('9.9.9.9');
  });
});
