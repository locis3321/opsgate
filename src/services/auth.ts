/**
 * better-auth 集成（T3）：本地账号 username+password，session cookie。
 * 决策：user model 映射到业务 users 表（modelName + fields + additionalFields.isAdmin），
 * account/session/verification 由 better-auth 按默认 schema 自动创建；
 * 不用 admin 插件（避免引入 role/banned 角色矩阵，project-rules §1）；
 * disableSignUp 关闭自助注册（管理员建号走 createUserWithPassword，内部适配器）。
 */
import type Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import type { BetterAuthOptions } from 'better-auth';
import type { Principal } from '../routes/registry.js';

export interface AuthEnv {
  secret: string;
  baseUrl: string;
}

/**
 * 可信来源（CSRF 同源校验）：配置的 baseUrl + **请求自身的 Host** 派生的同源 origin。
 *
 * 为什么必须含请求 Host：baseUrl 由 bind 地址推导（容器内为 0.0.0.0），而浏览器发送的
 * Origin 是用户实际访问的地址（localhost / 局域网 IP / 域名）。只信任 baseUrl 时，
 * 任何带 cookie 的 better-auth 请求（登录、退出）都会被 origin 校验判为跨站 → 403
 * INVALID_ORIGIN。按请求 Host 派生则：跨站请求的 Origin host 与请求 Host 不同 → 仍被拒；
 * 同源请求必然匹配 → 放行。这与浏览器同源策略同义，不放宽跨站防护。
 */
function trustedOriginsOf(request: Request | undefined, baseUrl: string): string[] {
  const out = [baseUrl];
  const host = request?.headers.get('host');
  if (host) {
    out.push(`http://${host}`);
    out.push(`https://${host}`);
  }
  return out;
}

export function createAuth(sqlite: Database.Database, env: AuthEnv) {
  const options: BetterAuthOptions = {
    database: sqlite,
    secret: env.secret,
    // better-auth 的 basePath = new URL(baseURL).pathname，故 baseURL 带 /api/v1/auth（Spec §7 统一前缀）
    baseURL: `${env.baseUrl}/api/v1/auth`,
    trustedOrigins: (request) => trustedOriginsOf(request, env.baseUrl),
    // origin 校验必须始终生效：better-auth 默认在测试环境（NODE_ENV=test）跳过，
    // 会让"跨站被拒"这一行为无法被回归测试覆盖，也使生产/测试行为不一致。
    advanced: { disableOriginCheck: false },
    user: {
      modelName: 'users',
      fields: {
        name: 'name',
        email: 'email',
        emailVerified: 'email_verified',
        image: 'image',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {
        isAdmin: { type: 'boolean', defaultValue: false, input: false, fieldName: 'is_admin' },
        /** ADR-028 §2.5：禁用只阻断 Web UI 登录（sessionPrincipal 处生效），不影响 MCP */
        isDisabled: { type: 'boolean', defaultValue: false, input: false, fieldName: 'is_disabled' },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
    },
    plugins: [username({ displayUsername: false })],
  };
  return betterAuth(options);
}
export type Auth = ReturnType<typeof createAuth>;

/** 让 better-auth 创建其基础设施表（account/session/verification；已存在的 users 表跳过） */
export async function ensureAuthTables(auth: Auth): Promise<void> {
  const ctx = await auth.$context;
  await ctx.runMigrations();
}

/** 由 session 返回 principal（R-1 授权层使用） */
export async function sessionPrincipal(auth: Auth, headers: Record<string, string | string[] | undefined>): Promise<Principal | null> {
  const session = await auth.api.getSession({
    headers: headers as Record<string, string>,
  });
  if (!session) return null;
  const user = session.user as { id: string; isAdmin?: boolean; isDisabled?: boolean };
  // ADR-028 §2.5：禁用成员不能使用 Web UI。此处是会话的唯一入口，返回 null 等价于"未登录"。
  // MCP 走 verifyApiKey（另一条链路），不受此影响——agent 通道与 Web 登录是两个概念。
  if (user.isDisabled === true) return null;
  return { userId: user.id, isAdmin: user.isAdmin === true };
}

/**
 * 管理员建号：internalAdapter.createUser + password.hash + linkAccount（credential provider）。
 * 与 better-auth admin 插件同构，但不引入 role 字段（无角色矩阵）。
 */
export async function createUserWithPassword(
  auth: Auth,
  input: { username: string; password: string; name?: string; isAdmin?: boolean },
): Promise<{ user: { id: string; username: string; isAdmin: boolean } }> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    {
      name: input.name ?? input.username,
      username: input.username,
      email: '', // 用户名登录，邮箱非业务必填；better-auth 核心字段要求非空字符串
      emailVerified: false,
      image: null,
      isAdmin: input.isAdmin ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { method: 'admin' },
  );
  const hashed = await ctx.password.hash(input.password);
  await ctx.internalAdapter.linkAccount({
    providerId: 'credential',
    accountId: user.id,
    userId: user.id,
    password: hashed,
  });
  return {
    user: { id: user.id, username: input.username, isAdmin: input.isAdmin === true },
  };
}

/** 补管理员字段的 setter（改 isAdmin 用 internalAdapter.updateUser） */
export async function setIsAdmin(auth: Auth, userId: string, isAdmin: boolean): Promise<void> {
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(userId, { isAdmin });
}

/**
 * 管理员重置成员密码（2026-11-18 T5）。
 *
 * better-auth 的 `updatePassword` 期望**已哈希**的口令（管理员插件里也是先 hash 再调），
 * 因此这里自己 hash。重置后清空该用户全部会话——成员若还留着旧登录态，"密码已改"
 * 就是一句空话；这与自助改密（revokeOtherSessions）保持同一语义。
 *
 * 返回 false 表示该用户没有 credential 账号（不是本地密码登录账号），调用方据此报错。
 */
export async function resetUserPassword(auth: Auth, userId: string, password: string): Promise<boolean> {
  const ctx = await auth.$context;
  const account = await ctx.internalAdapter.findCredentialAccount(userId);
  if (!account) return false;
  const hashed = await ctx.password.hash(password);
  await ctx.internalAdapter.updatePassword(userId, hashed);
  await ctx.internalAdapter.deleteUserSessions(userId);
  return true;
}
