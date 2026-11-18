/**
 * T2（tasks-2611-1829-00）：审计删除 / 批量删除 / 保留期默认 180 天。
 *
 * 用户 2026-11-18 决策：**硬删除**——直接 DELETE，不做软删除、不为删除动作留痕。
 * 因此这里验证的是"行真的消失"，而不是"标记为已删除"。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';
import { ensureAuditTable } from './db/audit.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let adminCookie: string;
let memberCookie: string;
let settings: Settings;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'admin', password: 'password-12345', isAdmin: true });
  await createUserWithPassword(auth, { username: 'member', password: 'password-12345', isAdmin: false });

  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite });

  const login = async (username: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const cookies = res.headers['set-cookie'];
    const sc = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    return sc[0]!.split(';')[0]!;
  };
  adminCookie = await login('admin');
  memberCookie = await login('member');
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }

async function api(method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: {
      cookie,
      origin: BASE_URL,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

/** 直接往当月的分表写行（审计是 append-only 的分月表，测试造数最直接） */
function insertAuditRows(count: number, username = 'seed-user'): string[] {
  const now = new Date();
  ensureAuditTable(sqlite, now);
  const table = `audit_log_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ids: string[] = [];
  const stmt = sqlite.prepare(
    `INSERT INTO "${table}" (id, ts, user_id, username, tool, action, risk, input_summary, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    const id = `t2audit-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
    stmt.run(id, Date.now() - i, 'u-seed', username, 'system_setting', 'system_setting', 'normal', '{}', 'success');
    ids.push(id);
  }
  return ids;
}

function auditCountOf(username: string): number {
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'audit_log_%'").all() as Array<{ name: string }>).map((r) => r.name);
  let n = 0;
  for (const t of tables) {
    try {
      const r = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${t}" WHERE username = ?`).get(username) as { c: number };
      n += Number(r.c);
    } catch { /* 旧表缺列 */ }
  }
  return n;
}

describe('T2：审计删除（硬删除）', () => {
  it('admin 删除单条 → 行真的从分表消失', async () => {
    const [id] = insertAuditRows(1, 't2-single');
    expect(auditCountOf('t2-single')).toBe(1);

    const r = await api('DELETE', `/api/v1/audit/${id}`, adminCookie);
    expect(r.status).toBe(200);
    expect((r.json.data as { deleted: number }).deleted).toBe(1);
    expect(auditCountOf('t2-single')).toBe(0);
  });

  it('删除不存在的 id → 404', async () => {
    const r = await api('DELETE', '/api/v1/audit/no-such-row', adminCookie);
    expect(r.status).toBe(404);
  });

  it('成员删除审计 → 403（accessMode: admin）', async () => {
    const [id] = insertAuditRows(1, 't2-member-deny');
    const r = await api('DELETE', `/api/v1/audit/${id}`, memberCookie);
    expect(r.status).toBe(403);
    // 被拒后行仍在
    expect(auditCountOf('t2-member-deny')).toBe(1);
  });
});

describe('T2：审计列表分页与详情字段（2026-11-18 用户反馈）', () => {
  it('每页固定 20 条', async () => {
    insertAuditRows(25, 't2-page');
    const r = await api('GET', '/api/v1/audit?page=1&tool=system_setting', adminCookie);
    expect(r.status).toBe(200);
    const d = r.json.data as { items: unknown[]; pageSize: number; total: number };
    expect(d.pageSize).toBe(20);
    expect(d.items.length).toBeLessThanOrEqual(20);
    expect(d.total).toBeGreaterThanOrEqual(25);
  });

  it('凭证列补 credential_name（前端详情要显示"用哪个凭证"的名称）', async () => {
    const now = new Date();
    ensureAuditTable(sqlite, now);
    const table = `audit_log_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`;
    sqlite.prepare('INSERT INTO credentials (id, name, kind, encrypted_values, value_hint, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('cred-t2-name', 't2-cred', 'password', '{}', '', null, Date.now(), Date.now());
    sqlite.prepare(
      `INSERT INTO "${table}" (id, ts, user_id, username, credential_id, tool, action, risk, input_summary, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t2audit-cred', Date.now(), 'u-seed', 't2-cred-name', 'cred-t2-name', 'native:host.execute_command', 'tool_call', 'normal', '{"command":"uptime"}', 'success');

    const r = await api('GET', '/api/v1/audit?page=1&tool=native:host.execute_command', adminCookie);
    const items = (r.json.data as { items: Array<{ credential_id: string; credential_name: string | null; input_summary: string }> }).items;
    const hit = items.find((x) => x.credential_id === 'cred-t2-name');
    expect(hit?.credential_name).toBe('t2-cred');
    // 参数存在 input_summary（服务端脱敏后），不是 args
    expect(hit?.input_summary).toContain('uptime');
  });
});

describe('T2：按筛选批量删除', () => {
  it('按 username 以外的可用筛选（tool）命中并删除多条', async () => {
    insertAuditRows(3, 't2-bulk');
    // 列表接口支持 tool 筛选，批量删除用同一套 buildFilters
    const r = await api('POST', '/api/v1/audit/bulk-delete', adminCookie, { tool: 'system_setting' });
    expect(r.status).toBe(200);
    const deleted = (r.json.data as { deleted: number }).deleted;
    expect(deleted).toBeGreaterThanOrEqual(3);
    expect(auditCountOf('t2-bulk')).toBe(0);
  });

  it('空筛选 → 400（不允许一条空条件清空全部审计）', async () => {
    const r = await api('POST', '/api/v1/audit/bulk-delete', adminCookie, {});
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('至少');
  });

  it('成员批量删除 → 403', async () => {
    const r = await api('POST', '/api/v1/audit/bulk-delete', memberCookie, { tool: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('T2：保留期默认 180 天', () => {
  it('audit.retention_months 默认 6（≈180 天）', () => {
    expect(settings.get<number>('audit.retention_months')).toBe(6);
  });
});
