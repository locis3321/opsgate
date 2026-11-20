/**
 * 资产 / 凭证 / 分组管理端点（§7 写入侧，T8）：
 * - assets：列表（can() 过滤 + 分页 50 + category/group/search 筛选）、创建（原生/mcp）、详情、PATCH（可见性放宽 →
 *   槽位凭证同主校验 400 + 治理审计）、DELETE、槽位绑定（.credential.ownerId === asset.ownerId || admin，否则 400 带凭证名）
 * - credentials：列表 = 自己创建的 ∪ 实际在用的（canUseCredentialFor）；创建加密；PATCH/DELETE 仅归属人+admin；轮换 →
 *   updated_at 变 → 绑定资产实例键失效（AC-23）
 * - groups：CRUD + 成员/资产勾选
 * 治理审计 action：visibility_change / group_change / credential_bind / credential_rotate。
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import { canOnAsset, canUseCredentialFor } from '../services/authzBuilder.js';
import { assertOwnCredentialOrAdmin } from '../services/authorize.js';
import { encryptCredential } from '../services/crypto.js';
import { parseRef, CRED_KINDS, CREDENTIAL_TYPES } from '../config/constants.js';
import { DEFAULT_GROUP_BY_CATEGORY } from '../framework/types.js';
import { buildInstanceKey, transportOf } from '../services/instancePlan.js';
import { assertUrlAllowed, SsrfError } from '../services/ssrf.js';
import { validateCredentialValues } from '../services/credentialValidation.js';
import { normalizeTags } from '../services/assetTags.js';
import { makeHandle } from '../native/connectors/http.js';
import { insecureFetch } from '../native/connectors/insecureFetch.js';
import type { AuditService } from '../services/audit.js';
import type { InstancePool } from '../services/instancePool.js';
import type { SshConnector } from '../native/connectors/ssh.js';
import type { CredentialService } from '../services/credentials.js';
import { pickBestBinding, resolveSlotKey } from '../services/credentials.js';
import { buildPlan, makeRefResolver } from '../services/instancePlan.js';
import type { RouteDefinition } from './registry.js';

const DNS1123_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** 连通性测试互斥：同一资产同时只允许一个探测（多标签页/并发请求会争抢实例池） */
const testingAssets = new Map<string, number>();

function claimTesting(assetId: string): boolean {
  const now = Date.now();
  for (const [k, exp] of testingAssets) if (exp <= now) testingAssets.delete(k);
  if (testingAssets.has(assetId)) return false;
  testingAssets.set(assetId, now + 30_000);
  return true;
}

/**
 * 资产删除后清理安全策略里的引用（2026-11-18 三级作用域）。
 *
 * `guard_rules.scope_value` 在 scope=asset 时存的是资产 id 数组；资产没了却留着 id 会变成
 * 永远不命中的僵尸目标，且 owner 无法解释"这条策略指向了什么"。因此删除资产时：
 *  - 从数组里摘掉该 id；
 *  - 数组空了就停用该规则（失去全部目标 = 无意义，停用比删除更可追溯）。
 */
async function pruneGuardRuleScopes(
  db: BetterSQLite3Database<typeof schema>,
  assetId: string,
): Promise<void> {
  const rows = await db.select().from(schema.guardRules).where(eq(schema.guardRules.scope, 'asset'));
  for (const r of rows) {
    const targets = (r.scopeValue ?? []) as string[];
    if (!targets.includes(assetId)) continue;
    const next = targets.filter((x) => x !== assetId);
    await db
      .update(schema.guardRules)
      .set(next.length === 0 ? { scopeValue: null, enabled: false } : { scopeValue: next })
      .where(eq(schema.guardRules.id, r.id))
      .run();
  }
}

/** ref.<凭证名>.<键名> 保存校验：引用存在 + 必须是本人创建的凭证（ADR-028）；返回错误消息或 null（fail-closed） */
async function validateRefs(
  db: BetterSQLite3Database<typeof schema>,
  principal: { userId: string; isAdmin: boolean },
  payload: { env?: unknown; args?: unknown; headers?: unknown },
): Promise<string | null> {
  const refs: Array<{ name: string; key: string }> = [];
  for (const v of Object.values((payload.env ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') { const r = parseRef(v); if (r) refs.push(r); }
  }
  for (const a of (payload.args ?? []) as unknown[]) {
    if (typeof a === 'string') { const r = parseRef(a); if (r) refs.push(r); }
  }
  for (const v of Object.values((payload.headers ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') { const r = parseRef(v); if (r) refs.push(r); }
  }
  for (const r of refs) {
    const cred = await db
      .select({ id: schema.credentials.id, ownerId: schema.credentials.ownerId })
      .from(schema.credentials)
      .where(eq(schema.credentials.name, r.name))
      .get();
    if (!cred) return `凭证引用 ref.${r.name}.${r.key}：凭证 "${r.name}" 不存在`;
    if (cred.ownerId !== principal.userId && !principal.isAdmin) {
      return `凭证引用 ref.${r.name}.${r.key}：凭证 "${r.name}" 非本人创建（引用只能指向自己的凭证，共享凭证不可被引用）`;
    }
  }
  return null;
}

/** 凭证类型（前端按类型表单的落库值；类型 = 键名约定 + 展示，取值仍按槽位键名解包） */
// 类型字典在 src/config/constants.ts（L2 结构真值源），此处仅引用

/** 用户 id → 用户名（归属展示用；只取 username，不带 email 等敏感字段） */
async function ownerNameMap(db: BetterSQLite3Database<typeof schema>): Promise<Map<string, string>> {
  const rows = await db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).all();
  return new Map(rows.map((r) => [r.id, r.username]));
}

/**
 * 资产创建时的初始分组归属：按品类取内置默认分组（不存在则创建）。
 * `other` 无默认归属（无可推断的分组），返回 null。
 */
async function ensureDefaultGroupFor(
  db: BetterSQLite3Database<typeof schema>,
  category: string,
): Promise<string | null> {
  const name = DEFAULT_GROUP_BY_CATEGORY[category as keyof typeof DEFAULT_GROUP_BY_CATEGORY];
  if (!name) return null;
  const existing = await db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, name)).get();
  if (existing) return existing.id;
  const created = await db
    .insert(schema.groups)
    .values({ name, description: `${name} 品类资产的默认分组（创建资产时自动加入，可再调整）` })
    .returning({ id: schema.groups.id })
    .get();
  return created.id;
}

/** 治理审计（一目了然的事件落一条：visibility_change / group_change / credential_bind / credential_rotate / guard_rule_change / system_setting） */
export function governanceAudit(
  audit: AuditService,
  principal: { userId: string; isAdmin: boolean },
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return audit.writeIntent({
    principal,
    asset: { id: 'management', name: 'management' },
    tool: 'system_setting',
    args,
    risk: 'normal',
    status: 'success',
    action,
  });
}

export interface AssetRoutesDeps {
  db: BetterSQLite3Database<typeof schema>;
  audit: AuditService;
  cryptoKey: Buffer;
  pool?: InstancePool;
  ssh?: SshConnector;
  credentials?: CredentialService;
  runtimeCredsDir?: string;
  settings: import('../config/settings.js').SettingsLike;
  /** 原生工具注册表：内建 HTTP 资产的"工具清单"来自它（按 category 过滤，固定不可变） */
  nativeRegistry?: Array<{ id: string; category: string; name: string; description: string }>;
}

/**
 * 各原生 HTTP 品类的探活：发一个最轻的只读请求。
 *
 * 统一走 `makeHandle`（与工具调用同一条连接栈）——这样 TLS 开关、超时、错误语义
 * 只有一份实现，探活和真实调用不会出现"测试通过但调用失败"的分裂。
 */
async function probeHttpNative(
  asset: { id: string; name: string; category: string; url: string | null; credentialSlots: unknown; configHash: string; allowInsecureTls?: boolean },
  userId: string,
  credentials: CredentialService | undefined,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!asset.url) {
    return reply.code(400).send({ code: 400, data: null, message: '该资产缺少管理 API 地址（URL），请先在配置里填写' });
  }
  const slots = ((asset.credentialSlots ?? []) as Array<{ name: string }>).map((s) => s.name);
  let creds: Record<string, string> = {};
  if (slots.length > 0) {
    if (!credentials) return reply.code(503).send({ code: 503, data: null, message: '凭证服务未初始化' });
    try {
      // 未绑定的槽位不出现在结果里（平台不替产品判必填），取不到就按"未提供鉴权"发请求
      creds = Object.fromEntries(
        credentials.resolveSlotValues(asset.id, slots, userId).map((r) => [r.slotName, r.value]),
      );
    } catch (err) {
      return reply.code(400).send({ code: 400, data: null, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const base = asset.url.replace(/\/+$/, '');
  // 与工具调用同一连接栈：自签证书资产在这里同样跳过校验
  const handle = makeHandle(base, 10_000, asset.allowInsecureTls ? insecureFetch : undefined);
  const auth = creds['ZABBIX_TOKEN'] ?? creds['ROCKETMQ_TOKEN'];
  const headers: Record<string, string> = auth ? { Authorization: `Bearer ${auth}` } : {};
  try {
    if (asset.category === 'zabbix') {
      const body = await handle.requestJson<{ result?: string; error?: { message?: string; data?: string } }>('/api_jsonrpc.php', {
        method: 'POST',
        headers,
        body: { jsonrpc: '2.0', method: 'apiinfo.version', params: {}, id: 1 },
      });
      if (body.error) throw new Error(`Zabbix 返回错误：${body.error.message ?? ''} ${body.error.data ?? ''}`.trim());
      return reply.send({ code: 0, data: { ok: true, mode: 'native-http', detail: `Zabbix API ${body.result ?? ''}`.trim() }, message: 'ok' });
    }
    if (asset.category === 'rocketmq') {
      const body = await handle.requestJson<{ status?: number; errMsg?: string }>('/cluster/list.query', { headers });
      if (typeof body.status === 'number' && body.status !== 0) {
        throw new Error(`RocketMQ 返回状态 ${body.status}${body.errMsg ? `：${body.errMsg}` : ''}`);
      }
      return reply.send({ code: 0, data: { ok: true, mode: 'native-http', detail: 'RocketMQ Dashboard 可访问' }, message: 'ok' });
    }
    if (asset.category === 'nacos') {
      // Nacos 的 baseUrl 可能带 /nacos/v1（connector 会补），这里按根路径探测
      const root = base.replace(/\/nacos\/v1$/, '');
      const nacosHandle = makeHandle(root, 10_000, asset.allowInsecureTls ? insecureFetch : undefined);
      let nacosAuth: Record<string, string> = {};
      const token = creds['NACOS_TOKEN'];
      if (token) {
        nacosAuth = { Authorization: `Bearer ${token}` };
      } else if (creds['NACOS_USERNAME'] && creds['NACOS_PASSWORD']) {
        const login = await nacosHandle.requestJson<{ accessToken?: string }>('/nacos/v1/auth/login', {
          method: 'POST',
          form: { username: creds['NACOS_USERNAME'], password: creds['NACOS_PASSWORD'] },
        });
        if (!login?.accessToken) throw new Error('Nacos 登录未返回 accessToken：检查用户名/密码');
        nacosAuth = { Authorization: `Bearer ${login.accessToken}` };
      }
      const text = await nacosHandle.requestText('/nacos/v1/console/health/readiness', { headers: nacosAuth });
      return reply.send({ code: 0, data: { ok: true, mode: 'native-http', detail: `Nacos readiness: ${text.trim()}` }, message: 'ok' });
    }
    return reply.code(400).send({ code: 400, data: null, message: `不支持的原生品类 ${asset.category} 连通性测试` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(502).send({ code: 502, data: null, message: `连通性测试失败：${msg}` });
  }
}

/** 治理审计（一目了然的事件落一条：visibility_change / group_change / credential_bind / credential_rotate / guard_rule_change / system_setting） */
/** 按当前绑定（含凭证 updatedAt）与直填值指纹计算某资产的实例键（§5.4）——用于删除/轮换/改值时的池失效 */
export async function serverInstanceKeys(
  db: BetterSQLite3Database<typeof schema>,
  serverId: string,
): Promise<string[]> {
  const server = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
  if (!server) return [];
  const slots = await db
    .select({
      slotName: schema.serverCredentials.slotName,
      credentialId: schema.serverCredentials.credentialId,
      updatedAt: schema.credentials.updatedAt,
    })
    .from(schema.serverCredentials)
    .innerJoin(schema.credentials, eq(schema.serverCredentials.credentialId, schema.credentials.id))
    .where(eq(schema.serverCredentials.serverId, serverId))
    .all();
  const refs = slots.map((s) => ({ slotName: s.slotName, credentialId: s.credentialId, updatedAtMs: Number(s.updatedAt) }));
  // 直填值：credentialId 段用 `inline:<值指纹>`（与 buildPlan 的约定一致，见 instancePlan.ts）
  const direct = await db
    .select({ slotName: schema.serverSlotValues.slotName, fingerprint: schema.serverSlotValues.valueFingerprint })
    .from(schema.serverSlotValues)
    .where(eq(schema.serverSlotValues.serverId, serverId))
    .all();
  for (const d of direct) {
    refs.push({ slotName: d.slotName, credentialId: `inline:${d.fingerprint}`, updatedAtMs: 0 });
  }
  return [buildInstanceKey(serverId, server.configHash, refs)];
}

/**
 * 绑定上的 credentialKey 归一（ADR-031）：空串 / null / 全空白 → null（按槽位名匹配）。
 * 不做键名推断，原样存——键是否存在由各写入端点校验。
 */
function normalizeCredentialKey(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * 掩码提示（列表 `值提示` 列）：优先取敏感键的末 4 位，没有敏感键则取首个值的末 4 位。
 * 创建与 PATCH 共用同一份规则——改值后掩码必须跟着变，否则用户会以为没保存成功。
 */
const HINT_KEY_RE = /passwd|password|secret|token|private|api[_-]?key|access|auth|credential/i;
function hintOf(values: Record<string, string>): string {
  const keys = Object.keys(values);
  const hintKey = keys.find((k) => HINT_KEY_RE.test(k)) ?? keys[0]!;
  return `****${values[hintKey]!.slice(-4)}`;
}

/** 丢弃全空白值；返回 null 表示清洗后没有任何可用的值（空凭证一律拒绝） */
function cleanValues(raw: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (!key || typeof v !== 'string') continue;
    if (v.trim() === '') continue;
    out[key] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function makeAssetRoutes(deps: AssetRoutesDeps): RouteDefinition[] {
  const { db, audit } = deps;

  const visibleServers = async (principal: { userId: string; isAdmin: boolean }) => {
    const all = await db.select().from(schema.servers);
    const out = [];
    for (const row of all) {
      if (await canOnAsset(db, 'view', principal, row)) out.push(row);
    }
    return out;
  };

  return [
    {
      /**
       * 安全摘要（概览安全条）：一次全量聚合，替代前端逐资产查询。
       * 为什么放服务端：①消除 N+1；②覆盖**全部**可见资产（前端只能拿分页 50 条）；
       * ③失败以 5xx 显式返回，前端据此显示"统计不可用"而非假报 0（安全语义不允许吞错）。
       */
      method: 'GET',
      url: '/api/v1/servers/security-summary',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const rows = await visibleServers(req.principal!);
        const ids = rows.map((r) => r.id);
        const directByAsset = new Map<string, Set<string>>();
        const boundByAsset = new Map<string, Set<string>>();
        if (deps.credentials) {
          // 一次取出全部直填值槽位名 + 全部绑定槽位名（两条查询，非按资产循环）
          const directRows = ids.length > 0
            ? await db
                .select({ serverId: schema.serverSlotValues.serverId, slotName: schema.serverSlotValues.slotName })
                .from(schema.serverSlotValues)
                .where(inArray(schema.serverSlotValues.serverId, ids))
                .all()
            : [];
          for (const d of directRows) {
            const set = directByAsset.get(d.serverId) ?? new Set<string>();
            set.add(d.slotName);
            directByAsset.set(d.serverId, set);
          }
          const boundRows = ids.length > 0
            ? await db
                .select({ serverId: schema.serverCredentials.serverId, slotName: schema.serverCredentials.slotName })
                .from(schema.serverCredentials)
                .where(inArray(schema.serverCredentials.serverId, ids))
                .all()
            : [];
          for (const b of boundRows) {
            const set = boundByAsset.get(b.serverId) ?? new Set<string>();
            set.add(b.slotName);
            boundByAsset.set(b.serverId, set);
          }
        }
        let publicCount = 0;
        let missingCredAssets = 0;
        for (const asset of rows) {
          if (asset.visibility === 'public') publicCount++;
          const defs = ((asset.credentialSlots ?? []) as Array<{ name: string }>).map((s) => s.name);
          if (defs.length === 0) continue;
          const direct = directByAsset.get(asset.id) ?? new Set<string>();
          const bound = boundByAsset.get(asset.id) ?? new Set<string>();
          if (defs.some((n) => !direct.has(n) && !bound.has(n))) missingCredAssets++;
        }
        return reply.send({
          code: 0,
          data: { totalAssets: rows.length, publicCount, missingCredAssets },
          message: 'ok',
        });
      },
    },
    {
      /**
       * 已有标签枚举（供前端"从已有标签选"，避免 prod/Prod/生产 这类近义重复把 `?tag=` 筛坏）。
       * 只统计当前用户可见的资产；按出现次数降序，同次数按字典序。
       */
      method: 'GET',
      url: '/api/v1/servers/tags',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const rows = await visibleServers(req.principal!);
        const counter = new Map<string, number>();
        for (const r of rows) {
          for (const t of ((r.tags as string[] | null) ?? [])) {
            const tag = typeof t === 'string' ? t.trim() : '';
            if (!tag) continue;
            counter.set(tag, (counter.get(tag) ?? 0) + 1);
          }
        }
        const data = [...counter.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        return reply.send({ code: 0, data, message: 'ok' });
      },
    },
    {
      // 批量槽位状态（T7 去 N+1）：一次返回指定资产的"凭证/直填值是否齐全"。
      // 只返回聚合状态位（不泄露单槽位绑定明细），权限按 can('view') 逐资产过滤。
      method: 'GET',
      url: '/api/v1/servers/slot-status',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const q = req.query as { ids?: string };
        const ids = (q.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
        const out: Record<string, { total: number; missing: number }> = {};
        if (ids.length === 0) return reply.send({ code: 0, data: out, message: 'ok' });
        const rows = await db.select().from(schema.servers).where(inArray(schema.servers.id, ids)).all();
        const directByAsset = new Map<string, Set<string>>();
        const boundByAsset = new Map<string, Set<string>>();
        if (deps.credentials) {
          for (const id of ids) {
            const direct = deps.credentials.slotValuesOf(id);
            if (direct.size > 0) directByAsset.set(id, new Set(direct.keys()));
            const binds = await db
              .select({ slotName: schema.serverCredentials.slotName })
              .from(schema.serverCredentials)
              .where(eq(schema.serverCredentials.serverId, id))
              .all();
            if (binds.length > 0) boundByAsset.set(id, new Set(binds.map((b) => b.slotName)));
          }
        }
        for (const asset of rows) {
          if (!(await canOnAsset(db, 'view', req.principal!, asset))) continue;
          const defs = ((asset.credentialSlots ?? []) as Array<{ name: string }>).map((s) => s.name);
          const direct = directByAsset.get(asset.id) ?? new Set<string>();
          const bound = boundByAsset.get(asset.id) ?? new Set<string>();
          // 只统计"要素齐全度"，不再是可用性判据：未绑定槽位不再拦截调用（2026-11-17 决策）
          const missing = defs.filter((n) => !direct.has(n) && !bound.has(n)).length;
          out[asset.id] = { total: defs.length, missing };
        }
        return reply.send({ code: 0, data: out, message: 'ok' });
      },
    },
    {
      /**
       * 批量资产操作（Spec §8.5：列表勾选后批量停用/启用/删除/设置私网访问）。
       *
       * 逐条校验权限（owner 或 admin），不做"部分成功静默跳过"：返回 succeeded/failed
       * 明细，由前端展示。任一条失败不会回滚其他条——批量删除的回滚语义不可实现
       * （删了就是删了），因此宁可显式列出失败项。
       */
      method: 'POST',
      url: '/api/v1/servers/batch',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const body = req.body as {
          ids?: unknown;
          action?: unknown;
          value?: unknown;
        };
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 200)
          : [];
        if (ids.length === 0) {
          return reply.code(400).send({ code: 400, data: null, message: 'ids 必须是非空字符串数组（上限 200）' });
        }
        const action = String(body.action ?? '');
        if (!['enable', 'disable', 'delete', 'allow-private-network', 'deny-private-network'].includes(action)) {
          return reply.code(400).send({
            code: 400,
            data: null,
            message: 'action 仅 enable|disable|delete|allow-private-network|deny-private-network',
          });
        }

        const succeeded: string[] = [];
        const failed: Array<{ id: string; reason: string }> = [];
        for (const id of ids) {
          const row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
          if (!row) { failed.push({ id, reason: '资产不存在' }); continue; }
          // 批量是管理动作：只允许归属人本人或 admin（与单条 PATCH/DELETE 同口径）
          if (row.ownerId !== p.userId && !p.isAdmin) {
            failed.push({ id, reason: '无权操作（仅归属人或管理员）' });
            continue;
          }
          try {
            if (action === 'delete') {
              for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
              db.transaction((tx) => {
                tx.delete(schema.serverCredentials).where(eq(schema.serverCredentials.serverId, id)).run();
                tx.delete(schema.serverSlotValues).where(eq(schema.serverSlotValues.serverId, id)).run();
                tx.delete(schema.groupServers).where(eq(schema.groupServers.serverId, id)).run();
                tx.delete(schema.servers).where(eq(schema.servers.id, id)).run();
              });
              await pruneGuardRuleScopes(db, id);
              await governanceAudit(audit, p, 'remove_asset', {
                serverId: id, name: row.name, category: row.category, executionMode: row.executionMode, batch: true,
              });
            } else if (action === 'enable' || action === 'disable') {
              const enabled = action === 'enable';
              await db.update(schema.servers).set({ enabled } as never).where(eq(schema.servers.id, id)).run();
              if (!enabled) for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
              await governanceAudit(audit, p, 'asset_enabled_change', { serverId: id, enabled, batch: true });
            } else {
              const allow = action === 'allow-private-network';
              await db.update(schema.servers).set({ allowPrivateNetwork: allow } as never).where(eq(schema.servers.id, id)).run();
              await governanceAudit(audit, p, 'visibility_change', {
                serverId: id, allow_private_network: allow, batch: true,
              });
            }
            succeeded.push(id);
          } catch (err) {
            failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
          }
        }
        return reply.send({ code: 0, data: { action, succeeded, failed }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/servers',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const q = req.query as {
          page?: string; category?: string; search?: string; type?: string;
          executionMode?: string; enabled?: string; tag?: string; visibility?: string;
          pageSize?: string;
        };
        const rows = await visibleServers(req.principal!);
        const page = Math.max(1, Number(q.page ?? '1') || 1);
        // 页大小默认 50（列表页）；选择器类场景可放宽到 500（有上限，防一次拉爆）
        const pageSize = Math.min(500, Math.max(1, Number(q.pageSize ?? '50') || 50));
        const filtered = rows.filter(
          (r) =>
            (!q.category || r.category === q.category) &&
            (!q.type || r.type === q.type) &&
            (!q.search || r.name.includes(q.search) || (r.displayName ?? '').includes(q.search)) &&
            (!q.executionMode || r.executionMode === q.executionMode) &&
            (q.enabled === undefined || String(r.enabled) === q.enabled) &&
            (!q.visibility || r.visibility === q.visibility) &&
            (!q.tag || ((r.tags as string[] | null) ?? []).includes(q.tag)),
        );
        return reply.send({ code: 0, data: { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/servers',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const body = req.body as {
          name?: string; displayName?: string; description?: string;
          type?: string; executionMode?: string; category?: string;
          hostConn?: Record<string, unknown>; command?: string; args?: unknown; env?: unknown;
          url?: string; headers?: Record<string, unknown>; tags?: unknown; credentialSlots?: unknown[];
          /** 允许不安全 TLS（自签证书）；默认 false */
          allowInsecureTls?: boolean;
          /** 槽位凭证绑定（创建即绑定）：slotName → credentialId */
          credentialBindings?: Record<string, string>;
          /** 槽位直填值（ADR-027，非凭证）：随创建一次落库，与凭证绑定同槽位互斥 */
          inlineValues?: Record<string, string>;
        };
        if (!body.name || !DNS1123_RE.test(body.name)) {
          return reply.code(400).send({ code: 400, data: null, message: 'name 必须符合 DNS-1123（小写字母数字连字符点）' });
        }
        if (!body.type || !['stdio', 'http', 'sse', 'native'].includes(body.type)) {
          return reply.code(400).send({ code: 400, data: null, message: 'type 仅 stdio|http|sse|native' });
        }
        const executionMode = body.executionMode ?? (body.category === 'host' ? 'native' : 'mcp');
        if (!['native', 'mcp'].includes(executionMode)) return reply.code(400).send({ code: 400, data: null, message: 'executionMode 仅 native|mcp' });
        // native 的两种形态：host=SSH 直连（需 hostConn）；zabbix/rocketmq/nacos=HTTP API（需 url）。
        // 其余 category 仍只能走 mcp（社区 MCP 子进程）。
        const HTTP_NATIVE_CATEGORIES = ['zabbix', 'rocketmq', 'nacos'];
        const isHttpNative = body.category !== undefined && HTTP_NATIVE_CATEGORIES.includes(body.category);
        if (executionMode === 'native' && body.category !== 'host' && !isHttpNative) {
          return reply.code(400).send({
            code: 400,
            data: null,
            message: `native 仅支持 category=host 或 ${HTTP_NATIVE_CATEGORIES.join('/')}；其余走 mcp`,
          });
        }
        if (executionMode === 'native' && body.category === 'host' && (!body.hostConn?.host || !body.hostConn.username)) {
          return reply.code(400).send({ code: 400, data: null, message: '原生 SSH 资产需 hostConn{host, username}' });
        }
        if (executionMode === 'native' && body.category !== 'host' && !body.url) {
          return reply.code(400).send({ code: 400, data: null, message: `${body.category} 原生资产需 url（管理 API 地址）` });
        }
        if (executionMode === 'mcp' && !body.command && !body.url) {
          return reply.code(400).send({ code: 400, data: null, message: 'mcp 资产需 command（stdio）或 url（HTTP/SSE）' });
        }
        // 协议与连接参数一致性（fail-closed：stdio 不带 url；http/sse 必须带 url）
        if (executionMode === 'mcp') {
          if (body.type === 'stdio' && body.url) {
            return reply.code(400).send({ code: 400, data: null, message: 'stdio 资产不应携带 url' });
          }
          if ((body.type === 'http' || body.type === 'sse') && !body.url) {
            return reply.code(400).send({ code: 400, data: null, message: `${body.type} 资产需 url` });
          }
          if (body.type === 'sse' && body.command) {
            return reply.code(400).send({ code: 400, data: null, message: 'sse 资产不应携带 command' });
          }
        }
        const category = body.category ?? 'other';
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(category)) {
          // ADR-032：品类不再受硬编码白名单约束（否则新增品类要改代码发版），只约束格式——
          // 品类会进工具名前缀（`{category}_{tool}`）与规则匹配维度，非法字符会破坏这两处契约。
          return reply.code(400).send({ code: 400, data: null, message: 'category 须为小写字母开头、仅含小写字母/数字/短横线（≤32 字符）' });
        }
        if ((body.credentialSlots?.length ?? 0) > deps.settings.get<number>('credentials.max_slots')) {
          return reply.code(400).send({ code: 400, data: null, message: `凭证槽位数超过上限（credentials.max_slots）` });
        }
        // 标签参与 `?tag=` 精确匹配：创建路径与 PATCH 用同一份归一规则
        const tagsNorm = normalizeTags(body.tags ?? []);
        if ('error' in tagsNorm) return reply.code(400).send({ code: 400, data: null, message: tagsNorm.error });
        // ref.<凭证名>.<键名> 保存校验（引用存在 + 本人创建，ADR-028；fail-closed）
        const refErr = await validateRefs(db, p, { env: body.env, args: body.args, headers: body.headers });
        if (refErr) return reply.code(400).send({ code: 400, data: null, message: refErr });
        // §5.6 SSRF：URL 资产保存时即校验（fail-closed；allow_private_network 默认 0）
        if (body.url) {
          try {
            // v1 默认 allow_private_network=0（fail-closed）；本条创建路径不允许私网（显式开启走 PATCH/批量）
            await assertUrlAllowed(body.url, false);
          } catch (err) {
            return reply.code(400).send({ code: 400, data: null, message: `SSRF 校验失败：${err instanceof SsrfError ? err.message : String(err)}` });
          }
        }
        // 槽位“创建即绑定”（原子化）：凭证绑定与直填值随资产一次落库，失败整体回滚，
        // 避免"资产建好了但取值没写进去"的半成品（T1-4）。
        const declaredSlots = ((body.credentialSlots ?? []) as Array<{ name?: string }>)
          .map((s) => s.name)
          .filter((n): n is string => typeof n === 'string');
        const requestedBindings = body.credentialBindings ?? {};
        const requestedInline = body.inlineValues ?? {};
        const slotBindings: Array<{ slotName: string; credentialId: string }> = [];
        const slotInlines: Array<{ slotName: string; value: string }> = [];
        for (const [slotName, value] of Object.entries(requestedInline)) {
          if (typeof value !== 'string' || !value.trim()) continue;
          if (!declaredSlots.includes(slotName)) {
            return reply.code(400).send({ code: 400, data: null, message: `槽位 "${slotName}" 未在 credentialSlots 中定义` });
          }
          slotInlines.push({ slotName, value });
        }
        for (const [slotName, credentialId] of Object.entries(requestedBindings)) {
          if (typeof credentialId !== 'string' || !credentialId) continue;
          if (!declaredSlots.includes(slotName)) {
            return reply.code(400).send({ code: 400, data: null, message: `槽位 "${slotName}" 未在 credentialSlots 中定义` });
          }
          if (slotInlines.some((x) => x.slotName === slotName)) {
            return reply.code(400).send({ code: 400, data: null, message: `槽位 "${slotName}" 不能同时绑定凭证与填值（二者互斥）` });
          }
          const cred = await db.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId)).get();
          if (!cred) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
          if (!assertOwnCredentialOrAdmin(p, cred.ownerId)) {
            return reply.code(400).send({ code: 400, data: null, message: `凭证 "${cred.name}" 非本人创建，不能绑定（共享凭证只能使用）` });
          }
          slotBindings.push({ slotName, credentialId });
        }
        if (slotInlines.length > 0 && !deps.credentials) {
          return reply.code(500).send({ code: 500, data: null, message: '凭证服务未初始化，无法写入直填值' });
        }
        const credentialsSvc = deps.credentials;

        // 单事务：资产 + 凭证绑定 + 直填值（setSlotValue 走同一 sqlite 连接、同步写入）
        // 初始分组：按品类自动加入内置默认分组（host/mysql/k8s/zabbix/rocketmq/nacos；other 不归组）
        const initialGroupId = await ensureDefaultGroupFor(db, category);
        const row = db.transaction((tx) => {
          const created = tx
            .insert(schema.servers)
            .values({
              name: body.name!,
              displayName: body.displayName ?? null,
              description: body.description ?? null,
              type: body.type!,
              executionMode,
              category,
              hostConn: (body.hostConn ?? null) as object | null,
              tags: tagsNorm.tags,
              command: body.command ?? null,
              args: (body.args ?? null) as unknown[] | null,
              env: (body.env ?? null) as object | null,
              url: body.url ?? null,
              headers: (body.headers && Object.keys(body.headers).length > 0 ? body.headers : null) as object | null,
              allowInsecureTls: body.allowInsecureTls === true,
              credentialSlots: (body.credentialSlots ?? []) as never[],
              ownerId: p.userId,
              visibility: 'owner',
              sharedWithUserIds: [],
              configHash: `${Date.now().toString(36)}`,
            })
            .returning({ id: schema.servers.id, name: schema.servers.name })
            .get();
          for (const b of slotBindings) {
            tx.insert(schema.serverCredentials)
              .values({ serverId: created.id, slotName: b.slotName, userId: p.userId, credentialId: b.credentialId, scope: 'asset' })
              .onConflictDoNothing()
              .run();
          }
          if (initialGroupId) {
            tx.insert(schema.groupServers)
              .values({ groupId: initialGroupId, serverId: created.id })
              .onConflictDoNothing()
              .run();
          }
          for (const v of slotInlines) credentialsSvc!.setSlotValue(created.id, v.slotName, v.value, p.userId);
          return created;
        });
        // 创建即绑定同属治理事件：逐条留 credential_bind（与单独绑定路径口径一致）
        for (const b of slotBindings) {
          await governanceAudit(audit, p, 'credential_bind', { serverId: row.id, slotName: b.slotName, credentialId: b.credentialId });
        }
        for (const v of slotInlines) {
          await governanceAudit(audit, p, 'credential_bind', { serverId: row.id, slotName: v.slotName, inline: true });
        }
        return reply.send({ code: 0, data: row, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/servers/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!row || !(await canOnAsset(db, 'view', req.principal!, row))) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在或无权访问' });
        }
        return reply.send({ code: 0, data: row, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/servers/:id/test',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset || !(await canOnAsset(db, 'view', p, asset))) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在或无权访问' });
        }
        if (!claimTesting(id)) {
          return reply.code(429).send({ code: 429, data: null, message: '该资产正在测试中，请稍后重试' });
        }
        try {
          if (asset.executionMode === 'mcp') {
            if (!deps.pool) return reply.code(503).send({ code: 503, data: null, message: '实例池未初始化' });
            const slots = ((asset.credentialSlots ?? []) as Array<{ name: string }>).map((x) => x.name);
            const resolved = deps.credentials ? deps.credentials.resolveSlotValues(asset.id, slots, p.userId) : [];
            const plan = buildPlan(
              { id: asset.id, configHash: asset.configHash, command: asset.command, args: asset.args ?? [], env: asset.env ?? {}, url: asset.url, headers: asset.headers ?? {}, transport: transportOf(asset.type), allowInsecureTls: asset.allowInsecureTls === true, resolveRef: makeRefResolver(deps.credentials ?? null), credentialSlots: (asset.credentialSlots ?? []) as never },
              resolved,
              deps.runtimeCredsDir ?? './data/runtime-creds',
            );
            const h = await deps.pool.acquire(plan, p.userId);
            const tools = await h.client.listTools();
            await h.release();
            return reply.send({ code: 0, data: { ok: true, mode: 'mcp', tools: tools.tools.length }, message: 'ok' });
          }
          // 原生非 host 品类（zabbix/rocketmq/nacos）：进程内 HTTP 直连，探一个只读端点
          if (asset.executionMode !== 'mcp' && asset.category !== 'host') {
            return await probeHttpNative(asset, p.userId, deps.credentials, reply);
          }
          if (!deps.ssh) return reply.code(503).send({ code: 503, data: null, message: 'SSH 连接器未初始化' });
          const authSlot = (asset.hostConn as { authSlot?: string } | null)?.authSlot ?? '';
          const handle = await deps.ssh.acquire(
            {
              id: asset.id, name: asset.name, category: asset.category, ownerId: asset.ownerId,
              executionMode: 'native',
              hostConn: (asset.hostConn ?? null) as never,
              credentialSlots: (asset.credentialSlots ?? []) as never,
              configHash: asset.configHash,
            } as never,
            authSlot,
            // 连通性测试用"当前这个人实际会用到的凭证"，否则成员自绑凭证坏了也显示通过
            { userId: p.userId, isAdmin: p.isAdmin },
          );
          const res = await handle.exec('echo ok', 10_000);
          deps.ssh.release(handle);
          return reply.send({ code: 0, data: { ok: res.exitCode === 0, mode: 'native', stdout: res.stdout.trim() }, message: 'ok' });
        } catch (err) {
          return reply.code(502).send({ code: 502, data: null, message: '连通性测试失败：' + (err instanceof Error ? err.message : String(err)) });
        } finally {
          testingAssets.delete(id);
        }
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/servers/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        if (row.ownerId !== p.userId && !p.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        const body = req.body as { visibility?: string; sharedWithUserIds?: string[]; displayName?: string; description?: string; tags?: unknown; allowPrivateNetwork?: boolean; allowInsecureTls?: boolean; credentialSlots?: Array<{ target: string; name: string; label: string; file: boolean }>; url?: string; enabled?: boolean; hostConn?: { authPassSlot?: string | null } };
        const patch: Record<string, unknown> = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.description !== undefined) patch.description = body.description;
        if (body.tags !== undefined) {
          // 标签参与 `?tag=` 精确匹配，写入侧必须归一（去空白/去重/限长限数），否则筛选项会被脏值污染
          const r = normalizeTags(body.tags);
          if ('error' in r) return reply.code(400).send({ code: 400, data: null, message: r.error });
          patch.tags = r.tags;
        }
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') {
            return reply.code(400).send({ code: 400, data: null, message: 'enabled 仅 boolean' });
          }
          patch.enabled = body.enabled;
        }
        if (body.url !== undefined) {
          // 地址可改（建资产时填错、或内建条目升级后要指向真实地址）；仍走 SSRF 校验。
          // 同一请求里可能同时开 allowPrivateNetwork，校验按"变更后的最终值"判定，
          // 否则用户必须发两次请求才能把内网地址存进去。
          const url = body.url.trim();
          if (!url) return reply.code(400).send({ code: 400, data: null, message: 'url 不能为空；如需清空请删除资产' });
          const allowPrivate = body.allowPrivateNetwork !== undefined ? body.allowPrivateNetwork : row.allowPrivateNetwork === true;
          try {
            await assertUrlAllowed(url, allowPrivate);
          } catch (err) {
            return reply.code(400).send({ code: 400, data: null, message: `SSRF 校验失败：${err instanceof SsrfError ? err.message : String(err)}` });
          }
          patch.url = url;
        }
        if (body.credentialSlots !== undefined) {
          // T12 手动补槽位：整体替换（合并语义由前端读-改-写完成）
          if (body.credentialSlots.length > deps.settings.get<number>('credentials.max_slots')) {
            return reply.code(400).send({ code: 400, data: null, message: '凭证槽位数超过上限（credentials.max_slots）' });
          }
          patch.credentialSlots = body.credentialSlots;
          // 槽位声明变化必须回收实例：实例键只含「已绑定的槽位」（buildInstanceKey），
          // 不含声明列表——不回收的话，补了槽位并绑上值，已在运行的实例仍是旧计划，读不到新槽位。
          for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        }
        /**
         * 私钥口令槽位（authPassSlot）可在创建后补写。
         *
         * 为什么需要：该字段此前只在创建弹窗写入，PATCH 不接受 hostConn，导致——
         * 建资产时选了"密码"方式、事后改用加密私钥的资产**永远**补不上口令槽位，
         * 信任指纹与连通测试一律报 "Encrypted private OpenSSH key detected, but no passphrase given"，
         * 即便在详情页把 AUTH_PASS 槽位绑好了也没用（解析只看 hostConn.authPassSlot）。
         *
         * 白名单只开放 authPassSlot：host/port/username 等连接参数一旦可改就会绕过创建期的
         * 校验与审计，也等于让普通成员能把资产指向别的主机。这里不做整体替换，只做单字段合并。
         */
        if (body.hostConn !== undefined) {
          if (row.executionMode !== 'native' || !row.hostConn) {
            return reply.code(400).send({ code: 400, data: null, message: '仅原生 SSH 主机支持配置口令槽位' });
          }
          const cur = row.hostConn as Record<string, unknown>;
          const slot = body.hostConn?.authPassSlot;
          const next: Record<string, unknown> = { ...cur };
          if (slot === null || slot === '') {
            delete next.authPassSlot;
          } else if (slot !== undefined) {
            if (typeof slot !== 'string') {
              return reply.code(400).send({ code: 400, data: null, message: 'authPassSlot 必须为字符串或 null' });
            }
            const declared = ((row.credentialSlots ?? []) as Array<{ name?: string }>).map((s) => s.name);
            if (!declared.includes(slot)) {
              return reply.code(400).send({ code: 400, data: null, message: `资产未声明槽位 "${slot}"，请先在「凭证绑定」中补槽位` });
            }
            next.authPassSlot = slot;
          }
          if (JSON.stringify(next) !== JSON.stringify(cur)) {
            patch.hostConn = next;
            await governanceAudit(audit, p, 'asset_update', {
              serverId: id, field: 'authPassSlot', from: cur.authPassSlot ?? null, to: next.authPassSlot ?? null,
            });
          }
        }
        if (body.allowPrivateNetwork !== undefined) {
          patch.allowPrivateNetwork = body.allowPrivateNetwork;
          await governanceAudit(audit, p, 'visibility_change', { serverId: id, allow_private_network: body.allowPrivateNetwork });
        }
        if (body.allowInsecureTls !== undefined) {
          if (typeof body.allowInsecureTls !== 'boolean') {
            return reply.code(400).send({ code: 400, data: null, message: 'allowInsecureTls 仅 boolean' });
          }
          patch.allowInsecureTls = body.allowInsecureTls;
          // 安全相关开关必须留痕：关闭证书校验会失去中间人防护
          await governanceAudit(audit, p, 'visibility_change', { serverId: id, allow_insecure_tls: body.allowInsecureTls });
          // 连接参数变化 → 旧实例必须重建（否则仍用旧 TLS 策略）
          for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        }
        if (body.visibility !== undefined) {
          if (!['owner', 'group', 'public'].includes(body.visibility)) {
            return reply.code(400).send({ code: 400, data: null, message: 'visibility 仅 owner|group|public' });
          }
          // 放宽可见性：任一槽位凭证非同主（只可能发生在 admin 绑过凭证的资产上）→ 400（§4.2 硬校验）
          const slots = await db
            .select({ ownerId: schema.credentials.ownerId, name: schema.credentials.name })
            .from(schema.serverCredentials)
            .innerJoin(schema.credentials, eq(schema.serverCredentials.credentialId, schema.credentials.id))
            .where(eq(schema.serverCredentials.serverId, id))
            .all();
          const sameOwner = slots.every((s) => s.ownerId === row.ownerId);
          if (!sameOwner) {
            const names = slots.map((s) => s.name).join('、');
            return reply.code(400).send({ code: 400, data: null, message: `可见性放宽被拒：凭证 ${names} 与资产非同一归属（需资产归属人授权）` });
          }
          patch.visibility = body.visibility;
          patch.sharedWithUserIds = body.sharedWithUserIds ?? row.sharedWithUserIds;
          await governanceAudit(audit, p, 'visibility_change', { serverId: id, from: row.visibility, to: body.visibility });
        }
        // 地址变了 → 旧实例指向的目标已失效，回收（与凭证轮换同构）
        if (patch.url !== undefined && patch.url !== row.url) {
          for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
          await governanceAudit(audit, p, 'asset_update', { serverId: id, field: 'url' });
        }
        // 停用 → 立即回收实例并写治理审计；启用不需要回收（下次调用按需拉起）
        if (patch.enabled !== undefined && patch.enabled !== row.enabled) {
          if (patch.enabled === false) {
            for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
          }
          await governanceAudit(audit, p, 'asset_enabled_change', { serverId: id, enabled: patch.enabled });
        }
        // 空 patch：请求里的字段全部未生效（例如 hostConn 只传了不允许改的键）→ 显式 400，
        // 不交给 drizzle 抛 "No values to set"（那是 500，看起来像服务端故障）
        if (Object.keys(patch).length === 0) {
          return reply.code(400).send({ code: 400, data: null, message: '没有可更新的字段' });
        }
        await db.update(schema.servers).set(patch as never).where(eq(schema.servers.id, id)).run();
        return reply.send({ code: 0, data: { id }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/servers/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        if (row.ownerId !== req.principal!.userId && !req.principal!.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        await db.delete(schema.serverCredentials).where(eq(schema.serverCredentials.serverId, id)).run();
        await db.delete(schema.serverSlotValues).where(eq(schema.serverSlotValues.serverId, id)).run();
        await db.delete(schema.groupServers).where(eq(schema.groupServers.serverId, id)).run();
        await db.delete(schema.servers).where(eq(schema.servers.id, id)).run();
        await pruneGuardRuleScopes(db, id);
        // 删除是破坏性治理动作，必须留痕（审计清单有 remove_asset，此前无写入点）
        await governanceAudit(audit, req.principal!, 'remove_asset', {
          serverId: id,
          name: row.name,
          category: row.category,
          executionMode: row.executionMode,
        });
        return reply.send({ code: 0, data: { id }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/servers/:id/slots',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset || !(await canOnAsset(db, 'view', req.principal!, asset))) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在或无权访问' });
        }
        const bound = await db
          .select({
            slotName: schema.serverCredentials.slotName,
            credentialId: schema.serverCredentials.credentialId,
            userId: schema.serverCredentials.userId,
            scope: schema.serverCredentials.scope,
            label: schema.serverCredentials.label,
            bindingUsername: schema.serverCredentials.username,
            bindingCredentialKey: schema.serverCredentials.credentialKey,
            name: schema.credentials.name,
            valueHint: schema.credentials.valueHint,
            privileges: schema.credentials.privileges,
          })
          .from(schema.serverCredentials)
          .leftJoin(schema.credentials, eq(schema.serverCredentials.credentialId, schema.credentials.id))
          .where(eq(schema.serverCredentials.serverId, id))
          .all();
        // ADR-028：每槽位可有多条绑定。当前用户能看到的 = 自己的全部 + 他人的 asset 绑定
        // （personal 绑定是他人私有选择，不暴露给其他成员）
        const bindingsBySlot = new Map<string, typeof bound>();
        for (const b of bound) {
          if (b.scope !== 'asset' && b.userId !== req.principal!.userId && !req.principal!.isAdmin) continue;
          const list = bindingsBySlot.get(b.slotName) ?? [];
          list.push(b);
          bindingsBySlot.set(b.slotName, list);
        }
        // 直填值（ADR-027）：资产自带密钥，非凭证；**仅归属人/管理员可见明文**，
        // 其余可见者只得到 hasInline（用于"已设置"判定），不下发明文（防成员读取密钥）
        const seesInlinePlaintext = asset.ownerId === req.principal!.userId || req.principal!.isAdmin;
        const direct = deps.credentials ? deps.credentials.slotValuesOf(id) : new Map<string, { value: string; updatedAtMs: number }>();
        const slots = ((asset.credentialSlots ?? []) as Array<{ target: string; name: string; label: string; file: boolean }>).map((s) => {
          const binds = (bindingsBySlot.get(s.name) ?? []).map((b) => ({
            credentialId: b.credentialId,
            credentialName: b.name ?? '—',
            valueHint: b.valueHint ?? '****',
            userId: b.userId,
            scope: b.scope as 'asset' | 'personal',
            label: b.label,
            username: b.bindingUsername,
            credentialKey: b.bindingCredentialKey,
            mine: b.userId === req.principal!.userId,
          }));
          // 主凭证 = 运行时实际会用到的那一条（personal 本人优先，再按等级/管理账号/稳定序），
          // 与 resolveSlotValues 共用 pickBestBinding，避免"界面显示 A、实际注入 B"
          const mine = binds.filter((b) => b.mine);
          const best = pickBestBinding(
            (mine.length > 0 ? mine : binds.filter((b) => b.scope === 'asset')).map((b) => ({
              credentialId: b.credentialId,
              privileges: JSON.stringify(
                (bindingsBySlot.get(s.name) ?? []).find((x) => x.credentialId === b.credentialId)?.privileges ?? [],
              ),
              credName: b.credentialName,
              bindingUsername: b.username,
            })),
          );
          const primary = best ? binds.find((b) => b.credentialId === best.credentialId) : undefined;
          const inline = direct.get(s.name);
          return {
            slotName: s.name,
            label: s.label,
            target: s.target,
            file: s.file,
            credentialId: primary?.credentialId ?? null,
            credentialName: primary?.credentialName ?? null,
            inlineValue: seesInlinePlaintext ? (inline?.value ?? null) : null,
            hasInline: inline !== undefined,
            bindings: binds,
          };
        });
        return reply.send({ code: 0, data: slots, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/servers/:id/slots/:slotName',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, slotName } = req.params as { id: string; slotName: string };
        const { credentialId } = req.query as { credentialId?: string };
        const p = req.principal!;
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset) return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        // 一槽多凭证后，解绑必须指明是哪一条：不传 credentialId 会把该槽位所有本人绑定一起删掉
        if (!credentialId) {
          return reply.code(400).send({ code: 400, data: null, message: 'credentialId 必填（同一槽位可能有多条绑定）' });
        }
        // ADR-028 §2.2：每条绑定只能由**添加者本人**删除；admin 例外（admin 也走同一行定位）
        const row = await db
          .select()
          .from(schema.serverCredentials)
          .where(
            and(
              eq(schema.serverCredentials.serverId, id),
              eq(schema.serverCredentials.slotName, slotName),
              eq(schema.serverCredentials.userId, p.userId),
              eq(schema.serverCredentials.credentialId, credentialId),
            ),
          )
          .get();
        if (!row) {
          return reply.code(404).send({ code: 404, data: null, message: '你没有该槽位的这条绑定记录' });
        }
        // 凭证变化 → 实例键失效（该资产实例回收）
        for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        await db
          .delete(schema.serverCredentials)
          .where(
            and(
              eq(schema.serverCredentials.serverId, id),
              eq(schema.serverCredentials.slotName, slotName),
              eq(schema.serverCredentials.userId, p.userId),
              eq(schema.serverCredentials.credentialId, credentialId),
            ),
          )
          .run();
        await governanceAudit(audit, p, 'credential_unbind', { serverId: id, slotName, credentialId: row.credentialId });
        return reply.send({ code: 0, data: { serverId: id, slotName, credentialId }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/servers/:id/slots',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const body = req.body as { slotName?: string; credentialId?: string; label?: string; shared?: boolean; username?: string; credentialKey?: string | null };
        if (!body.slotName || !body.credentialId) return reply.code(400).send({ code: 400, data: null, message: 'slotName/credentialId 必填' });
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        // 能绑 = 能看见该资产（owner / 组成员 / 被授权）；不再限定 owner
        if (!asset || !(await canOnAsset(db, 'invoke', p, asset))) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在或无权访问' });
        }
        const cred = await db.select().from(schema.credentials).where(eq(schema.credentials.id, body.credentialId)).get();
        if (!cred) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
        // 校验顺序：先归属（越权是更根本的错误，报错要指向真正的问题），再槽位合法性
        // ADR-028 §2.2：只能绑自己创建的凭证；共享凭证只能"用"不能"绑"（防转授权）
        if (!assertOwnCredentialOrAdmin(p, cred.ownerId)) {
          return reply.code(400).send({ code: 400, data: null, message: `凭证 "${cred.name}" 非本人创建，不能绑定（共享凭证只能使用）` });
        }
        // 槽位必须属于该资产生效的槽位集合（fail-closed）：否则会写入永不参与注入的孤儿绑定，
        // 既污染实例键计算，也让「已绑定」状态失真。
        const declared = ((asset.credentialSlots ?? []) as Array<{ name: string }>).map((s) => s.name);
        if (!declared.includes(body.slotName)) {
          return reply.code(400).send({
            code: 400,
            data: null,
            message: `槽位 "${body.slotName}" 不存在于该资产（可用：${declared.join('、') || '无'}）；如需新增请先补充槽位定义`,
          });
        }
        // scope 由**显式共享开关**决定（2026-11-17 用户决策），不再按"是否归属人"硬编码：
        //   shared=true  → asset  （共享给该资产的使用者：同组成员都能用）
        //   shared=false → personal（仅绑定者本人可用）
        // 只有归属人 / admin 有资格把凭证共享给他人；成员自建绑定只能是 personal——
        // 否则任何成员都能把自己的凭证"共享"出去，等于绕过 ADR-028 §2.2 的防转授权。
        const isOwnerOrAdmin = asset.ownerId === p.userId || p.isAdmin;
        const shared = body.shared === true;
        if (shared && !isOwnerOrAdmin) {
          return reply.code(400).send({ code: 400, data: null, message: '只有资产归属人或管理员可以把凭证共享给组内成员' });
        }
        const scope = shared ? 'asset' : 'personal';
        // 绑定级用户名（SSH 专用）：留空 = 不覆盖，解析时回落凭证 username / 资产 username
        const bindingUsername = typeof body.username === 'string' && body.username.trim() !== '' ? body.username.trim() : null;
        // 绑定级凭证键（ADR-031）：留空 = 按槽位名匹配；指定后精确取值，所以写入时就要确认键存在，
        // 否则会在运行期才炸，且报错点离用户操作很远。
        const credentialKey = normalizeCredentialKey(body.credentialKey);
        if (credentialKey) {
          const keys = deps.credentials?.valueKeysOf(body.credentialId) ?? [];
          if (!keys.includes(credentialKey)) {
            return reply.code(400).send({
              code: 400,
              data: null,
              message: `凭证 "${cred.name}" 没有键 "${credentialKey}"（可用：${keys.join('、') || '无'}）`,
            });
          }
        }
        await db
          .insert(schema.serverCredentials)
          .values({
            serverId: id,
            slotName: body.slotName,
            userId: p.userId,
            credentialId: body.credentialId,
            scope,
            label: body.label ?? null,
            username: bindingUsername,
            credentialKey,
          })
          // 主键含 credential_id：重复绑同一凭证才更新（幂等），绑不同凭证是**追加**一条
          .onConflictDoUpdate({
            target: [
              schema.serverCredentials.serverId,
              schema.serverCredentials.slotName,
              schema.serverCredentials.userId,
              schema.serverCredentials.credentialId,
            ],
            set: { scope, label: body.label ?? null, username: bindingUsername, credentialKey },
          })
          .run();
        // 绑定与直填值互斥（ADR-027）：绑定凭证 → 清掉该槽位的直填值
        await db
          .delete(schema.serverSlotValues)
          .where(and(eq(schema.serverSlotValues.serverId, id), eq(schema.serverSlotValues.slotName, body.slotName)))
          .run();
        // 绑定/换绑后实例键变化 → 旧实例回收（AC-67）；SSH 连接池也按资产回收（账号可能已变）
        for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        deps.ssh?.invalidate(id);
        await governanceAudit(audit, p, 'credential_bind', { serverId: id, slotName: body.slotName, credentialId: body.credentialId, scope, ...(bindingUsername ? { username: bindingUsername } : {}) });
        return reply.send({ code: 0, data: { serverId: id, slotName: body.slotName, scope }, message: 'ok' });
      },
    },
    {
      /**
       * 修改某条**自己的**绑定的属性：共享范围（asset ⇄ personal）与/或 SSH 登录用户名。
       * 复用 POST 会要求重新选凭证，而"只是想共享一下 / 改个账号"不该重选凭证；
       * 校验口径与 POST 完全一致：只能改自己的绑定、只有归属人/admin 能共享。
       */
      method: 'PATCH',
      url: '/api/v1/servers/:id/slots/:slotName',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, slotName } = req.params as { id: string; slotName: string };
        const p = req.principal!;
        const body = req.body as { shared?: boolean; credentialId?: string; username?: string | null; credentialKey?: string | null };
        if (typeof body.shared !== 'boolean' && body.username === undefined && body.credentialKey === undefined) {
          return reply.code(400).send({ code: 400, data: null, message: 'shared、username、credentialKey 至少提供一个' });
        }
        if (body.shared !== undefined && typeof body.shared !== 'boolean') {
          return reply.code(400).send({ code: 400, data: null, message: 'shared 必须是布尔值' });
        }
        if (!body.credentialId) {
          return reply.code(400).send({ code: 400, data: null, message: 'credentialId 必填（同一槽位可能有多条绑定）' });
        }
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset) return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        const row = await db
          .select()
          .from(schema.serverCredentials)
          .where(and(
            eq(schema.serverCredentials.serverId, id),
            eq(schema.serverCredentials.slotName, slotName),
            eq(schema.serverCredentials.userId, p.userId),
            eq(schema.serverCredentials.credentialId, body.credentialId),
          ))
          .get();
        if (!row) {
          return reply.code(404).send({ code: 404, data: null, message: '你没有该槽位的这条绑定记录' });
        }
        const isOwnerOrAdmin = asset.ownerId === p.userId || p.isAdmin;
        if (body.shared === true && !isOwnerOrAdmin) {
          return reply.code(400).send({ code: 400, data: null, message: '只有资产归属人或管理员可以把凭证共享给组内成员' });
        }
        // 只改传了的字段：PATCH 语义是"部分更新"，没传的不动
        const patch: { scope?: string; username?: string | null; credentialKey?: string | null } = {};
        if (typeof body.shared === 'boolean') patch.scope = body.shared ? 'asset' : 'personal';
        if (body.username !== undefined) {
          patch.username = typeof body.username === 'string' && body.username.trim() !== '' ? body.username.trim() : null;
        }
        if (body.credentialKey !== undefined) {
          const ck = normalizeCredentialKey(body.credentialKey);
          if (ck) {
            // 与 POST 同口径：指定了键就必须在该凭证里存在，否则运行期才炸
            const keys = deps.credentials?.valueKeysOf(body.credentialId) ?? [];
            if (!keys.includes(ck)) {
              return reply.code(400).send({
                code: 400,
                data: null,
                message: `凭证没有键 "${ck}"（可用：${keys.join('、') || '无'}）`,
              });
            }
          }
          patch.credentialKey = ck;
        }
        if (!deps.credentials) {
          return reply.code(500).send({ code: 500, data: null, message: '凭证服务未初始化' });
        }
        await db
          .update(schema.serverCredentials)
          .set(patch as never)
          .where(and(
            eq(schema.serverCredentials.serverId, id),
            eq(schema.serverCredentials.slotName, slotName),
            eq(schema.serverCredentials.userId, p.userId),
            eq(schema.serverCredentials.credentialId, body.credentialId),
          ))
          .run();
        // 共享范围/账号变化 → 他人取到的值或登录身份可能不同 → 实例与 SSH 连接全部失效
        for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        deps.ssh?.invalidate(id);
        await governanceAudit(audit, p, 'credential_bind', {
          serverId: id, slotName, credentialId: row.credentialId,
          ...(patch.scope !== undefined ? { scope: patch.scope, op: 'scope_change' } : {}),
          ...(patch.username !== undefined ? { username: patch.username, op: 'username_change' } : {}),
          ...(patch.credentialKey !== undefined ? { credentialKey: patch.credentialKey, op: 'key_change' } : {}),
        });
        return reply.send({ code: 0, data: { serverId: id, slotName, ...patch }, message: 'ok' });
      },
    },
    {
      method: 'PUT',
      url: '/api/v1/servers/:id/slots/:slotName/value',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, slotName } = req.params as { id: string; slotName: string };
        const p = req.principal!;
        const body = req.body as { value?: string };
        if (typeof body.value !== 'string') {
          return reply.code(400).send({ code: 400, data: null, message: 'value 必填（字符串）' });
        }
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset) return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        if (asset.ownerId !== p.userId && !p.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        const slotDefs = (asset.credentialSlots ?? []) as Array<{ name: string }>;
        if (!slotDefs.some((s) => s.name === slotName)) {
          return reply.code(400).send({ code: 400, data: null, message: `槽位 "${slotName}" 未定义` });
        }
        if (!deps.credentials) {
          return reply.code(500).send({ code: 500, data: null, message: '凭证服务未初始化' });
        }
        // 旧实例键失效（值变 → 指纹变 → 键变）——先按旧值算键再写
        for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        deps.credentials.setSlotValue(id, slotName, body.value, p.userId);
        for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        await governanceAudit(audit, p, 'credential_bind', { serverId: id, slotName, inline: true });
        return reply.send({ code: 0, data: { serverId: id, slotName }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/servers/:id/slots/:slotName/value',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, slotName } = req.params as { id: string; slotName: string };
        const p = req.principal!;
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset) return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        if (asset.ownerId !== p.userId && !p.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        if (!deps.credentials) {
          return reply.code(500).send({ code: 500, data: null, message: '凭证服务未初始化' });
        }
        for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        deps.credentials.clearSlotValue(id, slotName);
        for (const key of await serverInstanceKeys(db, id)) deps.pool?.invalidate(key);
        await governanceAudit(audit, p, 'credential_unbind', { serverId: id, slotName, inline: true });
        return reply.send({ code: 0, data: { serverId: id, slotName }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/servers/:id/instances',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset || !(await canOnAsset(db, 'view', p, asset))) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在或无权访问' });
        }
        if (!deps.pool) return reply.send({ code: 0, data: { instances: [] }, message: 'ok' });
        const instances = deps.pool.list().filter((x) => x.serverId === id);
        return reply.send({ code: 0, data: { instances }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/servers/:id/prewarm',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset || asset.ownerId !== p.userId && !p.isAdmin) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        }
        if (asset.executionMode !== 'mcp' || !deps.pool) {
          return reply.code(400).send({ code: 400, data: null, message: '仅 mcp 资产且实例池可用时可预热' });
        }
        const slots = ((asset.credentialSlots ?? []) as Array<{ name: string }>).map((x) => x.name);
        const resolved = deps.credentials ? deps.credentials.resolveSlotValues(asset.id, slots, p.userId) : [];
        const plan = buildPlan(
          { id: asset.id, configHash: asset.configHash, command: asset.command, args: asset.args ?? [], env: asset.env ?? {}, url: asset.url, headers: asset.headers ?? {}, transport: transportOf(asset.type), allowInsecureTls: asset.allowInsecureTls === true, resolveRef: makeRefResolver(deps.credentials ?? null), credentialSlots: (asset.credentialSlots ?? []) as never },
          resolved,
          deps.runtimeCredsDir ?? './data/runtime-creds',
        );
        await db.update(schema.servers).set({ prewarm: true }).where(eq(schema.servers.id, id)).run();
        await governanceAudit(audit, p, 'asset_prewarm', { serverId: id });
        const prewarmed = await deps.pool.prewarm(plan);
        return reply.send({ code: 0, data: { prewarmed }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/servers/:id/tools',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset || !(await canOnAsset(db, 'view', p, asset))) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在或无权访问' });
        }
        const f = (asset.toolFilters ?? {}) as { enabledTools?: string[]; disabledTools?: string[] };
        return reply.send({ code: 0, data: { enabledTools: f.enabledTools ?? [], disabledTools: f.disabledTools ?? [] }, message: 'ok' });
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/servers/:id/tools',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset || asset.ownerId !== p.userId && !p.isAdmin) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        }
        const body = req.body as { enabledTools?: string[]; disabledTools?: string[] };
        const prev = (asset.toolFilters ?? {}) as { enabledTools?: string[]; disabledTools?: string[] };
        const next = {
          enabledTools:
            body.enabledTools !== undefined
              ? body.enabledTools.filter((x) => typeof x === 'string' && x.length > 0)
              : prev.enabledTools ?? [],
          disabledTools:
            body.disabledTools !== undefined
              ? body.disabledTools.filter((x) => typeof x === 'string' && x.length > 0)
              : prev.disabledTools ?? [],
        };
        await db.update(schema.servers).set({ toolFilters: next as never }).where(eq(schema.servers.id, id)).run();
        await governanceAudit(audit, p, 'asset_tool_filters', { serverId: id, enabledTools: next.enabledTools, disabledTools: next.disabledTools });
        return reply.send({ code: 0, data: next, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/servers/:id/tools/raw',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const asset = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!asset || !(await canOnAsset(db, 'view', p, asset))) {
          return reply.code(404).send({ code: 404, data: null, message: '资产不存在或无权访问' });
        }
        if (asset.executionMode !== 'mcp') {
          // 内建（原生）资产没有远端 MCP，但要能看到"这个资产能用哪些工具"——
          // 工具由平台固定提供（按 category 过滤），不来自远端列表。
          const tools = (deps.nativeRegistry ?? [])
            .filter((t) => t.category === asset.category)
            .map((t) => ({ name: t.name, description: t.description }));
          return reply.send({ code: 0, data: { tools, source: 'native-builtin' }, message: 'ok' });
        }
        if (!deps.pool) return reply.code(503).send({ code: 503, data: null, message: '实例池未初始化' });
        const slots = ((asset.credentialSlots ?? []) as Array<{ name: string }>).map((x) => x.name);
        const resolved = deps.credentials ? deps.credentials.resolveSlotValues(asset.id, slots, p.userId) : [];
        const plan = buildPlan(
          { id: asset.id, configHash: asset.configHash, command: asset.command, args: asset.args ?? [], env: asset.env ?? {}, url: asset.url, headers: asset.headers ?? {}, transport: transportOf(asset.type), allowInsecureTls: asset.allowInsecureTls === true, resolveRef: makeRefResolver(deps.credentials ?? null), credentialSlots: (asset.credentialSlots ?? []) as never },
          resolved,
          deps.runtimeCredsDir ?? './data/runtime-creds',
        );
        const h = await deps.pool.acquire(plan, p.userId);
        try {
          const listed = await h.client.listTools();
          return reply.send({ code: 0, data: { tools: listed.tools.map((t) => ({ name: t.name, description: t.description ?? '' })) }, message: 'ok' });
        } finally {
          await h.release();
        }
      },
    },
  ];
}

export function makeCredentialRoutes(deps: AssetRoutesDeps): RouteDefinition[] {
  const { db, audit } = deps;  return [
    {
      method: 'GET',
      url: '/api/v1/credentials/candidates',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        // ADR-028 §2.2：绑定候选 = 仅本人凭证；admin 见全部（服务端绑定仍是真实边界，前端过滤只是体验）
        const p = req.principal!;
        const base = db
          .select({ id: schema.credentials.id, name: schema.credentials.name, kind: schema.credentials.kind, valueHint: schema.credentials.valueHint })
          .from(schema.credentials);
        const rows = p.isAdmin ? await base.all() : await base.where(eq(schema.credentials.ownerId, p.userId)).all();
        const queryAssetId = (req.query as { assetId?: string }).assetId;
        let boundBySlot = new Map<string, string>();
        if (queryAssetId) {
          // 只算"我自己"的绑定：否则会把他人的绑定误显示为"已绑"
          const b = await db
            .select({ slotName: schema.serverCredentials.slotName, credentialId: schema.serverCredentials.credentialId })
            .from(schema.serverCredentials)
            .where(and(eq(schema.serverCredentials.serverId, queryAssetId), eq(schema.serverCredentials.userId, p.userId)))
            .all();
          boundBySlot = new Map(b.map((x) => [x.slotName, x.credentialId]));
        }
        return reply.send({
          code: 0,
          data: rows.map((r) => ({
            ...r,
            // 键名（无值）——候选下拉按槽位键过滤：只有包含该槽位键的凭证才可选（防绑定后运行期必炸）
            keys: deps.credentials?.valueKeysOf(r.id) ?? [],
            boundSlots: [...boundBySlot.entries()].filter(([, cid]) => cid === r.id).map(([slot]) => slot),
          })),
          message: 'ok',
        });
      },
    },
    {
      // 凭证类型字典（T5 数据驱动）：前端据此渲染表单，新增类型无需改前端。
      // 只读、session 即可（不含任何凭据数据，仅结构描述）。
      method: 'GET',
      url: '/api/v1/credentials/types',
      accessMode: 'session',
      handler: async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ code: 0, data: CREDENTIAL_TYPES, message: 'ok' }),
    },
    {
      method: 'GET',
      url: '/api/v1/credentials',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const all = await db.select().from(schema.credentials);
        const warnThreshold = deps.settings.get<number>('general.credential_user_warn_threshold');
        const out = [];
        for (const c of all) {
          if (p.isAdmin || c.ownerId === p.userId || (await canUseCredentialFor(db, p, c))) out.push(c);
        }
        const enriched = [];
        const names = await ownerNameMap(db);
        for (const c of out) {
          const boundRows = await db
            .select({ serverId: schema.serverCredentials.serverId })
            .from(schema.serverCredentials)
            .where(eq(schema.serverCredentials.credentialId, c.id))
            .all();
          // 被引用数 = 去重后的资产数（一凭证绑同资产多槽位只算 1 个资产）
          const boundServers = new Set(boundRows.map((r) => r.serverId)).size;
          // 实际使用者（Spec §8.5）：绑定资产归属人去重（v1 可见性=owner，可见者即资产归属人）
          const boundUsers = await db
            .select({ owner: schema.servers.ownerId })
            .from(schema.serverCredentials)
            .innerJoin(schema.servers, eq(schema.servers.id, schema.serverCredentials.serverId))
            .where(eq(schema.serverCredentials.credentialId, c.id))
            .all();
          const actualUsers = new Set(boundUsers.map((u) => u.owner)).size;
          enriched.push({
            id: c.id, name: c.name, kind: c.kind, valueHint: c.valueHint, ownerId: c.ownerId,
            privileges: c.privileges,
            ownerName: c.ownerId ? (names.get(c.ownerId) ?? c.ownerId.slice(0, 8)) : '（无主）',
            createdAt: c.createdAt,
            // §4.2 实际使用者信号：绑定资产数作为代理指标，达阈值告警
            boundServers,
            actualUsers,
            usageWarning: boundServers >= warnThreshold ? `已绑定 ${boundServers} 个资产（≥阈值 ${warnThreshold}）` : null,
          });
        }
        return reply.send({ code: 0, data: enriched, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/credentials',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const body = req.body as { name?: string; kind?: string; values?: Record<string, string>; privileges?: string[] };
        if (!body.name || !body.values || Object.keys(body.values).length === 0) {
          return reply.code(400).send({ code: 400, data: null, message: 'name/values 必填' });
        }
        // ADR-028：privileges 仅展示性元信息；空数组 = 无等级
        const privileges = body.privileges ?? [];
        const allowedPriv = ['root', 'rw', 'wo', 'ro'];
        if (!Array.isArray(privileges) || privileges.some((x) => !allowedPriv.includes(x))) {
          return reply.code(400).send({ code: 400, data: null, message: `privileges 仅可选 ${allowedPriv.join('/')}` });
        }
        const kind = body.kind ?? 'env-values';
        if (!CRED_KINDS.includes(kind as never)) {
          return reply.code(400).send({ code: 400, data: null, message: `kind 仅支持 ${CRED_KINDS.join('|')}` });
        }
        // 结构性内容（kubeconfig / 私钥）保存前校验：坏格式在源头拦下，不留到下游"连不上"
        const valuesErr = validateCredentialValues(kind, body.values);
        if (valuesErr) return reply.code(400).send({ code: 400, data: null, message: valuesErr });
        // 空值/空白值在写入点丢弃：空凭证没有可用值，运行期所有槽位都会 fail-closed
        const cleaned = cleanValues(body.values);
        if (!cleaned) return reply.code(400).send({ code: 400, data: null, message: '至少提供一个非空值' });
        const id = `cred-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        const encrypted = encryptCredential(deps.cryptoKey, id, JSON.stringify(cleaned));
        const row = await db
          .insert(schema.credentials)
          .values({ id, name: body.name, kind, encryptedValues: encrypted, valueHint: hintOf(cleaned), ownerId: p.userId, privileges })
          .returning({ id: schema.credentials.id, name: schema.credentials.name })
          .get();
        return reply.send({ code: 0, data: row, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/credentials/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const c = await db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get();
        if (!c) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
        // ADR-028：owner / admin 可管理；被共享的凭证其分组内成员也可**查看**（只读，不能改值或共享）。
        // 此前只放行 owner，会让"共享了但成员看不到"与 ADR-028 直接矛盾。
        if (!(await canUseCredentialFor(db, p, c))) {
          return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        }
        const bound = await db
          .select({
            serverId: schema.servers.id,
            name: schema.servers.name,
            category: schema.servers.category,
            owner: schema.servers.ownerId,
            slotName: schema.serverCredentials.slotName,
            credentialKey: schema.serverCredentials.credentialKey,
          })
          .from(schema.serverCredentials)
          .innerJoin(schema.servers, eq(schema.servers.id, schema.serverCredentials.serverId))
          .where(eq(schema.serverCredentials.credentialId, id))
          .all();
        // 非归属人只看自己可见的资产：共享凭证的成员不应借详情页看到别人私有资产的清单
        const canManage = p.isAdmin || c.ownerId === p.userId;
        const shownBound: typeof bound = [];
        if (canManage) {
          shownBound.push(...bound);
        } else {
          for (const b of bound) {
            const srv = await db.select().from(schema.servers).where(eq(schema.servers.id, b.serverId)).get();
            if (srv && (await canOnAsset(db, 'view', p, srv))) shownBound.push(b);
          }
        }
        const actualUsers = new Set(shownBound.map((b) => b.owner)).size;
        // 同一资产可能绑定本凭证的多个槽位（username + password）→ 按资产去重，槽位列说明绑定位置
        const byServer = new Map<string, { serverId: string; name: string; category: string; slots: string[] }>();
        for (const b of shownBound) {
          const cur = byServer.get(b.serverId);
          if (cur) {
            if (!cur.slots.includes(b.slotName)) cur.slots.push(b.slotName);
          } else {
            byServer.set(b.serverId, { serverId: b.serverId, name: b.name, category: b.category, slots: [b.slotName] });
          }
        }
        const names = await ownerNameMap(db);
        // ADR-028：共享到的分组（凭证 owner 逐个开关）
        const shared = await db
          .select({ groupId: schema.credentialGroupShares.groupId, name: schema.groups.name })
          .from(schema.credentialGroupShares)
          .leftJoin(schema.groups, eq(schema.groups.id, schema.credentialGroupShares.groupId))
          .where(eq(schema.credentialGroupShares.credentialId, id))
          .all();
        /**
         * 哪些键正被资产槽位实际取用：与运行期 pickSlotValue 同一规则（导出为 resolveSlotKey），
         * 供编辑页在删除/改名键之前提示"删了这些槽位会取不到值"。
         * 只看当前用户可见的绑定，避免共享查看者借提示探测他人私有资产的槽位构成。
         */
        const currentValues = canManage ? (deps.credentials?.valuesOf(c.id) ?? {}) : {};
        const refByKey = new Map<string, Map<string, { serverId: string; name: string; slots: string[] }>>();
        if (canManage) {
          for (const b of shownBound) {
            const key = resolveSlotKey(currentValues, b.slotName, b.credentialKey);
            if (!key) continue;
            const servers = refByKey.get(key) ?? new Map<string, { serverId: string; name: string; slots: string[] }>();
            const cur = servers.get(b.serverId);
            if (cur) {
              if (!cur.slots.includes(b.slotName)) cur.slots.push(b.slotName);
            } else {
              servers.set(b.serverId, { serverId: b.serverId, name: b.name, slots: [b.slotName] });
            }
            refByKey.set(key, servers);
          }
        }
        const referencedKeys = [...refByKey.entries()]
          .map(([key, servers]) => ({ key, servers: [...servers.values()] }))
          .sort((a, b) => a.key.localeCompare(b.key));
        return reply.send({
          code: 0,
          data: {
            id: c.id, name: c.name, kind: c.kind, valueHint: c.valueHint,
            privileges: c.privileges,
            /** 当前用户是否可管理（改值/共享/删除）；false = 只读查看 */
            canManage,
            ownerId: c.ownerId, ownerName: c.ownerId ? (names.get(c.ownerId) ?? c.ownerId.slice(0, 8)) : '（无主）',
            updatedAt: c.updatedAt, actualUsers,
            boundServers: [...byServer.values()],
            sharedGroups: shared.map((s) => ({ groupId: s.groupId, name: s.name ?? s.groupId.slice(0, 8) })),
            /** 被槽位实际取用的键（key → 资产/槽位），编辑删除键时前端据此提示 */
            referencedKeys,
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/credentials/:id/reveal',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const c = await db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get();
        if (!c) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
        // 明文只给归属人与平台管理员（ADR-028 管理权 = 创建者 + admin）
        if (c.ownerId !== p.userId && !p.isAdmin) {
          return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        }
        const values = deps.credentials?.valuesOf(c.id);
        if (!values) {
          return reply.code(500).send({ code: 500, data: null, message: '凭证服务未初始化' });
        }
        // 揭示明文属敏感操作 → 治理审计留痕
        await governanceAudit(audit, p, 'credential_reveal', { credentialId: c.id, name: c.name, keys: Object.keys(values) });
        return reply.send({ code: 0, data: { id: c.id, values }, message: 'ok' });
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/credentials/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const row = await db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get();
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
        if (row.ownerId !== p.userId && !p.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        const body = req.body as { values?: Record<string, string>; name?: string; privileges?: string[] };
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) {
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!name) return reply.code(400).send({ code: 400, data: null, message: 'name 不能为空' });
          if (name.length > 128) return reply.code(400).send({ code: 400, data: null, message: 'name 不能超过 128 字符' });
          const dup = await db
            .select({ id: schema.credentials.id })
            .from(schema.credentials)
            .where(and(eq(schema.credentials.name, name), ne(schema.credentials.id, id)))
            .get();
          if (dup) return reply.code(400).send({ code: 400, data: null, message: `凭证名 "${name}" 已存在` });
          patch.name = name;
        }
        if (body.privileges !== undefined) {
          // ADR-028：privileges 仅展示性元信息，限定枚举，不参与授权
          const allowed = ['root', 'rw', 'wo', 'ro'];
          if (!Array.isArray(body.privileges) || body.privileges.some((x) => !allowed.includes(x))) {
            return reply.code(400).send({ code: 400, data: null, message: `privileges 仅可选 ${allowed.join('/')}` });
          }
          patch.privileges = body.privileges;
        }
        if (body.values !== undefined) {
          // 键集合整体替换（增/删/改名都走这里）。空集合显式失败：没有值的凭证运行期必然取不到值。
          const cleaned = cleanValues(body.values);
          if (!cleaned) return reply.code(400).send({ code: 400, data: null, message: '至少保留一个非空值' });
          const valuesErr = validateCredentialValues(row.kind, cleaned);
          if (valuesErr) return reply.code(400).send({ code: 400, data: null, message: valuesErr });
          // §4.2 副作用：updated_at 变 → 所有绑定资产实例失效重建（先按旧 updatedAt 计算并失效旧键）
          const boundServers = await db
            .select({ serverId: schema.serverCredentials.serverId })
            .from(schema.serverCredentials)
            .where(eq(schema.serverCredentials.credentialId, id))
            .all();
          for (const b of [...new Set(boundServers.map((x) => x.serverId))]) {
            for (const key of await serverInstanceKeys(db, b)) deps.pool?.invalidate(key);
          }
          patch.encryptedValues = encryptCredential(deps.cryptoKey, id, JSON.stringify(cleaned));
          patch.valueHint = hintOf(cleaned);
          patch.updatedAt = new Date();
          await governanceAudit(audit, p, 'credential_rotate', { credentialId: id, affectedServers: boundServers.length });
        }
        await db.update(schema.credentials).set(patch as never).where(eq(schema.credentials.id, id)).run();
        return reply.send({ code: 0, data: { id }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/credentials/:id/shares/:groupId',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        // ADR-028 §2.1：凭证 owner 按分组逐个开启共享；非 owner/admin → 403
        const { id, groupId } = req.params as { id: string; groupId: string };
        const p = req.principal!;
        const c = await db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get();
        if (!c) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
        if (c.ownerId !== p.userId && !p.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        const g = await db.select().from(schema.groups).where(eq(schema.groups.id, groupId)).get();
        if (!g) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        await db
          .insert(schema.credentialGroupShares)
          .values({ credentialId: id, groupId })
          .onConflictDoNothing()
          .run();
        await governanceAudit(audit, p, 'credential_share', { credentialId: id, groupId, enabled: true });
        return reply.send({ code: 0, data: { credentialId: id, groupId, shared: true }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/credentials/:id/shares/:groupId',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, groupId } = req.params as { id: string; groupId: string };
        const p = req.principal!;
        const c = await db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get();
        if (!c) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
        if (c.ownerId !== p.userId && !p.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        await db
          .delete(schema.credentialGroupShares)
          .where(and(eq(schema.credentialGroupShares.credentialId, id), eq(schema.credentialGroupShares.groupId, groupId)))
          .run();
        await governanceAudit(audit, p, 'credential_share', { credentialId: id, groupId, enabled: false });
        return reply.send({ code: 0, data: { credentialId: id, groupId, shared: false }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/credentials/:id/rotate',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        // §7 轮换别名：语义 = PATCH values（改值 → 实例失效）。必须提供 values（F-R6-9：空 body 曾 500）。
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const row = await db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get();
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
        if (row.ownerId !== p.userId && !p.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        const body = req.body as { values?: Record<string, string>; name?: string };
        if (!body.values || Object.keys(body.values).length === 0) {
          return reply.code(400).send({ code: 400, data: null, message: 'rotate 必须提供 values（至少一个值）' });
        }
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name;
        const queryBody = body as { values?: Record<string, string> };
        if (queryBody.values !== undefined) {
          const boundServers = await db.select({ serverId: schema.serverCredentials.serverId }).from(schema.serverCredentials).where(eq(schema.serverCredentials.credentialId, id)).all();
          for (const s of [...new Set(boundServers.map((x) => x.serverId))]) {
            for (const key of await serverInstanceKeys(db, s)) deps.pool?.invalidate(key);
          }
          patch.encryptedValues = encryptCredential(deps.cryptoKey, id, JSON.stringify(queryBody.values));
          patch.updatedAt = new Date();
          await governanceAudit(audit, p, 'credential_rotate', { credentialId: id, affectedServers: boundServers.length });
        }
        await db.update(schema.credentials).set(patch as never).where(eq(schema.credentials.id, id)).run();
        return reply.send({ code: 0, data: { id, rotated: true }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/credentials/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const row = await db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get();
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '凭证不存在' });
        if (row.ownerId !== req.principal!.userId && !req.principal!.isAdmin) return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        await db.delete(schema.serverCredentials).where(eq(schema.serverCredentials.credentialId, id)).run();
        await db.delete(schema.credentials).where(eq(schema.credentials.id, id)).run();
        return reply.send({ code: 0, data: { id }, message: 'ok' });
      },
    },
  ];
}

export function makeGroupRoutes(deps: AssetRoutesDeps): RouteDefinition[] {
  const { db, audit } = deps;

  /**
   * 成员可见的分组 = 我所在的分组 ∪ 我拥有资产的分组；admin 见全部。
   * 分组是组织单元而非业务授权（ADR-026），但「看得见哪些组织单元」本身是信息边界：
   * 让成员看到全部分组名与成员数，等于泄露组织架构与他人资产归属。
   */
  const visibleGroups = async (principal: { userId: string; isAdmin: boolean }) => {
    const all = await db.select().from(schema.groups);
    if (principal.isAdmin) return all;
    const myGroupIds = new Set(
      (await db.select({ groupId: schema.groupUsers.groupId }).from(schema.groupUsers).where(eq(schema.groupUsers.userId, principal.userId)).all())
        .map((r) => r.groupId),
    );
    const myOwned = new Set(
      (await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.ownerId, principal.userId)).all()).map((r) => r.id),
    );
    const myAssetGroupIds = new Set(
      (await db.select({ groupId: schema.groupServers.groupId, serverId: schema.groupServers.serverId }).from(schema.groupServers).all())
        .filter((r) => myOwned.has(r.serverId))
        .map((r) => r.groupId),
    );
    return all.filter((g) => myGroupIds.has(g.id) || myAssetGroupIds.has(g.id));
  };

  return [
    {
      method: 'GET',
      url: '/api/v1/groups',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const rows = await visibleGroups(req.principal!);
        return reply.send({ code: 0, data: rows, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/groups',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const body = req.body as { name?: string; description?: string; serverIds?: unknown };
        if (!body.name) return reply.code(400).send({ code: 400, data: null, message: 'name 必填' });
        // 建组即关联（用户 2026-11-20）：两个请求会留下"组已建、关联失败"的半成品，所以合并为一次事务。
        const rawIds = Array.isArray(body.serverIds) ? body.serverIds : [];
        const serverIds = [...new Set(rawIds.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, 500);

        // 先校验全部 id 存在：有一个不存在就整体失败，不创建只有部分资产的组
        if (serverIds.length > 0) {
          const found = await db
            .select({ id: schema.servers.id })
            .from(schema.servers)
            .where(inArray(schema.servers.id, serverIds))
            .all();
          const foundSet = new Set(found.map((r) => r.id));
          const missing = serverIds.filter((id) => !foundSet.has(id));
          if (missing.length > 0) {
            return reply.code(400).send({ code: 400, data: null, message: `资产不存在：${missing.join('、')}` });
          }
        }

        const row = db.transaction((tx) => {
          const g = tx
            .insert(schema.groups)
            .values({ name: body.name!, description: body.description ?? null })
            .returning({ id: schema.groups.id, name: schema.groups.name })
            .get();
          for (const sid of serverIds) {
            tx.insert(schema.groupServers).values({ groupId: g.id, serverId: sid }).onConflictDoNothing().run();
          }
          return g;
        });
        await audit.writeIntent({
          principal: req.principal!,
          asset: { id: 'groups', name: 'groups' },
          tool: 'system_setting',
          args: { op: 'create_group', name: body.name, serverCount: serverIds.length },
          risk: 'normal',
          status: 'success',
          action: 'group_change',
        });
        return reply.send({ code: 0, data: row, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/groups/:id/servers',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const body = req.body as { serverIds?: string[] };
        for (const sid of body.serverIds ?? []) {
          await db.insert(schema.groupServers).values({ groupId: id, serverId: sid }).onConflictDoNothing().run();
        }
        return reply.send({ code: 0, data: { groupId: id, count: (body.serverIds ?? []).length }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/groups/:id/users',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const body = req.body as { userIds?: string[] };
        for (const uid of body.userIds ?? []) {
          await db.insert(schema.groupUsers).values({ groupId: id, userId: uid }).onConflictDoNothing().run();
        }
        return reply.send({ code: 0, data: { groupId: id, count: (body.userIds ?? []).length }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/groups/:id/servers/:serverId',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, serverId } = req.params as { id: string; serverId: string };
        const p = req.principal!;
        const group = await db.select().from(schema.groups).where(eq(schema.groups.id, id)).get();
        if (!group) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        const removed = await db
          .delete(schema.groupServers)
          .where(and(eq(schema.groupServers.groupId, id), eq(schema.groupServers.serverId, serverId)))
          .run();
        if (removed.changes === 0) {
          return reply.code(404).send({ code: 404, data: null, message: '该资产不在本分组中' });
        }
        await governanceAudit(audit, p, 'group_change', { groupId: id, name: group.name, op: 'remove_asset', serverId });
        return reply.send({ code: 0, data: { id, serverId }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/groups/:id/users/:userId',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id, userId } = req.params as { id: string; userId: string };
        const p = req.principal!;
        const group = await db.select().from(schema.groups).where(eq(schema.groups.id, id)).get();
        if (!group) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        const removed = await db
          .delete(schema.groupUsers)
          .where(and(eq(schema.groupUsers.groupId, id), eq(schema.groupUsers.userId, userId)))
          .run();
        if (removed.changes === 0) {
          return reply.code(404).send({ code: 404, data: null, message: '该成员不在本分组中' });
        }
        await governanceAudit(audit, p, 'group_change', { groupId: id, name: group.name, op: 'remove_member', userId });
        return reply.send({ code: 0, data: { id, userId }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/groups/:id/metadata',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const group = await db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, id)).get();
        if (!group) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        const rows = await db
          .select({ key: schema.groupMetadata.key, value: schema.groupMetadata.value })
          .from(schema.groupMetadata)
          .where(eq(schema.groupMetadata.groupId, id));
        return reply.send({ code: 0, data: rows, message: 'ok' });
      },
    },
    {
      method: 'PUT',
      url: '/api/v1/groups/:id/metadata',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const group = await db.select().from(schema.groups).where(eq(schema.groups.id, id)).get();
        if (!group) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        const body = req.body as { items?: Array<{ key?: unknown; value?: unknown }> } | undefined;
        const items = body?.items;
        if (!Array.isArray(items) || items.length === 0) {
          return reply.code(400).send({ code: 400, data: null, message: 'items 必填且非空数组' });
        }
        for (const it of items) {
          if (typeof it?.key !== 'string' || it.key.length === 0) {
            return reply.code(400).send({ code: 400, data: null, message: 'key 必填且为非空字符串' });
          }
          if (typeof it?.value !== 'string') {
            return reply.code(400).send({ code: 400, data: null, message: `value 必填且为字符串（key="${it.key}"）` });
          }
        }
        for (const it of items as Array<{ key: string; value: string }>) {
          await db
            .insert(schema.groupMetadata)
            .values({ groupId: id, key: it.key, value: it.value })
            .onConflictDoUpdate({ target: [schema.groupMetadata.groupId, schema.groupMetadata.key], set: { value: it.value } })
            .run();
        }
        await governanceAudit(audit, p, 'group_change', { groupId: id, name: group.name, op: 'set_metadata', keys: (items as Array<{ key: string }>).map((i) => i.key) });
        return reply.send({ code: 0, data: { id, count: items.length }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/groups/:id/metadata',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const group = await db.select().from(schema.groups).where(eq(schema.groups.id, id)).get();
        if (!group) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        const key = (req.query as { key?: unknown }).key;
        if (typeof key !== 'string' || key.length === 0) {
          return reply.code(400).send({ code: 400, data: null, message: 'key 查询参数必填' });
        }
        const removed = await db
          .delete(schema.groupMetadata)
          .where(and(eq(schema.groupMetadata.groupId, id), eq(schema.groupMetadata.key, key)))
          .run();
        if (removed.changes === 0) {
          return reply.code(404).send({ code: 404, data: null, message: '该元信息不存在' });
        }
        await governanceAudit(audit, p, 'group_change', { groupId: id, name: group.name, op: 'delete_metadata', key });
        return reply.send({ code: 0, data: { id, key }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/groups/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const group = await db.select().from(schema.groups).where(eq(schema.groups.id, id)).get();
        if (!group) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        // 成员只能打开自己所在（或自己资产所属）的分组；否则 403（不用 404，避免猜 id 探测存在性）
        if (!p.isAdmin) {
          const visible = await visibleGroups(p);
          if (!visible.some((g) => g.id === id)) {
            return reply.code(403).send({ code: 403, data: null, message: '你不在该分组内，无权查看' });
          }
        }
        const servers = await db.select().from(schema.groupServers).where(eq(schema.groupServers.groupId, id));
        const users = await db.select().from(schema.groupUsers).where(eq(schema.groupUsers.groupId, id));
        // 明细（与 MCP view_group 同构）：成员用户名 + 资产（id/name/category）
        const memberRows = users.length > 0
          ? await db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, users.map((u) => u.userId)))
          : [];
        const allAssetRows = servers.length > 0
          ? await db.select({ id: schema.servers.id, name: schema.servers.name, category: schema.servers.category, ownerId: schema.servers.ownerId, visibility: schema.servers.visibility, sharedWithUserIds: schema.servers.sharedWithUserIds }).from(schema.servers).where(inArray(schema.servers.id, servers.map((s) => s.serverId)))
          : [];
        // 资产列表按 can('view') 过滤：组内资产不一定都对每位成员可见（可能仍是 owner-only）
        const assetRows: Array<{ id: string; name: string; category: string }> = [];
        for (const a of allAssetRows) {
          if (await canOnAsset(db, 'view', p, a)) assetRows.push({ id: a.id, name: a.name, category: a.category });
        }
        const metadataRows = await db
          .select({ key: schema.groupMetadata.key, value: schema.groupMetadata.value })
          .from(schema.groupMetadata)
          .where(eq(schema.groupMetadata.groupId, id));
        return reply.send({
          code: 0,
          data: {
            ...group,
            serverIds: assetRows.map((a) => a.id),
            userIds: users.map((u) => u.userId),
            // 成员名单属于组织信息：只对管理员展开，成员只拿人数
            members: p.isAdmin ? memberRows : [],
            memberCount: users.length,
            assets: assetRows,
            metadata: metadataRows,
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/groups/:id',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const group = await db.select().from(schema.groups).where(eq(schema.groups.id, id)).get();
        if (!group) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        const body = req.body as { name?: string; description?: string };
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) {
          if (!body.name || body.name.length > 64) {
            return reply.code(400).send({ code: 400, data: null, message: 'name 必填且 ≤64 字符' });
          }
          const dup = await db.select({ id: schema.groups.id }).from(schema.groups).where(and(eq(schema.groups.name, body.name), ne(schema.groups.id, id))).get();
          if (dup) return reply.code(400).send({ code: 400, data: null, message: `分组名 "${body.name}" 已存在` });
          patch.name = body.name;
        }
        if (body.description !== undefined) patch.description = body.description;
        if (Object.keys(patch).length === 0) {
          return reply.code(400).send({ code: 400, data: null, message: 'name/description 至少一项' });
        }
        patch.updatedAt = new Date();
        await db.update(schema.groups).set(patch as never).where(eq(schema.groups.id, id)).run();
        await governanceAudit(audit, p, 'group_change', { groupId: id, before: group.name, after: patch.name ?? group.name, op: 'update_group' });
        return reply.send({ code: 0, data: { id }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/groups/:id',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const group = await db.select().from(schema.groups).where(eq(schema.groups.id, id)).get();
        if (!group) return reply.code(404).send({ code: 404, data: null, message: '分组不存在' });
        await db.delete(schema.groupServers).where(eq(schema.groupServers.groupId, id)).run();
        await db.delete(schema.groupUsers).where(eq(schema.groupUsers.groupId, id)).run();
        await db.delete(schema.groups).where(eq(schema.groups.id, id)).run();
        await governanceAudit(audit, p, 'group_change', { groupId: id, name: group.name, op: 'delete_group' });
        return reply.send({ code: 0, data: { id }, message: 'ok' });
      },
    },
  ];
}
