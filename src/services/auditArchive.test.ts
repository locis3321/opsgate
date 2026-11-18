/**
 * AC-14 审计归档作业单测：保留期外分表行删除、白名单表名、stats 同步清理、留痕行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureAuditTable } from '../db/audit.js';
import { archiveExpiredAudit, writeArchiveAuditRow } from './auditArchive.js';

let sqlite: Database.Database;

/** 动态当月审计分表名（避免硬编码月份导致跨月失败） */
function currentAuditTable(d: Date = new Date()): string {
  return `audit_log_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
}

beforeAll(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  // 旧月表（模拟 2024-01）与当月表
  ensureAuditTable(sqlite, new Date(2024, 0, 1));
  ensureAuditTable(sqlite); // 当月
  const curTbl = currentAuditTable();
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS audit_stats_hourly (
       hour_ts integer, asset_id text, call_count integer, error_count integer,
       blocked_count integer, total_duration_ms integer,
       PRIMARY KEY (hour_ts, asset_id)
     );`,
  );
  const ins = sqlite.prepare(
    `INSERT INTO audit_log_2024_01 (id, ts, tool, action, risk, status) VALUES (?, ?, 'x', 'tool_call', 'normal', 'success')`,
  );
  ins.run('old-1', new Date(2024, 0, 1).getTime());
  ins.run('old-2', new Date(2024, 0, 2).getTime());
  const insNow = sqlite.prepare(
    `INSERT INTO "${curTbl}" (id, ts, tool, action, risk, status) VALUES (?, ?, 'x', 'tool_call', 'normal', 'success')`,
  );
  insNow.run('new-1', Date.now());
  sqlite.prepare('INSERT INTO audit_stats_hourly (hour_ts, asset_id, call_count) VALUES (?, ?, 1)').run(new Date(2024, 0, 1).getTime(), 'a1');
  sqlite.prepare('INSERT INTO audit_stats_hourly (hour_ts, asset_id, call_count) VALUES (?, ?, 1)').run(Math.floor(Date.now() / 3600000) * 3600000, 'a2');
});

afterAll(() => sqlite.close());

describe('AC-14 审计归档', () => {
  it('保留期外分表行删除、保留期内保留、stats 同步清理', () => {
    const cutoff = Date.now() - 12 * 30 * 24 * 3600 * 1000;
    const beforeOld = (sqlite.prepare('SELECT COUNT(*) c FROM audit_log_2024_01').get() as { c: number }).c;
    expect(beforeOld).toBe(2);
    const res = archiveExpiredAudit(sqlite, cutoff);
    expect(res.tables).toEqual([{ table: 'audit_log_2024_01', removed: 2 }]);
    expect(res.statsRemoved).toBe(1);
    expect((sqlite.prepare('SELECT COUNT(*) c FROM audit_log_2024_01').get() as { c: number }).c).toBe(0);
    const curTbl = currentAuditTable();
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM ${curTbl}`).get() as { c: number }).c).toBe(1);
    expect((sqlite.prepare('SELECT COUNT(*) c FROM audit_stats_hourly').get() as { c: number }).c).toBe(1);
  });

  it('表名白名单：非约定命名表不触碰（防注入）', () => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS audit_log_evil (ts integer)`);
    sqlite.prepare('INSERT INTO audit_log_evil (ts) VALUES (?)').run(1);
    archiveExpiredAudit(sqlite, Date.now());
    expect((sqlite.prepare('SELECT COUNT(*) c FROM audit_log_evil').get() as { c: number }).c).toBe(1);
  });

  it('归档动作留痕 action=audit_archive（system）', () => {
    writeArchiveAuditRow(sqlite, { cutoff: 0, tables: [], statsRemoved: 0 });
    const _m = String(new Date().getMonth() + 1).padStart(2, '0');
    const _y = new Date().getFullYear();
    const row = sqlite.prepare(`SELECT action, username FROM audit_log_${_y}_${_m} WHERE action='audit_archive'`).get() as { action: string; username: string };
    expect(row?.action).toBe('audit_archive');
    expect(row?.username).toBe('system');
  });
});
