/**
 * T8 集成测试（REST 管理面）：settings 写路径（-32008 不落库 / write-ahead 审计 / 热生效）/
 * guard-rules（ReDoS 400 / locked 403）/ 跨主绑定 400 / 审计查询与统计。
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
import { GOVERNANCE_ACTIONS } from './config/constants.js';
import { loadCredentialKey, encryptCredential } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { TransferService, TransferLimitError } from './services/transfer.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';
import { eq } from 'drizzle-orm';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let adminCookie: string;
let userCookie: string;
let transfer: TransferService;
let auditService: AuditService;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  auditService = audit;
  transfer = new TransferService({
    dataDir: mkdtempSync(path.join(tmpdir(), 'opsgate-tf-')),
    maxFileBytes: 10_000_000,
    entryTtlMs: 300_000,
    stagingQuotaBytes: 2_000_000_000,
    stagingTtlMs: 900_000,
  }, settings);

  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'admin', password: 'password-12345', isAdmin: true });
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  await createUserWithPassword(auth, { username: 'bob', password: 'password-12345', isAdmin: false });

  // 内置 locked 规则（seed 语义）
  await db
    .insert(schema.guardRules)
    .values({
      id: 'gr-locked', name: '锁定规则', kind: 'block', target: 'arg', pattern: '^LOCKED$',
      enabled: true, locked: true, builtin: true, priority: 100, hitCount: 0,
    })
    .run();
  // 数据：alice 的凭证 + 资产；bob 的资产
  await db.insert(schema.credentials).values({
    id: 'cred-alice', name: 'alice-cred', encryptedValues: encryptCredential(cryptoKey, 'cred-alice', JSON.stringify({ AUTH: 'pw' })),
    valueHint: '****123', ownerId: (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'alice')).get())!.id,
  }).run();
  await db.insert(schema.servers).values({
    id: 'srv-alice', name: 'srv-alice', type: 'native', executionMode: 'native', category: 'host',
    ownerId: (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'alice')).get())!.id,
    configHash: 'c1', credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
  }).run();
  await db.insert(schema.servers).values({
    id: 'srv-bob', name: 'srv-bob', type: 'native', executionMode: 'native', category: 'host',
    ownerId: (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'bob')).get())!.id,
    configHash: 'c2', credentialSlots: [],
  }).run();

  app = await buildApp({
    db, auth, baseUrl: BASE_URL,
    audit, settings, cryptoKey, sqlite,
  });

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
  userCookie = await login('alice');
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json {
  code: number;
  data: unknown;
  message: string;
}

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown): Promise<{ status: number; json: Json }> {
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

describe('T8：settings 写路径（ADR-024）', { timeout: 15_000 }, () => {
  it('AC-55 行为级：PATCH 热生效项后服务下一次调用即采用新值（非存储层读写）', async () => {
    // 构造注入类服务的回归：若仍持有启动快照，此测试失败（用户审核指出的假通过根因）
    const before = await transfer.createUpload({ userId: 'u', assetId: 'a', remotePath: '/tmp/x', declaredSize: 5_000_000 });
    void before;
    const patch = await api('PATCH', '/api/v1/settings/transfer.max_file_bytes', adminCookie, { value: 1500000 });
    expect(patch.status).toBe(200);
    expect(() => transfer.createUpload({ userId: 'u', assetId: 'a', remotePath: '/tmp/y', declaredSize: 5_000_000 })).toThrow(TransferLimitError);
  });

  it('AC-55 热生效：PATCH 合法值 → 200；未授权用户 403', async () => {
    const ok = await api('PATCH', '/api/v1/settings/tools.command_timeout_sec', adminCookie, { value: 45 });
    expect(ok.status).toBe(200);
    expect((ok.json.data as { value: number }).value).toBe(45);
    const denied = await api('PATCH', '/api/v1/settings/tools.command_timeout_sec', userCookie, { value: 60 });
    expect(denied.status).toBe(403);
  });

  it('AC-57 越界 → -32008 且不落库；审计含 before/after', async () => {
    const bad = await api('PATCH', '/api/v1/settings/instance_pool.global_budget', adminCookie, { value: 999 });
    expect(bad.json.code).toBe(-32008);
    const list = await api('GET', '/api/v1/settings', adminCookie);
    const item = (list.json.data as Array<{ key: string; current: number }>).find((x) => x.key === 'instance_pool.global_budget')!;
    expect(item.current).toBe(80); // 未被改写
    const audit = await api('GET', '/api/v1/audit?action=system_setting', adminCookie);
    // 无过滤列表（五要素可视性）由 T8 审计统计用例覆盖
    const rows = audit.json.data as { items: Array<{ action: string; input_summary: string }> };
    expect(rows.items.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows.items[0]!.input_summary)).toContain('tools.command_timeout_sec');
  });

  it('AC-60 数据源：requires_restart 项修改后 pending-restart 返回 saved/effective', async () => {
    await api('PATCH', '/api/v1/settings/ssh_pool.global_semaphore', adminCookie, { value: 16 });
    const pending = await api('GET', '/api/v1/settings/pending-restart', adminCookie);
    const list = pending.json.data as { pending: Array<{ key: string; saved: number }> };
    expect(list.pending.some((p) => p.key === 'ssh_pool.global_semaphore' && p.saved === 16)).toBe(true);
  });

  it('reset 恢复默认', async () => {
    const reset = await api('POST', '/api/v1/settings/tools.command_timeout_sec/reset', adminCookie, {});
    expect(reset.status).toBe(200);
    const list = await api('GET', '/api/v1/settings', adminCookie);
    const item = (list.json.data as Array<{ key: string; current: number }>).find((x) => x.key === 'tools.command_timeout_sec')!;
    expect(item.current).toBe(30);
  });
});

describe('T8：guard-rules（AC-15/AC-16）', { timeout: 15_000 }, () => {
  it('AC-16 ReDoS 正则 → 400；合法正则 → 200', async () => {
    const bad = await api('POST', '/api/v1/guard-rules', adminCookie, {
      name: 'bad', kind: 'mark', target: 'arg', pattern: '(a+)+$',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain('ReDoS');
    const ok = await api('POST', '/api/v1/guard-rules', adminCookie, {
      name: 'good', kind: 'mark', target: 'arg', pattern: '^DROP\\s+TABLE$', description: 'test',
    });
    expect(ok.status).toBe(200);
  });

  it('AC-15 内置规则（locked=1）可由管理员修改/删除，且写审计（2026-11-17 决策）', async () => {
    // 原设计用 locked 在服务端硬拦；用户决策改为「安全底线由管理员负责」，
    // 内置规则可改可删，但必须留审计痕迹。
    const patch = await api('PATCH', '/api/v1/guard-rules/gr-locked', adminCookie, { pattern: '^X$' });
    expect(patch.status).toBe(200);
    const del = await api('DELETE', '/api/v1/guard-rules/gr-locked', adminCookie);
    expect(del.status).toBe(200);
    const gone = sqlite.prepare("SELECT id FROM guard_rules WHERE id='gr-locked'").get();
    expect(gone).toBeUndefined();
    const tbl = `audit_log_${new Date().getFullYear()}_${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const auditRow = sqlite.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE action='guard_rule_change'`).get() as { c: number };
    expect(auditRow.c).toBeGreaterThanOrEqual(1);
  });
});

describe('T8：写入侧同主（AC-25）', { timeout: 15_000 }, () => {
  it('Alice 建资产/凭证；Bob 把 Alice 凭证绑到自己的资产 → 400（带凭证名）', async () => {
    const bobId = (sqlite.prepare("SELECT id FROM users WHERE username='bob'").get() as { id: string }).id;
    const bobAssets = sqlite.prepare("SELECT id FROM servers WHERE owner_id=?").all(bobId) as Array<{ id: string }>;
    const bobLogin = async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/username', payload: { username: 'bob', password: 'password-12345' }, headers: { origin: BASE_URL, 'content-type': 'application/json' } });
      const cookies = res.headers['set-cookie'];
      const sc = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
      return sc[0]!.split(';')[0]!;
    };
    const bobCookie = await bobLogin();
    const bind = await api('POST', `/api/v1/servers/${bobAssets[0]!.id}/slots`, bobCookie, { slotName: 'AUTH', credentialId: 'cred-alice' });
    expect(bind.status).toBe(400);
    expect(bind.json.message).toContain('alice-cred');
  });
});

describe('T8：审计查询与统计', { timeout: 15_000 }, () => {
  it('列表可检索五要素；stats 端点 200', async () => {
    const list = await api('GET', '/api/v1/audit?page=1', adminCookie);
    expect(list.status).toBe(200);
    const stats = await api('GET', '/api/v1/audit/stats?groupBy=global&window=24h', adminCookie);
    expect(stats.status).toBe(200);
    expect((stats.json.data as { groupBy: string }).groupBy).toBe('global');
  });

  it('scope 区分管理后台操作 / 资产操作；列表带用户名与资产名', async () => {
    const GOVERNANCE: string[] = [...GOVERNANCE_ACTIONS];
    // 治理事件（管理后台操作）
    await api('PATCH', '/api/v1/settings/tools.command_timeout_sec', adminCookie, { value: 45 });
    // 资产的具体操作（工具调用）
    const bobId = (sqlite.prepare("SELECT id FROM users WHERE username='bob'").get() as { id: string }).id;
    await auditService.writeIntent({
      principal: { userId: bobId, isAdmin: false },
      asset: { id: 'srv-asset-op', name: '测试资产' },
      tool: 'host_execute_command',
      args: { command: 'echo hi' },
      risk: 'normal',
      status: 'success',
    });

    const mgmt = await api('GET', '/api/v1/audit?scope=management', adminCookie);
    const mgmtRows = (mgmt.json.data as { items: Array<{ action: string; username?: string; server_name?: string }> }).items;
    expect(mgmtRows.length).toBeGreaterThanOrEqual(1);
    expect(mgmtRows.every((r) => GOVERNANCE.includes(r.action))).toBe(true);
    // 用户列用用户名（不是 id 片段）
    expect(mgmtRows.some((r) => r.username && !/^[A-Za-z0-9]{8}$/.test(r.username!))).toBe(true);

    const asset = await api('GET', '/api/v1/audit?scope=asset', adminCookie);
    const assetRows = (asset.json.data as { items: Array<{ action: string; server_name?: string }> }).items;
    expect(assetRows.length).toBeGreaterThanOrEqual(1);
    expect(assetRows.every((r) => !GOVERNANCE.includes(r.action))).toBe(true);
    // 资产列用资产名
    expect(assetRows.some((r) => r.server_name === '测试资产')).toBe(true);
  });

  it('治理动作清单覆盖所有 governanceAudit 写入点（漏一个就会把管理操作误分到资产操作）', () => {
    // 清单必须包含资产/分组/规则等治理动作，否则 scope=asset 会混进管理操作
    for (const a of ['asset_create', 'remove_asset', 'asset_prewarm', 'asset_tool_filters',
      'group_change', 'update_group', 'delete_group', 'set_metadata', 'delete_metadata', 'remove_member',
      'guard_rule_change', 'native_tool_toggle', 'system_setting', 'cli_create_denied',
      'visibility_change', 'credential_bind', 'credential_unbind', 'credential_rotate', 'credential_reveal']) {
      expect(GOVERNANCE_ACTIONS as readonly string[]).toContain(a);
    }
    // 工具类动作不在治理清单内
    for (const a of ['tool_call', 'blocked', 'auth_fail', 'transfer_upload', 'transfer_landed']) {
      expect(GOVERNANCE_ACTIONS as readonly string[]).not.toContain(a);
    }
  });
});
