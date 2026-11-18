/**
 * AC-14 审计归档作业（§4.5 按月分表 + 保留期归档，Spec §2 约束 6）：
 * 对全部 audit_log_YYYY_MM 分表删除 ts < cutoff 的行（保留期外即清），audit_stats_hourly 同步清理。
 * cutoff 由调用方按 audit.retention_months（配置字典，热读）计算；返回逐表删除行数供留痕与日志。
 * 表名来自 sqlite_master 且经白名单正则校验（防注入），绝不对任意字符串执行 DELETE。
 */
import type { Database } from 'better-sqlite3';
import { ensureAuditTable } from '../db/audit.js';

export interface ArchiveResult {
  cutoff: number;
  tables: Array<{ table: string; removed: number }>;
  statsRemoved: number;
}

const TABLE_RE = /^audit_log_\d{4}_\d{2}$/;

export function archiveExpiredAudit(sqlite: Database, cutoffMs: number): ArchiveResult {
  const rows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'audit_log_%'`,
    )
    .all() as Array<{ name: string }>;

  const out: ArchiveResult = { cutoff: cutoffMs, tables: [], statsRemoved: 0 };
  for (const { name } of rows) {
    if (!TABLE_RE.test(name)) continue; // 白名单：只处理约定命名分表
    const r = sqlite.prepare(`DELETE FROM "${name}" WHERE ts < ?`).run(cutoffMs);
    if (r.changes > 0) out.tables.push({ table: name, removed: r.changes });
  }
  const st = sqlite.prepare('DELETE FROM audit_stats_hourly WHERE hour_ts < ?').run(cutoffMs);
  out.statsRemoved = st.changes;
  return out;
}

/** 归档动作自身留痕（写入当月分表 action='audit_archive'，username='system'；失败不阻断） */
export function writeArchiveAuditRow(
  sqlite: Database,
  result: ArchiveResult,
  ts = Date.now(),
): void {
  try {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const table = `audit_log_${y}_${m}`;
    ensureAuditTable(sqlite, d);
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO "${table}" (id, ts, user_id, username, tool, action, risk, input_summary, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `arch-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        ts,
        'system',
        'system',
        'audit_archive',
        'audit_archive',
        'normal',
        JSON.stringify(result).slice(0, 4096),
        'success',
      );
  } catch {
    // 留痕失败不阻断归档（表可能未建）
  }
}
