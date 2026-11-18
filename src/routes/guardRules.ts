/**
 * guard_rules 管理端点（§4.7 / §5.8）：列表/创建/修改/删除/测试。
 * - locked=1 内置规则：PATCH/DELETE → 403（AC-15；不禁用不改 pattern 底线）
 * - pattern 入库前 ReDoS 校验（safe-regex2 + 嵌套量词/回溯引用人工检查）→ 400（AC-16）
 * - 变更写治理审计（action='guard_rule_change'）
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import safeRe from 'safe-regex2';
import * as schema from '../db/schema.js';
import { loadActiveRules, evaluateRules } from '../services/guardRules.js';
import type { AuditService } from '../services/audit.js';
import type { RouteDefinition } from './registry.js';

const RISKY_RE = /(\([^)]*\*\)|\[[^\]]*\]\*)|\\[1-9]|\([^)]*\)\s*\{|\(\?<|=>/;

export function validatePattern(pattern: string): string | null {
  try {
    new RegExp(pattern);
  } catch {
    return '正则表达式无法编译';
  }
  if (safeRe(pattern) !== true) return '正则存在 ReDoS 风险（嵌套量词/回溯）';
  if (RISKY_RE.test(pattern)) return '正则存在嵌套量词或回溯引用，禁止入库';
  return null;
}

export interface GuardRuleDeps {
  db: BetterSQLite3Database<typeof schema>;
  audit: AuditService;
}

/**
 * 谁能改这条规则（2026-11-18 来源锁定）：
 *  - admin：全部（内置规则也归管理员负责，沿用 2026-11-17 决策）
 *  - owner：只有自己创建的规则
 * 因此"管理员设的策略，owner 无法关闭和修改"由这一处判定统一兜住，列表的 canManage 也用它。
 */
function canManageRule(
  rule: { ownerId?: string | null; source?: string | null },
  principal: { userId: string; isAdmin: boolean },
): boolean {
  if (principal.isAdmin) return true;
  if (rule.source !== 'owner') return false;
  return (rule.ownerId ?? null) === principal.userId;
}

export function makeGuardRuleRoutes(deps: GuardRuleDeps): RouteDefinition[] {
  const { db, audit } = deps;

  const ruleAudit = (principal: { userId: string; isAdmin: boolean }, action: string, args: Record<string, unknown>) =>
    audit.writeIntent({
      principal,
      asset: { id: 'guard_rules', name: 'guard_rules' },
      tool: 'system_setting',
      args,
      risk: 'normal',
      status: 'success',
      action,
    });

  return [
    {
      /**
       * 列表（2026-11-18 三级作用域）：
       *  - admin：全部
       *  - 成员：全局规则 + 作用域覆盖自己资产的规则（asset_type 命中品类 / asset 命中 id）
       *          + 自己创建的规则。每条附带 canManage，前端据此禁用勾选框。
       */
      method: 'GET',
      url: '/api/v1/guard-rules',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const kind = (req.query as { kind?: string }).kind;
        const rows = await db.select().from(schema.guardRules).where(kind ? eq(schema.guardRules.kind, kind) : undefined);
        if (p.isAdmin) {
          return reply.send({ code: 0, data: rows.map((r) => ({ ...r, canManage: true })), message: 'ok' });
        }
        // 成员可见性：自己拥有的资产品类与 id
        const ownAssets = await db
          .select({ id: schema.servers.id, category: schema.servers.category })
          .from(schema.servers)
          .where(eq(schema.servers.ownerId, p.userId));
        const ownIds = new Set(ownAssets.map((a) => a.id));
        const ownCats = new Set(ownAssets.map((a) => a.category));
        const visible = rows.filter((r) => {
          if ((r.ownerId ?? null) === p.userId) return true;
          if (r.scope === 'global') return true;
          const targets = (r.scopeValue ?? []) as string[];
          if (r.scope === 'asset_type') return targets.some((c) => ownCats.has(c));
          return targets.some((id) => ownIds.has(id));
        });
        return reply.send({
          code: 0,
          data: visible.map((r) => ({ ...r, canManage: canManageRule(r, p) })),
          message: 'ok',
        });
      },
    },
    {
      /**
       * 创建（2026-11-18）：admin 可建任意作用域；owner 只能建 `scope=asset` 且目标必须是自己拥有的资产。
       * 来源由创建路径决定（owner→'owner'，admin→'admin'），请求体无法伪造。
       */
      method: 'POST',
      url: '/api/v1/guard-rules',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const body = req.body as {
          name?: string; kind?: 'mark' | 'block'; target?: string; pattern?: string;
          description?: string; priority?: number; scope?: string; scopeValue?: unknown;
        };
        if (!body.name || !body.kind || !body.target || !body.pattern) {
          return reply.code(400).send({ code: 400, data: null, message: 'name/kind/target/pattern 必填' });
        }
        if (body.kind !== 'mark' && body.kind !== 'block') {
          return reply.code(400).send({ code: 400, data: null, message: 'kind 仅 mark|block' });
        }
        if (!['tool', 'arg', 'body', 'asset_type', 'group'].includes(body.target)) {
          return reply.code(400).send({ code: 400, data: null, message: 'target 仅 tool|arg|body|asset_type|group' });
        }
        const bad = validatePattern(body.pattern);
        if (bad) {
          return reply.code(400).send({ code: 400, data: null, message: `pattern 校验失败：${bad}` });
        }
        const scope = (body.scope ?? 'global') as string;
        if (!['global', 'asset_type', 'asset'].includes(scope)) {
          return reply.code(400).send({ code: 400, data: null, message: 'scope 仅 global|asset_type|asset' });
        }
        // 作用域取值校验
        let scopeValue: string[] | null = null;
        if (scope !== 'global') {
          if (!Array.isArray(body.scopeValue) || body.scopeValue.length === 0
            || !body.scopeValue.every((x): x is string => typeof x === 'string' && x.length > 0)) {
            return reply.code(400).send({ code: 400, data: null, message: `scope=${scope} 时 scopeValue 必须是非空字符串数组` });
          }
          scopeValue = body.scopeValue;
        }
        // owner 权限：只能建 asset 级、只能指向自己拥有的资产
        if (!p.isAdmin) {
          if (scope !== 'asset') {
            return reply.code(403).send({ code: 403, data: null, message: '成员只能为自己的资产创建策略（scope 必须是 asset）' });
          }
          const own = await db
            .select({ id: schema.servers.id })
            .from(schema.servers)
            .where(eq(schema.servers.ownerId, p.userId));
          const ownIds = new Set(own.map((s) => s.id));
          const foreign = scopeValue!.filter((id) => !ownIds.has(id));
          if (foreign.length > 0) {
            return reply.code(400).send({
              code: 400, data: null,
              message: `只能为自己拥有的资产建策略，以下资产不属于你：${foreign.join('、')}`,
            });
          }
        }
        const row = await db
          .insert(schema.guardRules)
          .values({
            id: `gr-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
            name: body.name,
            kind: body.kind,
            target: body.target,
            pattern: body.pattern,
            description: body.description ?? '',
            priority: body.priority ?? 0,
            enabled: true,
            locked: false,
            builtin: false,
            hitCount: 0,
            // 来源由创建路径决定，请求体无法伪造（决定 owner 能否改它）
            source: p.isAdmin ? 'admin' : 'owner',
            ownerId: p.userId,
            scope,
            scopeValue,
          })
          .returning({ id: schema.guardRules.id, name: schema.guardRules.name })
          .get();
        await ruleAudit(p, 'guard_rule_change', {
          op: 'create', ruleId: row!.id, name: body.name, kind: body.kind, scope, scopeValue, source: p.isAdmin ? 'admin' : 'owner',
        });
        return reply.send({ code: 0, data: row, message: 'ok' });
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/guard-rules/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const row = await db.select().from(schema.guardRules).where(eq(schema.guardRules.id, id)).get();
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '规则不存在' });
        // 来源锁定（2026-11-18）：owner 不能改/停用管理员与内置规则——管理员设的策略由管理员负责。
        if (!canManageRule(row, p)) {
          return reply.code(403).send({ code: 403, data: null, message: '该策略由管理员设置，你不能修改或关闭' });
        }
        // 2026-11-17 用户决策：内置规则也允许管理员修改/停用。
        // 安全底线的责任归管理员（而不是靠数据库标志位锁死）——锁定会让"误判的正则永远拦着业务"
        // 变成无解问题。改动用 governanceAudit 记录，可追溯谁动了哪条内置规则。
        const body = req.body as { name?: string; pattern?: string; enabled?: boolean; priority?: number; description?: string };
        if (body.pattern !== undefined) {
          const bad = validatePattern(body.pattern);
          if (bad) return reply.code(400).send({ code: 400, data: null, message: `pattern 校验失败：${bad}` });
        }
        await db
          .update(schema.guardRules)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.pattern !== undefined ? { pattern: body.pattern } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.priority !== undefined ? { priority: body.priority } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
          })
          .where(eq(schema.guardRules.id, id))
          .run();
        await ruleAudit(req.principal!, 'guard_rule_change', { op: 'update', ruleId: id, builtin: row.builtin === true, enabled: body.enabled });
        return reply.send({ code: 0, data: { id }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/guard-rules/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const row = await db.select().from(schema.guardRules).where(eq(schema.guardRules.id, id)).get();
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '规则不存在' });
        // 来源锁定：owner 不能删管理员/内置规则
        if (!canManageRule(row, p)) {
          return reply.code(403).send({ code: 403, data: null, message: '该策略由管理员设置，你不能删除' });
        }
        // 同上：内置规则可删，但审计里必须留下"删掉的是哪条内置规则"，便于事后追责与恢复。
        await db.delete(schema.guardRules).where(eq(schema.guardRules.id, id)).run();
        await ruleAudit(p, 'guard_rule_change', {
          op: 'delete', ruleId: id, builtin: row.builtin === true, name: row.name, kind: row.kind, pattern: row.pattern,
        });
        return reply.send({ code: 0, data: { id }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/guard-rules/test',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const body = req.body as { sample?: string; pattern?: string; kind?: string; target?: string };
        const rules = loadActiveRules((deps.db as unknown as { $client: import('better-sqlite3').Database }).$client);
        const hits = evaluateRules(rules, {
          tool: 'native:host.execute_command',
          args: { value: body.sample ?? '' },
          assetType: 'host',
        });
        // pattern 单独试跑（调试正则，不入库）
        let custom: string | null = null;
        if (body.pattern) {
          const bad = validatePattern(body.pattern);
          custom = bad;
          if (!bad) {
            try {
              custom = new RegExp(body.pattern, 'i').test(body.sample ?? '') ? '命中' : '未命中';
            } catch {
              custom = '无法编译';
            }
          }
        }
        return reply.send({ code: 0, data: { hits: hits ? { kind: hits.kind, ruleId: hits.ruleId, ruleName: hits.ruleName } : null, customPattern: custom }, message: 'ok' });
      },
    },
  ];
}
