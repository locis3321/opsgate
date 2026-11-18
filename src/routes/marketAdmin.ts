/**
 * Market 条目管理端点（ADR-029 / T4）：仅管理员。
 *
 * 与 `market.ts`（目录浏览 + 实例化）分开：那条链路面向所有登录用户且高频读取，
 * 这条只服务管理端，语义是"维护目录主数据"，混在一起会让 accessMode 和校验互相牵制。
 *
 * 状态机（ADR-029 §2）：draft → verified → disabled → verified（enable）。
 * 状态变更走专用端点而非 PATCH：PATCH 若允许改 status，容易在编辑表单里误把
 * 已停用条目悄悄复活。
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import {
  countAssetsFromEntry,
  deleteEntry,
  entryExists,
  getEntryRaw,
  insertEntry,
  updateEntry,
  type MarketStatus,
} from '../db/marketEntries.js';
import { detectSlots, expandConfig, type CatalogEntry } from '../services/marketCatalog.js';
import { computeUpgrade, fetchLatestVersion, parseVersionSource } from '../services/versionChecker.js';
import { extractPinnedVersion, updateVersionLatest } from '../db/marketEntries.js';
import type { FetchImpl } from '../services/readmeFetcher.js';
import { buildPlan, makeRefResolver, transportOf } from '../services/instancePlan.js';
import type { InstancePool } from '../services/instancePool.js';
import type { AuditService } from '../services/audit.js';
import { governanceAudit } from './assets.js';
import type { RouteDefinition } from './registry.js';

export interface MarketAdminDeps {
  db: BetterSQLite3Database<typeof schema>;
  pool?: InstancePool;
  audit: AuditService;
  runtimeCredsDir: string;
  /** 测试注入：离线 HTTP 实现（版本检测用） */
  fetchImpl?: FetchImpl;
}

/** 条目 key 约定：小写字母/数字/连字符/点，与资产名同族（便于对读） */
const KEY_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;
/** 运行时枚举；新增运行时须同时补 expandConfig 的安装分支 */
const RUNTIMES = ['npm', 'pypi'] as const;

interface EntryBody {
  key?: string;
  name?: string;
  displayName?: string;
  description?: string;
  repository?: string;
  categories?: unknown;
  tags?: unknown;
  runtime?: string;
  slotLabels?: unknown;
  /** 默认分组名：从该条目创建的资产自动加入（不存在则创建） */
  defaultGroup?: string | null;
  installations?: unknown;
  /** 执行分层：native = 网关内建 HTTP 工具（无子进程、无安装配置） */
  executionMode?: 'mcp' | 'native';
  readmeUrl?: string | null;
  versionPinned?: string | null;
  /** 仅用于检测非法传入：PATCH 不允许改状态，由专用端点负责 */
  status?: string;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** 校验安装配置：每个 runtime 分支必须是 {command?,args?,env?,url?,headers?} 且类型正确 */
function validateInstallations(
  v: unknown,
): { ok: true; value: CatalogEntry['installations'] } | { ok: false; message: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, message: 'installations 必须是对象（键为运行时名）' };
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [runtime, inst] of Object.entries(v as Record<string, unknown>)) {
    if (!(RUNTIMES as readonly string[]).includes(runtime)) {
      return { ok: false, message: `installations 键 ${runtime} 不受支持（仅 ${RUNTIMES.join('|')}）` };
    }
    if (typeof inst !== 'object' || inst === null || Array.isArray(inst)) {
      return { ok: false, message: `installations.${runtime} 必须是对象` };
    }
    const o = inst as Record<string, unknown>;
    if (o.command !== undefined && typeof o.command !== 'string') {
      return { ok: false, message: `installations.${runtime}.command 必须是字符串` };
    }
    if (o.args !== undefined && !isStringArray(o.args)) {
      return { ok: false, message: `installations.${runtime}.args 必须是字符串数组` };
    }
    for (const k of ['env', 'headers'] as const) {
      const val = o[k];
      if (val === undefined) continue;
      if (typeof val !== 'object' || val === null || Array.isArray(val)) {
        return { ok: false, message: `installations.${runtime}.${k} 必须是对象` };
      }
      if (!Object.values(val as Record<string, unknown>).every((x) => typeof x === 'string')) {
        return { ok: false, message: `installations.${runtime}.${k} 的值必须是字符串` };
      }
    }
    if (o.url !== undefined && o.url !== null && typeof o.url !== 'string') {
      return { ok: false, message: `installations.${runtime}.url 必须是字符串或 null` };
    }
    out[runtime] = o;
  }
  return { ok: true, value: out as CatalogEntry['installations'] };
}

/** 从 body 组装 CatalogEntry（新增用：字段必须齐全） */
function buildEntry(
  body: EntryBody,
): { ok: true; entry: CatalogEntry } | { ok: false; message: string } {
  if (!body.key || !KEY_RE.test(body.key)) {
    return { ok: false, message: 'key 必填，且需为小写字母/数字/连字符/点（≤63）' };
  }
  if (!body.name) return { ok: false, message: 'name 必填' };
  if (!body.displayName) return { ok: false, message: 'displayName 必填' };
  if (!body.repository) return { ok: false, message: 'repository 必填' };
  if (!body.runtime || !(RUNTIMES as readonly string[]).includes(body.runtime)) {
    return { ok: false, message: `runtime 必填，仅 ${RUNTIMES.join('|')}` };
  }
  if (!isStringArray(body.categories) || body.categories.length === 0) {
    return { ok: false, message: 'categories 必须是非空字符串数组' };
  }
  if (body.tags !== undefined && !isStringArray(body.tags)) {
    return { ok: false, message: 'tags 必须是字符串数组' };
  }
  if (body.slotLabels !== undefined && body.slotLabels !== null) {
    const sl = body.slotLabels;
    if (typeof sl !== 'object' || Array.isArray(sl)) {
      return { ok: false, message: 'slotLabels 必须是对象' };
    }
    if (!Object.values(sl as Record<string, unknown>).every((x) => typeof x === 'string')) {
      return { ok: false, message: 'slotLabels 的值必须是字符串' };
    }
  }
  const inst = validateInstallations(body.installations);
  if (!inst.ok) return { ok: false, message: inst.message };
  const branch = inst.value[body.runtime];
  if (!branch) {
    return { ok: false, message: `installations 缺少 runtime=${body.runtime} 的配置` };
  }
  // 原生条目没有可执行配置：工具由网关实现，地址由建资产时填写（见 market.ts instantiate）
  if (body.executionMode !== 'native' && !branch.command && !branch.url) {
    return { ok: false, message: `installations.${body.runtime} 需 command（stdio）或 url（HTTP/SSE）` };
  }
  if (body.executionMode === 'native' && !body.slotLabels) {
    return { ok: false, message: '原生条目的凭证槽位来自 slotLabels，必须声明（可先留空对象）' };
  }

  return {
    ok: true,
    entry: {
      key: body.key,
      name: body.name,
      displayName: body.displayName,
      description: body.description ?? '',
      repository: body.repository,
      categories: body.categories,
      tags: body.tags ?? [],
      runtime: body.runtime as CatalogEntry['runtime'],
      ...(body.executionMode === 'native' ? { executionMode: 'native' as const } : {}),
      ...(body.slotLabels ? { slotLabels: body.slotLabels as Record<string, string> } : {}),
      ...(typeof body.defaultGroup === 'string' && body.defaultGroup.trim()
        ? { defaultGroup: body.defaultGroup.trim() }
        : {}),
      installations: inst.value,
    },
  };
}

export function makeMarketAdminRoutes(deps: MarketAdminDeps): RouteDefinition[] {
  const { db, pool, audit, runtimeCredsDir } = deps;

  /** market_entries 行 → CatalogEntry（probeEntry 与 verify 共用，避免两处映射漂移） */
  function entryOfRow(row: NonNullable<ReturnType<typeof getEntryRaw>>): CatalogEntry {
    return {
      key: row.key,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      repository: row.repository,
      categories: row.categories,
      tags: row.tags,
      runtime: row.runtime as CatalogEntry['runtime'],
      ...(row.executionMode === 'native' ? { executionMode: 'native' as const } : {}),
      ...(row.slotLabels ? { slotLabels: row.slotLabels } : {}),
      ...(row.defaultGroup ? { defaultGroup: row.defaultGroup } : {}),
      installations: row.installations as CatalogEntry['installations'],
    };
  }

  /**
   * 现场拉起条目子进程并 listTools（发布前信心锚点，T3）。
   * 不写凭证：槽位保持占位符，命令原样执行（用于验证"能起来且能列工具"）。
   * 返回 error 描述而不抛，让调用方决定是回包还是拒绝发布。
   */
  async function probeEntry(row: NonNullable<ReturnType<typeof getEntryRaw>>, userId: string): Promise<{ ok: true; tools: number; slots: string[]; note?: string } | { ok: false; error: string }> {
    const entry = entryOfRow(row);
    const slots = detectSlots(entry);
    // 原生条目没有子进程可拉起：工具由网关实现，地址在**建资产时**填写。
    // 这里不启动任何东西——真正的连通性要在资产详情页用真实地址+凭证测。
    if (entry.executionMode === 'native') {
      return {
        ok: true,
        tools: 0,
        slots: slots.map((s) => s.name),
        note: '平台内建工具：无子进程可探测。真实连通性请在资产详情页填写地址并绑定凭证后测试。',
      };
    }
    const config = expandConfig(entry);
    const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20);
    if (!pool) return { ok: false, error: '实例池未初始化，无法执行连通测试' };
    try {
      const plan = buildPlan(
        {
          id: `market-test-${row.key}`,
          configHash,
          command: config.command || null,
          args: config.args,
          env: config.env,
          url: config.url,
          headers: config.headers,
          transport: transportOf(config.url ? 'http' : 'stdio'),
          allowInsecureTls: false, // 条目探测不关校验（条目本身无资产级开关）
          resolveRef: makeRefResolver(null),
          // 未绑定槽位的注入项会被 buildPlan 直接省略（不留空值），
          // 因此这里的语义就是"只验证命令能不能起来"，缺哪个变量由子进程自己报。
          credentialSlots: slots.map((s) => ({ target: s.target, name: s.name, label: s.label, file: s.file })),
        },
        [],
        runtimeCredsDir,
      );
      const h = await pool.acquire(plan, userId);
      try {
        const tools = await h.client.listTools();
        return { ok: true, tools: tools.tools.length, slots: slots.map((s) => s.name) };
      } finally {
        await h.release();
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // 有槽位时，启动失败大概率是「占位符没被替换」——明确告诉用户下一步怎么做，
      // 不要让用户对着 zod 校验尾巴猜。
      const hint = slots.length > 0
        ? `\n\n提示：该条目有 ${slots.length} 个凭证槽位（${slots.map((s) => s.name).join('/')}），`
          + '条目测试不提供凭证值（占位符原样传入）。\n'
          + '若失败原因与这些变量有关，说明需要真实凭证：请先在 Market 详情「添加并绑定」创建资产并绑定凭证，再到资产详情做连通性测试。'
        : '';
      return { ok: false, error: raw + hint };
    }
  }

  return [
    {
      method: 'GET',
      url: '/api/v1/market/entries',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const q = req.query as { status?: string; category?: string };
        let rows = db.select().from(schema.marketEntries).all();
        if (q.status) rows = rows.filter((r) => r.status === q.status);
        if (q.category) {
          rows = rows.filter((r) => (r.categories as string[]).includes(q.category!));
        }
        rows.sort((a, b) => a.key.localeCompare(b.key));
        return reply.send({
          code: 0,
          data: rows.map((r) => ({
            key: r.key,
            name: r.name,
            displayName: r.displayName,
            description: r.description,
            repository: r.repository,
            categories: r.categories,
            tags: r.tags,
            runtime: r.runtime,
            status: r.status,
            readmeUrl: r.readmeUrl,
            versionPinned: r.versionPinned,
            versionLatest: r.versionLatest,
            ...computeUpgrade(r.versionPinned, r.versionLatest),
            readmeFetchedAt: r.readmeFetchedAt?.getTime() ?? null,
            updatedAt: r.updatedAt.getTime(),
            assetCount: countAssetsFromEntry(db, r.key),
          })),
          message: 'ok',
        });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/market/entries/:key',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const row = getEntryRaw(db, key);
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        return reply.send({
          code: 0,
          data: {
            key: row.key,
            name: row.name,
            displayName: row.displayName,
            description: row.description,
            repository: row.repository,
            categories: row.categories,
            tags: row.tags,
            runtime: row.runtime,
            slotLabels: row.slotLabels,
            defaultGroup: row.defaultGroup,
            installations: row.installations,
            status: row.status,
            readmeUrl: row.readmeUrl,
            versionPinned: row.versionPinned,
            versionLatest: row.versionLatest,
            ...computeUpgrade(row.versionPinned, row.versionLatest),
            assetCount: countAssetsFromEntry(db, row.key),
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/market/entries',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const body = req.body as EntryBody;
        const built = buildEntry(body);
        if (!built.ok) return reply.code(400).send({ code: 400, data: null, message: built.message });
        if (entryExists(db, built.entry.key)) {
          return reply.code(409).send({ code: 409, data: null, message: `条目 key "${built.entry.key}" 已存在` });
        }
        // 新建条目默认 draft：未经验证不得出现在成员目录中（ADR-029 §2）
        const status: MarketStatus = 'draft';
        insertEntry(db, built.entry, status);
        await governanceAudit(audit, req.principal!, 'market_entry_create', {
          key: built.entry.key,
          runtime: built.entry.runtime,
          categories: built.entry.categories,
        });
        return reply.code(201).send({ code: 0, data: { key: built.entry.key, status }, message: 'ok' });
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/market/entries/:key',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const existing = getEntryRaw(db, key);
        if (!existing) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        const body = req.body as EntryBody;
        if (body.status !== undefined) {
          return reply.code(400).send({
            code: 400,
            data: null,
            message: 'status 不能通过 PATCH 修改，请使用 /verify /disable /enable',
          });
        }
        if (body.key !== undefined && body.key !== key) {
          return reply.code(400).send({ code: 400, data: null, message: 'key 不可修改' });
        }
        if (body.runtime !== undefined && !(RUNTIMES as readonly string[]).includes(body.runtime)) {
          return reply.code(400).send({ code: 400, data: null, message: `runtime 仅 ${RUNTIMES.join('|')}` });
        }
        if (body.categories !== undefined && (!isStringArray(body.categories) || body.categories.length === 0)) {
          return reply.code(400).send({ code: 400, data: null, message: 'categories 必须是非空字符串数组' });
        }
        if (body.tags !== undefined && !isStringArray(body.tags)) {
          return reply.code(400).send({ code: 400, data: null, message: 'tags 必须是字符串数组' });
        }
        if (body.slotLabels !== undefined && body.slotLabels !== null) {
          const sl = body.slotLabels;
          if (typeof sl !== 'object' || Array.isArray(sl) || !Object.values(sl as Record<string, unknown>).every((x) => typeof x === 'string')) {
            return reply.code(400).send({ code: 400, data: null, message: 'slotLabels 必须是字符串值对象' });
          }
        }
        let installations: CatalogEntry['installations'] | undefined;
        if (body.installations !== undefined) {
          const inst = validateInstallations(body.installations);
          if (!inst.ok) return reply.code(400).send({ code: 400, data: null, message: inst.message });
          installations = inst.value;
          const runtime = body.runtime ?? existing.runtime;
          const branch = installations[runtime];
          if (!branch) {
            return reply.code(400).send({
              code: 400,
              data: null,
              message: `installations 缺少 runtime=${runtime} 的配置`,
            });
          }
          const nextMode = body.executionMode ?? existing.executionMode;
          if (nextMode !== 'native' && !branch.command && !branch.url) {
            return reply.code(400).send({
              code: 400,
              data: null,
              message: `installations.${runtime} 需 command（stdio）或 url（HTTP/SSE）`,
            });
          }
        }
        // installations / runtime 变了就必须重算锁定版本：versionPinned 是从 args 里解析出来的
        // 派生值，若留旧值，升级提示会拿错误的"当前版本"与上游比对（误报或漏报）。
        const runtimeChanged = body.runtime !== undefined && body.runtime !== existing.runtime;
        const derivedPinned =
          installations !== undefined || runtimeChanged
            ? extractPinnedVersion(
                (installations ?? existing.installations) as CatalogEntry['installations'],
                body.runtime ?? existing.runtime,
              )
            : undefined;
        updateEntry(db, key, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.repository !== undefined ? { repository: body.repository } : {}),
          ...(body.categories !== undefined ? { categories: body.categories } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
          ...(body.slotLabels !== undefined ? { slotLabels: body.slotLabels as Record<string, string> | null } : {}),
          ...(body.defaultGroup !== undefined
            ? { defaultGroup: typeof body.defaultGroup === 'string' && body.defaultGroup.trim() ? body.defaultGroup.trim() : null }
            : {}),
          ...(installations !== undefined ? { installations } : {}),
          ...(body.executionMode !== undefined ? { executionMode: body.executionMode } : {}),
          ...(body.readmeUrl !== undefined ? { readmeUrl: body.readmeUrl } : {}),
          // 显式传值优先（管理员手工覆盖）；否则用从配置重算的结果
          ...(body.versionPinned !== undefined
            ? { versionPinned: body.versionPinned }
            : derivedPinned !== undefined
              ? { versionPinned: derivedPinned }
              : {}),
        });
        await governanceAudit(audit, req.principal!, 'market_entry_update', {
          key,
          fields: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined),
        });

        // 分类变更 → 同步派生资产（2026-11-17 用户决策：不能自动更新吗）。
        // category 参与规则匹配（asset_type）与列表筛选，条目改了却让已建资产留在旧分类，
        // 是"配置改完看起来生效、实际存量没跟上"的典型。这里同步并返回受影响数量。
        // 只同步 category 本身；已固化的 command/env/args 快照仍不联动（AC-68：条目不是运行时依赖）。
        let syncedAssets = 0;
        const nextCategory = body.categories?.[0];
        const prevCategory = existing.categories[0];
        if (nextCategory !== undefined && nextCategory !== prevCategory) {
          const affected = db
            .select({ id: schema.servers.id })
            .from(schema.servers)
            .where(eq(schema.servers.marketKey, key))
            .all();
          if (affected.length > 0) {
            db.transaction((tx) => {
              for (const a of affected) {
                tx.update(schema.servers).set({ category: nextCategory } as never).where(eq(schema.servers.id, a.id)).run();
              }
            });
            syncedAssets = affected.length;
            await governanceAudit(audit, req.principal!, 'market_entry_update', {
              key, op: 'category_sync', from: prevCategory ?? null, to: nextCategory, affectedAssets: syncedAssets,
            });
          }
        }
        return reply.send({ code: 0, data: { key, syncedAssets }, message: 'ok' });
      },
    },
    {
      method: 'DELETE',
      url: '/api/v1/market/entries/:key',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        if (!entryExists(db, key)) {
          return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        }
        const refs = countAssetsFromEntry(db, key);
        if (refs > 0) {
          return reply.code(409).send({
            code: 409,
            data: null,
            message: `该条目已被 ${refs} 个资产引用，无法删除；可改为停用（disabled）`,
          });
        }
        deleteEntry(db, key);
        await governanceAudit(audit, req.principal!, 'market_entry_delete', { key });
        return reply.send({ code: 0, data: { key }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/market/entries/:key/test',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const row = getEntryRaw(db, key);
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        const probe = await probeEntry(row, req.principal!.userId);
        if (!probe.ok) {
          return reply.send({ code: 0, data: { ok: false, error: probe.error }, message: 'ok' });
        }
        return reply.send({
          code: 0,
          data: { ok: true, tools: probe.tools, slots: probe.slots, ...(probe.note ? { note: probe.note } : {}) },
          message: 'ok',
        });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/market/entries/:key/check-version',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const row = getEntryRaw(db, key);
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        const source = parseVersionSource(row.repository);
        if (!source) {
          return reply.code(400).send({
            code: 400,
            data: null,
            message: '该条目仓库地址不属于可查询版本的来源（PyPI/npm/GitHub）',
          });
        }
        const pinned = row.versionPinned ?? extractPinnedVersion(row.installations, row.runtime);
        try {
          const latest = await fetchLatestVersion(source, deps.fetchImpl ?? (fetch as unknown as FetchImpl));
          updateVersionLatest(db, key, latest);
          await governanceAudit(audit, req.principal!, 'market_entry_check_version', { key, pinned, latest });
          return reply.send({ code: 0, data: computeUpgrade(pinned, latest), message: 'ok' });
        } catch (err) {
          // 检测失败不写库、不伪装成功（T6 决策）
          return reply.send({
            code: 0,
            data: { ...computeUpgrade(pinned, row.versionLatest), error: err instanceof Error ? err.message : String(err) },
            message: 'ok',
          });
        }
      },
    },
    // 发布（verify）是信心锚点：必须现场连通测试通过才允许 draft→verified（T3）。
    {
      method: 'POST',
      url: '/api/v1/market/entries/:key/verify',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const row = getEntryRaw(db, key);
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        if (row.status !== 'draft') {
          return reply.code(409).send({ code: 409, data: null, message: `当前状态 ${row.status} 不允许执行 verify` });
        }
        // 现场探测：与条目测试同语义（只验证命令能启动，占位符原样传入）。
        // 发布 = 让普通成员可见，必须可用；但"需要凭证才能验证"不应成为发布阻塞——
        // 否则带必填槽位的条目永远发不出去（用户实测踩到）。因此：
        //   · 探测通过 → 直接发布，标注已做连通验证
        //   · 探测失败且条目有槽位 → 仍允许发布，但在响应与审计里显式标注"未做凭证级验证"
        //   · 探测失败且无槽位 → 拒绝发布（无凭证可赖，就是配置错）
        const slots = detectSlots(entryOfRow(row));
        const probe = await probeEntry(row, req.principal!.userId);
        const blockedByCredential = !probe.ok && slots.length > 0;
        if (!probe.ok && !blockedByCredential) {
          return reply.code(409).send({
            code: 409,
            data: { tested: false, error: probe.error },
            message: `发布前连通测试未通过，已拒绝发布：${probe.error}`,
          });
        }
        updateEntry(db, key, { status: 'verified' });
        await governanceAudit(audit, req.principal!, 'market_entry_verify', {
          key,
          from: row.status,
          to: 'verified',
          ...(probe.ok ? { probeTools: probe.tools } : { verifiedWithoutCredential: true, slotNames: slots.map((s) => s.name) }),
        });
        return reply.send({
          code: 0,
          data: probe.ok
            ? { key, status: 'verified', tested: true, tools: probe.tools, ...(probe.note ? { note: probe.note } : {}) }
            : {
                key,
                status: 'verified',
                tested: false,
                reason: 'needs-credential',
                slots: slots.map((s) => s.name),
                message: '已发布。该条目含凭证槽位，发布阶段未做凭证级连通验证；实际可用性请在资产详情绑定凭证后测试。',
              },
          message: 'ok',
        });
      },
    },
    ...(['disable', 'enable'] as const).map(
      (action): RouteDefinition => ({
        method: 'POST',
        url: `/api/v1/market/entries/:key/${action}`,
        accessMode: 'admin',
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { key } = req.params as { key: string };
          const row = getEntryRaw(db, key);
          if (!row) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
          const next: MarketStatus = action === 'disable' ? 'disabled' : 'verified';
          // 状态机白名单：verified→disabled / disabled→verified
          const allowed: Record<string, MarketStatus[]> = {
            disable: ['verified'],
            enable: ['disabled'],
          };
          if (!allowed[action]!.includes(row.status as MarketStatus)) {
            return reply.code(409).send({
              code: 409,
              data: null,
              message: `当前状态 ${row.status} 不允许执行 ${action}`,
            });
          }
          updateEntry(db, key, { status: next });
          await governanceAudit(audit, req.principal!, `market_entry_${action}`, {
            key,
            from: row.status,
            to: next,
          });
          return reply.send({ code: 0, data: { key, status: next }, message: 'ok' });
        },
      }),
    ),
  ];
}
