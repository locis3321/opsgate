/**
 * Market 端点（ADR-025 / §5.3，v1 必修；batch-instantiate 不注册 → default-deny 403，决策 B）：
 * GET /market/catalog（q/category/page + addedCount 徽章）
 * GET /market/catalog/:key（条目 + 展开预览 + 自动识别槽位清单）
 * POST /market/instantiate（展开→槽位→绑凭证→落库→异步预热；missingSlots 不阻断；名称冲突 400；治理审计 asset_create）
 */
import { createHash } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import type { SettingsLike } from '../config/settings.js';
import type { InstancePool } from '../services/instancePool.js';
import type { CredentialService } from '../services/credentials.js';
import type { AuditService } from '../services/audit.js';
import { buildPlan, makeRefResolver, transportOf } from '../services/instancePlan.js';
import { assertUrlAllowed, SsrfError } from '../services/ssrf.js';
import {
  detectSlots,
  detectSlotsInConfig,
  expandConfig,
  type CatalogEntry,
} from '../services/marketCatalog.js';
import { categoryCounts, getEntry, listEntries, type MarketStatus } from '../db/marketEntries.js';
import { getReadme, type FetchImpl } from '../services/readmeFetcher.js';
import { normalizeTags } from '../services/assetTags.js';
import { governanceAudit } from './assets.js';
import type { RouteDefinition } from './registry.js';

export interface MarketDeps {
  db: BetterSQLite3Database<typeof schema>;
  settings: SettingsLike;
  pool: InstancePool;
  credentials: CredentialService;
  audit: AuditService;
  runtimeCredsDir: string;
  /** 测试注入：离线 README 抓取实现 */
  readmeFetchImpl?: FetchImpl;
}

export function makeMarketRoutes(deps: MarketDeps & { catalogEntries?: CatalogEntry[] }): RouteDefinition[] {
  const { db, settings, pool, credentials, audit } = deps;
  /** 测试注入优先；生产从 market_entries 表读（ADR-029） */
  const injected = deps.catalogEntries;
  /** 可见范围：管理员可见 draft，普通成员仅 verified；disabled 永不出现 */
  const statusesFor = (isAdmin: boolean): readonly MarketStatus[] =>
    isAdmin ? ['verified', 'draft'] : ['verified'];
  const entriesFor = (isAdmin: boolean): CatalogEntry[] =>
    injected ?? listEntries(db, statusesFor(isAdmin));
  const entryOf = (key: string, isAdmin: boolean): CatalogEntry | null =>
    injected?.find((e) => e.key === key) ?? getEntry(db, key, statusesFor(isAdmin));

  return [
    {
      method: 'GET',
      url: '/api/v1/market/categories',
      accessMode: 'session',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        // 分类从条目数据聚合，不再硬编码（ADR-029 §4）；disabled 条目不计入
        if (injected) {
          const counts = new Map<string, number>();
          for (const e of injected) for (const c of e.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
          const items = [...counts.entries()]
            .map(([category, count]) => ({ category, count }))
            .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
          return reply.send({ code: 0, data: items, message: 'ok' });
        }
        return reply.send({ code: 0, data: categoryCounts(db), message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/market/catalog/:key/readme',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const entry = entryOf(key, req.principal!.isAdmin);
        if (!entry) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        // 缓存状态需直接读行（getEntry 只返回 CatalogEntry，不含缓存字段）
        const row = db.select().from(schema.marketEntries).where(eq(schema.marketEntries.key, key)).get();
        const res = await getReadme(
          { db, ...(deps.readmeFetchImpl ? { fetchImpl: deps.readmeFetchImpl } : {}) },
          key,
          entry.repository,
          { cache: row?.readmeCache ?? null, fetchedAt: row?.readmeFetchedAt ?? null },
        );
        return reply.send({
          code: 0,
          data: {
            markdown: res.markdown,
            stale: res.stale,
            repository: entry.repository,
            fetchedAt: row?.readmeFetchedAt?.getTime() ?? null,
            ...(res.error ? { error: res.error } : {}),
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/market/catalog',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const q = req.query as { q?: string; category?: string; page?: string };
        const p = req.principal!;
        const page = Math.max(1, Number(q.page ?? '1') || 1);
        const filtered = entriesFor(p.isAdmin).filter(
          (e) =>
            (!q.q || e.displayName.toLowerCase().includes(q.q.toLowerCase()) || e.description.includes(q.q)) &&
            (!q.category || e.categories.includes(q.category)),
        );
        const items = [];
        for (const e of filtered.slice((page - 1) * 50, page * 50)) {
          const row = await db
            .select({ c: count() })
            .from(schema.servers)
            .where(and(eq(schema.servers.marketKey, e.key), eq(schema.servers.ownerId, p.userId)))
            .get();
          items.push({ key: e.key, name: e.name, displayName: e.displayName, description: e.description, repository: e.repository, categories: e.categories, tags: e.tags, runtime: e.runtime, executionMode: e.executionMode ?? 'mcp', addedCount: Number(row?.c ?? 0) });
        }
        return reply.send({ code: 0, data: { items, total: filtered.length, page }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/market/catalog/:key',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const entry = entryOf(key, req.principal!.isAdmin);
        if (!entry) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        // 已安装状态：当前用户从该条目创建过的资产数（复制 Market 列表口径）
        const added = await db
          .select({ c: count() })
          .from(schema.servers)
          .where(and(eq(schema.servers.marketKey, key), eq(schema.servers.ownerId, req.principal!.userId)))
          .get();
        return reply.send({
          code: 0,
          data: {
            ...entry,
            preview: expandConfig(entry),
            slots: detectSlots(entry),
            addedCount: Number(added?.c ?? 0),
          },
          message: 'ok',
        });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/market/instantiate',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const body = req.body as {
          pkgName?: string; name?: string; displayName?: string;
          credentialRefs?: Record<string, string | null>;
          /** 槽位直填值（ADR-027，非凭证）：与 credentialRefs 同槽位互斥，随创建一次落库 */
          inlineValues?: Record<string, string>;
          /** 自定义配置覆盖（管理端编辑过目录默认配置时传入；未传的字段沿用目录默认值） */
          config?: { command?: string; args?: string[]; env?: Record<string, string>; url?: string | null; headers?: Record<string, string> };
          /** 原生条目（executionMode='native'）：产品的管理 API 地址，由用户填写（无子进程、无配置可展开） */
          url?: string;
          /** 原生条目常在内网：与地址同批提交，避免"先建再改"两步（变更写治理审计） */
          allowPrivateNetwork?: boolean;
          /** 允许不安全 TLS（自签证书集群/面板）；默认 false */
          allowInsecureTls?: boolean;
          /**
           * 组织标签（可选）。**不**从目录条目的 tags 继承：那是社区 registry 元数据（如 database,sql），
           * 混进组织标签会污染 `?tag=` 收窄与分组筛选。
           */
          tags?: unknown;
        };
        if (!body.pkgName || !body.name) {
          return reply.code(400).send({ code: 400, data: null, message: 'pkgName/name 必填' });
        }
        if (/[^a-z0-9.-]/.test(body.name)) {
          return reply.code(400).send({ code: 400, data: null, message: 'name 需为小写字母/数字/-/. 的 DNS 名' });
        }
        const entry = entryOf(body.pkgName, p.isAdmin);
        if (!entry) return reply.code(404).send({ code: 404, data: null, message: '目录条目不存在' });
        const dup = await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.name, body.name)).get();
        if (dup) return reply.code(400).send({ code: 400, data: null, message: `资产名 "${body.name}" 已存在` });

        // 标签归一与 PATCH/POST 同口径（去空白/去重/限长限数）；不继承目录条目的 tags
        const tagsNorm = normalizeTags(body.tags ?? []);
        if ('error' in tagsNorm) return reply.code(400).send({ code: 400, data: null, message: tagsNorm.error });

        const isNativeEntry = entry.executionMode === 'native';
        // 原生条目：无配置可展开，地址由用户填写（该品类产品的管理 API 地址随部署而变，不能写死在目录里）。
        // 例外：redis / kafka 的地址可完全来自槽位（REDIS_HOST+REDIS_PORT / KAFKA_BROKERS），
        // 此时 url 可为空——与 services/{redis,kafka}Connection.ts 的解析优先级一致。
        const ADDRESS_OPTIONAL = ['redis', 'kafka'];
        const categoryOfEntry = entry.categories[0] ?? '';
        const addressOptional = ADDRESS_OPTIONAL.includes(categoryOfEntry);
        if (isNativeEntry) {
          const url = (body.url ?? '').trim();
          if (!url && !addressOptional) {
            return reply.code(400).send({ code: 400, data: null, message: '该条目为平台内建工具，需填写管理 API 地址（URL）' });
          }
          if (!url && addressOptional) {
            // 地址走槽位：必须至少有一个与地址相关的槽位被绑定/直填，否则建出来也连不上
            const addrSlots = Object.keys(entry.slotLabels ?? {}).filter((k) =>
              /HOST|PORT|BROKERS|ADDR|ADDRESS|URL/i.test(k),
            );
            const provided = addrSlots.some(
              (k) => body.credentialRefs?.[k] || (body.inlineValues?.[k] ?? '').trim() !== '',
            );
            if (!provided) {
              return reply.code(400).send({
                code: 400,
                data: null,
                message: `该条目为平台内建工具：需填写管理 API 地址，或在槽位 ${addrSlots.join(' / ')} 中提供地址`,
              });
            }
          }
          if (url) {
            try {
              await assertUrlAllowed(url, body.allowPrivateNetwork === true);
            } catch (err) {
              return reply.code(400).send({
                code: 400,
                data: null,
                message: `SSRF 校验失败：${err instanceof SsrfError ? err.message : String(err)}。若该地址确在内网，勾选「允许私网访问」后重试。`,
              });
            }
          }
        }

        const base = expandConfig(entry);
        const ov = body.config;
        const config = isNativeEntry
          ? { command: '', args: [], env: {}, url: (body.url ?? '').trim() || null, headers: {} }
          : ov
            ? {
                command: ov.command ?? base.command,
                args: ov.args ?? base.args,
                env: ov.env ?? base.env,
                url: ov.url !== undefined ? ov.url : base.url,
                headers: ov.headers ?? base.headers,
              }
            : base;
        // 槽位按**最终配置**识别（自定义配置改了 env/args/headers → 槽位随之变化）；原生条目按声明
        const slots = isNativeEntry ? detectSlots(entry) : detectSlotsInConfig(entry, config);
        const credentialSlots = slots.map((s) => ({
          target: s.target,
          name: s.name,
          label: s.label,
          file: s.file,
        }));
        const refs = (body.credentialRefs ?? {}) as Record<string, string | null>;
        // 凭证解析与实例键一致性（slot 额度校验）
        if (slots.length > settings.get<number>('credentials.max_slots')) {
          return reply.code(400).send({ code: 400, data: null, message: '凭证槽位数超过上限' });
        }
        const id = `srv-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20);
        const serverId = id;

        // 校验全部前置：任一失败直接 400，不落任何行（避免"创建了一半"的半成品资产）
        const bound: string[] = [];
        const missingSlots: string[] = [];
        const inlineValues = body.inlineValues ?? {};
        const inlineToWrite: Array<{ slotName: string; value: string }> = [];
        for (const s of slots) {
          const credRef = refs[s.name];
          const rawInline = inlineValues[s.name];
          const inlineValue = typeof rawInline === 'string' ? rawInline.trim() : '';
          if (credRef && inlineValue) {
            return reply.code(400).send({ code: 400, data: null, message: `槽位 ${s.name} 不能同时绑定凭证与填值（二者互斥）` });
          }
          if (credRef) {
            const cred = await db.select().from(schema.credentials).where(eq(schema.credentials.id, credRef)).get();
            if (!cred || (cred.ownerId !== p.userId && !p.isAdmin)) {
              return reply.code(400).send({ code: 400, data: null, message: `凭证 ${credRef} 不存在或非本人创建` });
            }
            bound.push(s.name);
            continue;
          }
          if (inlineValue) {
            inlineToWrite.push({ slotName: s.name, value: inlineValue });
            bound.push(s.name);
            continue;
          }
          missingSlots.push(s.name);
        }
        const credentialsSvc = credentials;
        if (inlineToWrite.length > 0 && !credentialsSvc) {
          return reply.code(500).send({ code: 500, data: null, message: '凭证服务未初始化，无法写入直填值' });
        }

        // 默认分组（条目声明）：不存在则自动创建，随资产一次落库。
        // 分组仍是自由组织单元（ADR-026 不按 category 自动归组），这里只是执行"条目作者声明的默认归属"。
        const defaultGroupName = entry.defaultGroup?.trim() ?? '';
        let defaultGroupId: string | null = null;
        if (defaultGroupName) {
          const existing = await db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.name, defaultGroupName)).get();
          defaultGroupId = existing?.id
            ?? (await db.insert(schema.groups).values({ name: defaultGroupName, description: `由 Market 条目「${entry.displayName}」自动创建` }).returning({ id: schema.groups.id }).get()).id;
        }

        // 单事务落库：资产 + 凭证绑定 + 直填值 + 默认分组，任一失败整体回滚（无半成品）。
        // setSlotValue 走同一 sqlite 连接且是同步写入，因此与上两步同属一个事务。
        db.transaction((tx) => {
          tx.insert(schema.servers)
            .values({
              id: serverId,
              name: body.name!,
              // 不给 displayName 就留空：条目标题（如 "Kubernetes MCP Server"）是**模板名**，
              // 不是这台机器的名字。写进 displayName 会让列表把两个不同资产显示成同一标题。
              displayName: body.displayName?.trim() ? body.displayName.trim() : null,
              description: entry.description,
              // 原生条目走HTTP原生工具（无子进程）；其余按有无 url 判 stdio/http
              type: isNativeEntry ? 'native' : config.url ? 'http' : 'stdio',
              executionMode: isNativeEntry ? 'native' : 'mcp',
              category: entry.categories[0] ?? 'other',
              command: isNativeEntry ? null : config.command || null,
              args: isNativeEntry ? null : config.args,
              env: isNativeEntry ? null : config.env,
              url: config.url,
              headers: isNativeEntry ? null : ((config.headers && Object.keys(config.headers).length > 0 ? config.headers : null) as object | null),
              ...(isNativeEntry && body.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
              ...(body.allowInsecureTls === true ? { allowInsecureTls: true } : {}),
              credentialSlots: credentialSlots as never[],
              tags: tagsNorm.tags,
              ownerId: p.userId,
              visibility: 'owner',
              sharedWithUserIds: [],
              configHash,
              marketKey: entry.key,
            })
            .run();
          for (const s of bound) {
            const credRef = refs[s];
            if (!credRef) continue;
            tx.insert(schema.serverCredentials)
              .values({ serverId, slotName: s, userId: p.userId, credentialId: credRef, scope: 'asset' })
              .onConflictDoNothing()
              .run();
          }
          if (defaultGroupId) {
            tx.insert(schema.groupServers)
              .values({ groupId: defaultGroupId, serverId })
              .onConflictDoNothing()
              .run();
          }
          for (const v of inlineToWrite) credentialsSvc!.setSlotValue(serverId, v.slotName, v.value, p.userId);
        });

        await governanceAudit(audit, p, 'asset_create', {
          serverId, marketKey: entry.key, name: body.name, bound, missingSlots,
          ...(isNativeEntry ? { executionMode: 'native', url: config.url, allowPrivateNetwork: body.allowPrivateNetwork === true } : {}),
          ...(defaultGroupName ? { defaultGroup: defaultGroupName } : {}),
        });

        // 异步预热：仅 MCP 资产有实例可预热（原生工具进程内直连，无实例）
        if (!isNativeEntry) {
          void (async () => {
            try {
              const resolved = credentials.resolveSlotValues(serverId, bound);
              const plan = buildPlan(
                { id: serverId, configHash, command: config.command || null, args: config.args, env: config.env, url: config.url, headers: config.headers, transport: transportOf(config.url ? 'http' : 'stdio'), allowInsecureTls: body.allowInsecureTls === true, resolveRef: makeRefResolver(credentials), credentialSlots: credentialSlots as never },
                resolved,
                deps.runtimeCredsDir,
              );
              await pool.prewarm(plan);
            } catch (err) {
              process.stderr.write(`[market] 预热失败: ${err instanceof Error ? err.message : String(err)}\n`);
            }
          })();
        }

        const row = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
        return reply.send({ code: 0, data: { server: row, bound, missingSlots, slots: slots.length }, message: 'ok' });
      },
    },
  ];
}
