/**
 * 用户管理端点（admin）：管理员建号 / 列表 / 切换两态身份。
 * 推导来源：Spec §8.5 /users 页（账号/身份两态）+ T3「无注册开放入口，管理员建号」。
 * 无自助注册端点（better-auth disableSignUp），无角色矩阵。
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import type { Auth } from '../services/auth.js';
import { createUserWithPassword, resetUserPassword } from '../services/auth.js';
import type { AuditService } from '../services/audit.js';
import { governanceAudit } from './assets.js';
import type { RouteDefinition } from './registry.js';

const USERNAME_RE = /^[a-z0-9_]{3,32}$/; // 与 better-auth username 归一化一致（仅小写字母/数字/下划线）

export function makeUserRoutes(
  db: BetterSQLite3Database<typeof schema>,
  auth: Auth,
  audit?: AuditService,
): RouteDefinition[] {
  return [
    {
      method: 'GET',
      url: '/api/v1/users',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const rows = await db
          .select({
            id: schema.users.id,
            username: schema.users.username,
            name: schema.users.name,
            isAdmin: schema.users.isAdmin,
            isDisabled: schema.users.isDisabled,
            createdAt: schema.users.createdAt,
          })
          .from(schema.users);
        return reply.send({ code: 0, data: rows, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/users',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const body = (req.body ?? {}) as {
          username?: string;
          password?: string;
          name?: string;
          isAdmin?: boolean;
        };
        if (!body.username || !USERNAME_RE.test(body.username)) {
          return reply.code(400).send({ code: 400, data: null, message: 'username 需为 3-32 位小写字母/数字/下划线' });
        }
        if (!body.password || body.password.length < 10) {
          return reply.code(400).send({ code: 400, data: null, message: 'password 至少 10 位' });
        }
        if (body.isAdmin === true && !req.principal!.isAdmin) {
          return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        }
        const existing = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, body.username))
          .get();
        if (existing) {
          return reply.code(400).send({ code: 400, data: null, message: 'username 已存在' });
        }
        const created = await createUserWithPassword(auth, {
          username: body.username,
          password: body.password,
          name: body.name,
          isAdmin: body.isAdmin ?? false,
        });
        return reply.send({ code: 0, data: created.user, message: 'ok' });
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/users/:id',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        // 2026-11-18 用户决策：管理员**只重置密码**，不改成员的用户名（用户名是身份标识，
        // 改了会让审计里的历史归属对不上；需要换标识应当新建账号）。
        const body = (req.body ?? {}) as { isAdmin?: boolean; isDisabled?: boolean; password?: string };
        if (typeof body.isAdmin !== 'boolean' && typeof body.isDisabled !== 'boolean' && body.password === undefined) {
          return reply.code(400).send({ code: 400, data: null, message: 'isAdmin / isDisabled / password 至少一项' });
        }
        const target = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
        if (!target) {
          return reply.code(404).send({ code: 404, data: null, message: '用户不存在' });
        }
        // 防止管理员把自己禁用/降级导致系统无管理员可登录
        if (id === req.principal!.userId) {
          if (body.isDisabled === true) {
            return reply.code(400).send({ code: 400, data: null, message: '不能禁用自己' });
          }
          if (body.isAdmin === false) {
            return reply.code(400).send({ code: 400, data: null, message: '不能取消自己的管理员身份' });
          }
        }
        if (body.password !== undefined) {
          if (body.password.length < 10) {
            return reply.code(400).send({ code: 400, data: null, message: 'password 至少 10 位' });
          }
          const ok = await resetUserPassword(auth, id, body.password);
          if (!ok) {
            return reply.code(400).send({ code: 400, data: null, message: '该用户没有本地密码账号，无法重置密码' });
          }
          if (audit) {
            // 只记"谁重置了谁的密码"，绝不记录密码本身或任何派生值
            await governanceAudit(audit, req.principal!, 'user_password_reset', {
              userId: id,
              username: target.username,
              sessionsRevoked: true,
            });
          }
        }
        const patch: Record<string, unknown> = {};
        if (typeof body.isAdmin === 'boolean') patch.isAdmin = body.isAdmin;
        // ADR-028 §2.5：禁用只阻断 Web UI 登录，不阻断 MCP 调用
        if (typeof body.isDisabled === 'boolean') patch.isDisabled = body.isDisabled;
        if (Object.keys(patch).length > 0) {
          await db.update(schema.users).set(patch as never).where(eq(schema.users.id, id)).run();
        }
        return reply.send({
          code: 0,
          data: {
            id,
            isAdmin: body.isAdmin ?? target.isAdmin,
            isDisabled: body.isDisabled ?? target.isDisabled,
            passwordReset: body.password !== undefined,
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/users/:id',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        if (id === req.principal!.userId) {
          return reply.code(400).send({ code: 400, data: null, message: '不能删除自己' });
        }
        const target = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
        if (!target) return reply.code(404).send({ code: 404, data: null, message: '用户不存在' });

        // ADR-028 §2.5：凭证/资产**保留**，owner_id 置空等 admin 重新分配；
        // 删除用户的 personal 绑定（成员已不存在，绑定无意义）；
        // 撤销其 API Key（成员离职后不应继续持有 MCP 访问能力）。
        const ownedCreds = await db.select({ id: schema.credentials.id }).from(schema.credentials).where(eq(schema.credentials.ownerId, id)).all();
        const ownedServers = await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.ownerId, id)).all();
        await db.update(schema.credentials).set({ ownerId: null }).where(eq(schema.credentials.ownerId, id)).run();
        await db.update(schema.servers).set({ ownerId: null }).where(eq(schema.servers.ownerId, id)).run();
        await db.delete(schema.serverCredentials).where(eq(schema.serverCredentials.userId, id)).run();
        // 分组关系与个人绑定一并清理
        await db.delete(schema.groupUsers).where(eq(schema.groupUsers.userId, id)).run();
        await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.userId, id)).run();
        // better-auth 的 session/account 记录随用户删除清理（否则登录态残留）
        await db.delete(schema.users).where(eq(schema.users.id, id)).run();

        if (audit) {
          await governanceAudit(audit, req.principal!, 'user_delete', {
            userId: id,
            username: target.username,
            orphanedCredentials: ownedCreds.length,
            orphanedServers: ownedServers.length,
          });
        }
        return reply.send({
          code: 0,
          data: { id, orphanedCredentials: ownedCreds.length, orphanedServers: ownedServers.length },
          message: 'ok',
        });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/admin/reassign-owner',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        // 成员删除后产生的无主资源（owner_id = NULL）由 admin 重新指派
        const body = (req.body ?? {}) as { credentialId?: string; serverId?: string; newOwnerId?: string };
        if (!body.newOwnerId) {
          return reply.code(400).send({ code: 400, data: null, message: 'newOwnerId 必填' });
        }
        if (!body.credentialId && !body.serverId) {
          return reply.code(400).send({ code: 400, data: null, message: 'credentialId 或 serverId 至少一项' });
        }
        const newOwner = await db.select().from(schema.users).where(eq(schema.users.id, body.newOwnerId)).get();
        if (!newOwner) return reply.code(404).send({ code: 404, data: null, message: '目标用户不存在' });

        const done: Array<{ kind: string; id: string }> = [];
        if (body.credentialId) {
          const c = await db.select().from(schema.credentials).where(eq(schema.credentials.id, body.credentialId)).get();
          if (!c) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
          await db.update(schema.credentials).set({ ownerId: body.newOwnerId }).where(eq(schema.credentials.id, body.credentialId)).run();
          done.push({ kind: 'credential', id: body.credentialId });
        }
        if (body.serverId) {
          const s = await db.select().from(schema.servers).where(eq(schema.servers.id, body.serverId)).get();
          if (!s) return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
          await db.update(schema.servers).set({ ownerId: body.newOwnerId }).where(eq(schema.servers.id, body.serverId)).run();
          done.push({ kind: 'server', id: body.serverId });
        }
        if (audit) {
          await governanceAudit(audit, req.principal!, 'owner_reassign', { newOwnerId: body.newOwnerId, items: done });
        }
        return reply.send({ code: 0, data: { reassigned: done }, message: 'ok' });
      },
    },
  ];
}
