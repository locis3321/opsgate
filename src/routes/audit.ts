/**
 * 审计查询端点（§4.5/§7）：列表（跨月分表拼接）/ 详情 / 统计（audit_stats_hourly 聚合）。
 * 分表约定：audit_log_YYYY_MM；跨月查询由 service 层拼接，调用方不感知（project-rules §5）。
 */
import type { Database } from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SettingsLike } from '../config/settings.js';
import { GOVERNANCE_ACTIONS } from '../config/constants.js';
import { can } from '../services/authorize.js';
import type { RouteDefinition } from './registry.js';

export function makeAuditRoutes(sqlite: Database, settings: SettingsLike | null = null): RouteDefinition[] {
  const retentionMonths = (): number =>
    settings ? settings.get<number>('audit.retention_months') : 6;
  const auditTables = (): string[] =>
    (sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'audit_log_%'")
      .all() as Array<{ name: string }>)
      .map((r) => r.name)
      .sort()
      .reverse()
      .filter((name) => {
        // AC-14 边界：仅扫保留期内分表（归档作业 v1 遗留，表级过滤先行消费 retention_months）
        const m = /audit_log_(\d{4})_(\d{2})$/.exec(name);
        if (!m) return false;
        const d = new Date();
        const months = (Number(d.getFullYear()) - Number(m[1])) * 12 + (Number(d.getMonth()) + 1 - Number(m[2]));
        return months < retentionMonths();
      });

  return [
    {
      method: 'GET',
      url: '/api/v1/audit',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const q = req.query as {
          page?: string; userId?: string; serverId?: string; tool?: string;
          status?: string; risk?: string; from?: string; to?: string; action?: string; actions?: string;
          scope?: string;
        };
        const page = Math.max(1, Number(q.page ?? '1') || 1);
        // 每页 20 条（2026-11-18 用户决策）：审计行较高（时间/用户/资产/工具/动作/风险/状态），
        // 50 条一页要滚很久且筛选条被顶出视口。20 条让整页在一屏内可扫。
        const pageSize = 20;
        // 审计的信息边界：成员只看自己的（谁做的 / 用谁的 Key），管理员看全部。
        // 忽略前端传入的 userId —— 否则成员换个 query 就能看别人的操作记录。
        const effectiveQ = p.isAdmin ? q : { ...q, userId: p.userId };
        const filters = buildFilters(effectiveQ);
        const extra = [filters.fromTs !== null ? `ts >= ${filters.fromTs}` : null, filters.toTs !== null ? `ts <= ${filters.toTs}` : null]
          .filter((clause): clause is string => clause !== null);
        // 跨月分表拼接：每表各取 (page*pageSize) 条再归并，保证第 N 页跨表也正确
        const perTable = page * pageSize;
        const rows: Array<Record<string, unknown>> = [];
        for (const table of auditTables()) {
          const where = [filters.clause, ...extra].filter((clause): clause is string => clause !== null).join(' AND ');
          const sql = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY ts DESC LIMIT ${perTable}`;
          try {
            rows.push(...(sqlite.prepare(sql).all(...filters.params) as Array<Record<string, unknown>>));
          } catch {
            // 表结构缺列时跳过（旧分表可能少了后加的列）
          }
        }
        rows.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
        // total 用 COUNT 另算：归并后的条数是各表并集，不能当总数
        let total = 0;
        for (const table of auditTables()) {
          const where = [filters.clause, ...extra].filter((clause): clause is string => clause !== null).join(' AND ');
          try {
            const r = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...filters.params) as { n?: number } | undefined;
            total += Number(r?.n ?? 0);
          } catch {
            // 同上
          }
        }
        const data = rows.slice((page - 1) * pageSize, page * pageSize);
        // 审计里只存 credential_id（凭证可能被轮换/删除，名称会变）。展示层要的是"用哪个账号"，
        // 这里按当前凭证表补名称；凭证已删除时保留 id 并标注，避免显示成空白让人以为没记录。
        const credIds = [...new Set(data.map((r) => r.credential_id).filter((v): v is string => typeof v === 'string' && v !== ''))];
        const credNames = new Map<string, string>();
        if (credIds.length > 0) {
          const marks = credIds.map(() => '?').join(',');
          const found = sqlite.prepare(`SELECT id, name FROM credentials WHERE id IN (${marks})`).all(...credIds) as Array<{ id: string; name: string }>;
          for (const c of found) credNames.set(c.id, c.name);
        }
        const items = data.map((r) => ({
          ...r,
          credential_name: typeof r.credential_id === 'string' ? (credNames.get(r.credential_id) ?? null) : null,
        }));
        return reply.send({ code: 0, data: { items, page, pageSize, total }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/audit/:id',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        for (const table of auditTables()) {
          const row = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as { user_id?: string } | undefined;
          if (!row) continue;
          // 成员只能看自己的记录：按 id 直接查会绕过列表的过滤，这里必须同口径
          if (!p.isAdmin && row.user_id !== p.userId) {
            return reply.code(404).send({ code: 404, data: null, message: '审计记录不存在' });
          }
          return reply.send({ code: 0, data: row, message: 'ok' });
        }
        return reply.code(404).send({ code: 404, data: null, message: '审计记录不存在' });
      },
    },
    {
      /**
       * 删除单条审计（admin）。用户 2026-11-18 决策：硬删除——
       * 直接 DELETE，不做软删除、也不为删除动作留痕（接受"删审计本身无记录"这一后果）。
       * 表名只来自 auditTables() 白名单，绝不接受外部表名。
       */
      method: 'DELETE',
      url: '/api/v1/audit/:id',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        for (const table of auditTables()) {
          const r = sqlite.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
          if (r.changes > 0) {
            return reply.send({ code: 0, data: { deleted: Number(r.changes) }, message: 'ok' });
          }
        }
        return reply.code(404).send({ code: 404, data: null, message: '审计记录不存在' });
      },
    },
    {
      /**
       * 按筛选条件批量删除（admin，与列表/导出同口径）。
       * 空筛选一律拒绝：否则一条空条件就能清空全部审计——这是不可逆的破坏性动作，
       * 必须要求调用方显式给出至少一个筛选条件。
       */
      method: 'POST',
      url: '/api/v1/audit/bulk-delete',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const q = (req.body ?? {}) as Record<string, string | undefined>;
        const filters = buildFilters(q);
        const extra = [filters.fromTs !== null ? `ts >= ${filters.fromTs}` : null, filters.toTs !== null ? `ts <= ${filters.toTs}` : null]
          .filter((clause): clause is string => clause !== null);
        const where = [filters.clause, ...extra].filter((clause): clause is string => clause !== null).join(' AND ');
        if (!where) {
          return reply.code(400).send({
            code: 400,
            data: null,
            message: '批量删除必须至少给出一个筛选条件（用户/资产/工具/状态/风险/动作/时间范围），不接受空条件',
          });
        }
        const tables: Array<{ table: string; removed: number }> = [];
        let deleted = 0;
        for (const table of auditTables()) {
          try {
            const r = sqlite.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...filters.params);
            if (r.changes > 0) {
              tables.push({ table, removed: Number(r.changes) });
              deleted += Number(r.changes);
            }
          } catch {
            // 旧分表结构缺列时跳过（与列表查询同口径）
          }
        }
        return reply.send({ code: 0, data: { deleted, tables }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/audit/stats',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const q = req.query as { groupBy?: 'asset' | 'global'; window?: '24h' | '7d' | '30d'; assetId?: string };
        const windowMs = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000, '30d': 30 * 24 * 3600_000 }[q.window ?? '7d'];
        const since = Date.now() - windowMs;
        const groupBy = q.groupBy ?? 'asset';
        // 调用统计不含身份维度（表按 asset_id 聚合），成员不能看全局/他人资产的数据量。
        const allowed = p.isAdmin ? null : visibleAssetIds(sqlite, p);
        if (!p.isAdmin && groupBy === 'global') {
          return reply.code(403).send({ code: 403, data: null, message: '调用统计仅管理员可见' });
        }
        if (!p.isAdmin && q.assetId && !allowed!.has(q.assetId)) {
          return reply.code(403).send({ code: 403, data: null, message: '无权查看该资产的调用统计' });
        }
        const scopeFilter = allowed === null ? '' : ` AND asset_id IN (${[...allowed].map(() => '?').join(',') || 'NULL'})`;
        const scopeParams = allowed === null ? [] : [...allowed];
        let rows: Array<Record<string, unknown>>;
        if (groupBy === 'asset') {
          rows = q.assetId
            ? sqlite
                .prepare(
                  `SELECT hour_ts, asset_id, call_count - error_count - blocked_count AS ok_count, error_count, blocked_count, total_duration_ms
                   FROM audit_stats_hourly WHERE hour_ts >= ? AND asset_id = ? ORDER BY hour_ts`,
                )
                .all(since, q.assetId) as Array<Record<string, unknown>>
            : sqlite
                .prepare(
                  `SELECT asset_id, SUM(call_count) call_count, SUM(error_count) error_count, SUM(blocked_count) blocked_count, SUM(total_duration_ms) total_duration_ms
                   FROM audit_stats_hourly WHERE hour_ts >= ?${scopeFilter} GROUP BY asset_id`,
                )
                .all(since, ...scopeParams) as Array<Record<string, unknown>>;
        } else {
          rows = sqlite
            .prepare(
              `SELECT SUM(call_count) call_count, SUM(error_count) error_count, SUM(blocked_count) blocked_count, SUM(total_duration_ms) total_duration_ms
               FROM audit_stats_hourly WHERE hour_ts >= ?`,
            )
            .all(since) as Array<Record<string, unknown>>;
        }
        return reply.send({ code: 0, data: { window: q.window ?? '7d', groupBy, rows }, message: 'ok' });
      },
    },
  ];
}

/**
 * 非管理员可见资产集合：与 can() 同口径（归属人 / 共享名单 / public / 分组交集）。
 * 审计与统计走原始 sqlite（不经过 drizzle），这里直接拼装 can() 需要的最小字段。
 */
function visibleAssetIds(
  sqlite: Database,
  principal: { userId: string; isAdmin: boolean },
): Set<string> {
  const userGroups = new Set(
    (sqlite.prepare('SELECT group_id AS g FROM group_users WHERE user_id = ?').all(principal.userId) as Array<{ g: string }>).map((r) => r.g),
  );
  const rows = sqlite
    .prepare('SELECT id, owner_id AS ownerId, visibility, shared_with_user_ids AS shared FROM servers')
    .all() as Array<{ id: string; ownerId: string | null; visibility: string; shared: string | null }>;
  const groupMap = new Map<string, string[]>();
  for (const r of sqlite.prepare('SELECT server_id AS s, group_id AS g FROM group_servers').all() as Array<{ s: string; g: string }>) {
    const list = groupMap.get(r.s) ?? [];
    list.push(r.g);
    groupMap.set(r.s, list);
  }
  const out = new Set<string>();
  for (const r of rows) {
    let shared: string[] = [];
    try {
      shared = JSON.parse(r.shared ?? '[]') as string[];
    } catch {
      shared = [];
    }
    const assetGroups = groupMap.get(r.id) ?? [];
    if (can('view', principal, {
      ownerId: r.ownerId,
      visibility: r.visibility as 'owner' | 'group' | 'public',
      sharedWithUserIds: shared,
      groups: assetGroups,
      userGroups: [...userGroups],
    })) {
      out.add(r.id);
    }
  }
  return out;
}

function buildFilters(q: Record<string, string | undefined>): { clause: string | null; params: unknown[]; fromTs: number | null; toTs: number | null } {
  const params: unknown[] = [];
  const parts: string[] = [];
  const push = (col: string, val: string | undefined) => {
    if (val) {
      parts.push(`${col} = ?`);
      params.push(val);
    }
  };
  push('user_id', q.userId);
  push('server_id', q.serverId);
  push('tool', q.tool);
  push('status', q.status);
  push('risk', q.risk);
  push('action', q.action);
  // 日志范围（前端「管理后台操作 / 资产具体操作」筛选）：
  // 按动作性质划分 —— 治理类动作（可见性/凭证/分组/规则/设置…）= 管理后台操作；
  // 工具调用/传输/拦截等 = 资产的具体操作。
  // 不用 server_id 判定：治理事件的主体占位符不统一（'management' / 'settings' / ...）。
  if (q.scope === 'management') {
    parts.push(`action IN (${GOVERNANCE_ACTIONS.map(() => '?').join(',')})`);
    params.push(...GOVERNANCE_ACTIONS);
  } else if (q.scope === 'asset') {
    parts.push(`action NOT IN (${GOVERNANCE_ACTIONS.map(() => '?').join(',')})`);
    params.push(...GOVERNANCE_ACTIONS);
  }
  // 多动作过滤（前端"授权变更"快捷钮：action IN (...)）
  const actions = q.actions ? q.actions.split(',').filter(Boolean) : [];
  if (actions.length > 0) {
    parts.push(`action IN (${actions.map(() => '?').join(',')})`);
    params.push(...actions);
  }
  return {
    clause: parts.length > 0 ? parts.join(' AND ') : null,
    params,
    fromTs: q.from ? Number(q.from) : null,
    toTs: q.to ? Number(q.to) : null,
  };
}
