/**
 * 审计分表 helper（§4.5 / Spec §4.5）：audit_log_YYYY_MM 按月；跨月查询由 service 层拼接。
 * 约定：月份取本地时区边界（运维视角）。
 * 迁移只建当月表；运行时按月 ensure（T8 及后续写入前调用）。
 */
import type { Database } from 'better-sqlite3';
import { AUDIT_TABLE_PREFIX } from '../config/constants.js';

/** 按月分表名：audit_log_YYYY_MM */
export function auditTableName(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${AUDIT_TABLE_PREFIX}${y}_${m}`;
}

/** 与 src/db/schema.ts auditLogTable 列定义一致（按月建表用裸 SQL，项目规则 §5 唯一例外） */
const AUDIT_COLUMNS = `
  id text PRIMARY KEY,
  ts integer NOT NULL,
  user_id text,
  username text,
  api_key_id text,
  client_name text,
  source_ip text,
  server_id text,
  server_name text,
  credential_id text,
  tool text,
  action text NOT NULL,
  risk text,
  input_summary text,
  status text,
  output_summary text,
  duration_ms integer,
  error_message text
`;

const AUDIT_INDEXES = [
  'ts',
  'user_id, ts',
  'server_id, ts',
  'status, ts',
  'tool, ts',
];

/** 确保某个月份的审计分表存在（幂等）；返回表名 */
export function ensureAuditTable(db: Database, d: Date = new Date()): string {
  const name = auditTableName(d);
  db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${AUDIT_COLUMNS});`);
  for (const cols of AUDIT_INDEXES) {
    const idx = `${name}_${cols.replace(', ', '_')}_idx`;
    db.exec(`CREATE INDEX IF NOT EXISTS ${idx} ON ${name} (${cols});`);
  }
  return name;
}
