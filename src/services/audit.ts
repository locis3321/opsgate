/**
 * 审计服务（§5.7 / §4.5）：write-ahead intent + 回填（write-ahead 为 R-2 核心，失败即抛错）；
 * 入参脱敏（§5.6：key 命中 password|secret|token|key|passwd|credential → ***，与凭证值精确相等 → ***credential***）；
 * 输出截断 4KB（audit.arg_truncate_bytes / output_truncate）。按月分表（audit.ts）。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { SettingsLike } from '../config/settings.js';
import { AUDIT_REDACT_RE, AUDIT_REDACT_REPLACEMENT } from '../config/constants.js';
import { ensureAuditTable } from '../db/audit.js';


export interface AuditIntentEntry {
  principal: { userId: string; isAdmin: boolean };
  asset: { id: string; name: string };
  /** 命名空间 tool 名：native:<id> 或 derived:<tool>，如 native:host.execute_command */
  tool: string;
  /** 工具入参（脱敏前；本服务负责脱敏后入库） */
  args: Record<string, unknown>;
  /** 注入后生效的凭证 id（"用哪个账号"，§4.5） */
  credentialId?: string;
  risk: 'normal' | 'high';
  /** blocked/pending（dispatch 意图）或 success/error（传输完成等治理事件） */
  status: 'pending' | 'blocked' | 'success' | 'error';
  /** 声明抽字段（command 全文等） */
  audit?: { fields?: string[]; includeCommand?: boolean };
  /** 额外动作标签（治理类/传输类：credential_rotate | credential_bind | ... | transfer_upload 等） */
  action?: string;
  sourceIp?: string;
  clientName?: string;
  apiKeyId?: string;
}

export interface AuditFillInput {
  intentId: string;
  status: 'success' | 'error' | 'unknown';
  outputSummary?: string;
  errorMessage?: string;
  durationMs?: number;
}

export class AuditService {
  /** intent 的 ts 暂存（回填需定位月份表；单进程 Map，重启后 pending 由 reconciler 处理——T8） */
  private tsByIntent = new Map<string, number>();
  private ruleNameByIntent = new Map<string, string>();

  constructor(
    private readonly sqlite: Database,
    private readonly settingsSrc: SettingsLike | null = null,
  ) {}

  private hot(key: string, fallback: number): number {
    if (this.settingsSrc) return this.settingsSrc.get<number>(key) as number;
    return fallback;
  }

  async writeIntent(entry: AuditIntentEntry): Promise<{ intentId: string; ts: number }> {
    const intentId = randomUUID();
    const ts = Date.now();
    // 五要素之"人"：审计归属 = API Key 归属人（username 单一来源，调用方不必传）
    const username =
      (this.sqlite.prepare('SELECT username FROM users WHERE id = ?').get(entry.principal.userId) as { username?: string } | undefined)
        ?.username ?? '';
    ensureAuditTable(this.sqlite, new Date(ts));
    const table = `audit_log_${new Date(ts).getFullYear()}_${String(new Date(ts).getMonth() + 1).padStart(2, '0')}`;
    // 脱敏与截断在入库前完成（§4.5：不存明文中转）
    const inputSummary = JSON.stringify(redactValue(entry.args)).slice(
      0,
      this.hot('audit.arg_truncate_bytes', 4096),
    );
    const sql = `INSERT INTO ${table}
      (id, ts, user_id, username, api_key_id, client_name, source_ip, server_id, server_name, credential_id, tool, action, risk, input_summary, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.sqlite
      .prepare(sql)
      .run(
        intentId,
        ts,
        entry.principal.userId,
        username,
        entry.apiKeyId ?? null,
        entry.clientName ?? null,
        entry.sourceIp ?? null,
        entry.asset.id,
        entry.asset.name,
        entry.credentialId ?? null,
        entry.tool,
        entry.action ?? 'tool_call',
        entry.risk,
        inputSummary,
        entry.status,
      );
    this.tsByIntent.set(intentId, ts);
    return { intentId, ts };
  }

  async fill(input: AuditFillInput): Promise<void> {
    const ts = this.tsByIntent.get(input.intentId) ?? Date.now();
    const table = `audit_log_${new Date(ts).getFullYear()}_${String(new Date(ts).getMonth() + 1).padStart(2, '0')}`;
    const upd = this.sqlite
      .prepare(
        `UPDATE ${table} SET status=?, output_summary=?, duration_ms=?, error_message=? WHERE id=?`,
      )
      .run(
        input.status,
        input.outputSummary ?? null,
        input.durationMs ?? null,
        input.errorMessage ?? null,
        input.intentId,
      );
    if (upd.changes > 0) {
      // §4.6 预聚合：结果回填时同事务（同一连接）UPSERT 小时桶
      const row = this.sqlite
        .prepare(`SELECT server_id, action, status FROM ${table} WHERE id = ?`)
        .get(input.intentId) as { server_id: string | null; action: string; status: string } | undefined;
      if (row) {
        const hour = Math.floor(ts / 3_600_000) * 3_600_000;
        const isError = input.status === 'error' ? 1 : 0;
        const isBlocked = row.status === 'blocked' || row.action === 'blocked' ? 1 : 0;
        this.sqlite
          .prepare(
            `INSERT INTO audit_stats_hourly (hour_ts, asset_id, call_count, error_count, blocked_count, total_duration_ms)
             VALUES (?, ?, 1, ?, ?, ?)
             ON CONFLICT(hour_ts, asset_id) DO UPDATE SET
               call_count = call_count + 1,
               error_count = error_count + excluded.error_count,
               blocked_count = blocked_count + excluded.blocked_count,
               total_duration_ms = total_duration_ms + excluded.total_duration_ms`,
          )
          .run(hour, row.server_id ?? 'global', isError, isBlocked, input.durationMs ?? 0);
      }
    }
  }
}

/** 递归脱敏：对象 key 命中敏感正则 → ***；字符串值与凭证值精确相等 → ***credential*** */
export function redactValue(
  value: unknown,
  credentialValues: string[] = [],
): unknown {
  if (typeof value === 'string') {
    if (credentialValues.includes(value)) return '***credential***';
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, credentialValues));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = AUDIT_REDACT_RE.test(k) ? AUDIT_REDACT_REPLACEMENT : redactValue(v, credentialValues);
    }
    return out;
  }
  return value;
}

export function truncateString(value: string, bytes: number): string {
  return value.length > bytes ? `${value.slice(0, bytes)}…` : value;
}
