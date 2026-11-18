/**
 * T4（tasks-2611-1829-00）：运行时实例列表的资源字段与实例关闭端点。
 *
 * 这里用一个最小可用的 InstancePool（真实 spawn mock stdio MCP 进程）验证：
 *  - 列表返回 serverName + pid + cpuPercent/rssBytes（采样失败为 null 的契约由 processSampler 单测覆盖）
 *  - DELETE 关闭后实例消失、stats 减一，并写审计
 *  - 成员访问 → 403（admin-only）
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
import { InstancePool } from './services/instancePool.js';
import { buildPlan } from './services/instancePlan.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/mock-mcp-server.mjs', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let pool: InstancePool;
let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'admin', password: 'password-12345', isAdmin: true });
  await createUserWithPassword(auth, { username: 'member', password: 'password-12345', isAdmin: false });

  // 用 drizzle 插入（让 $defaultFn 生效：tags/credential_slots 等都是 NOT NULL）
  const adminRow = sqlite.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: string };
  await db.insert(schema.servers).values({
    id: 'srv-runtime', name: 'runtime-demo', displayName: '运行时演示资产',
    type: 'stdio', executionMode: 'mcp', category: 'other', ownerId: adminRow.id,
    enabled: true, visibility: 'private', configHash: 'ch-1',
  }).run();

  // 默认 transportFactory 处理 stdio 计划（真实 spawn mock MCP 进程）
  pool = new InstancePool({
    globalBudget: 4, globalWeightBudget: 12, maxPerAsset: 2, queuePerUser: 2,
    globalConcurrency: 2, idleTtlMs: 120_000, queueTimeoutMs: 2000,
    degradeWaitMs: 0, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-rt-')),
  });

  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, instancePool: pool });

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
  await pool.releaseAll();
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }

async function api(method: 'GET' | 'DELETE', url: string, cookie: string): Promise<{ status: number; json: Json }> {
  const res = await app.inject({ method, url, headers: { cookie, origin: BASE_URL } });
  return { status: res.statusCode, json: res.json() as Json };
}

interface RuntimeRow {
  key: string; serverId: string; serverName: string | null; pid: number | null;
  cpuPercent: number | null; rssBytes: number | null; state: string;
}

describe('T4 运行时实例列表与关闭', { timeout: 30_000 }, () => {
  it('列表带资产名与主进程资源快照；关闭后实例消失并写审计', async () => {
    const plan = buildPlan(
      {
        id: 'srv-runtime', configHash: 'ch-1', command: process.execPath, args: [FIXTURE],
        env: {}, credentialSlots: [], transport: 'stdio',
      },
      [],
      mkdtempSync(path.join(tmpdir(), 'opsgate-rc-')),
    );
    const handle = await pool.acquire(plan, 'u-admin');

    const listed = await api('GET', '/api/v1/runtime/instances', adminCookie);
    expect(listed.status).toBe(200);
    const rows = (listed.json.data as { instances: RuntimeRow[] }).instances;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.serverName).toBe('运行时演示资产');
    expect(rows[0]!.pid).toBeGreaterThan(0);
    // RSS 取自主进程，应当采得到；CPU 首次无基线为 null（第二次起才有值）
    expect(rows[0]!.rssBytes).toBeGreaterThan(0);
    expect(rows[0]!.cpuPercent).toBeNull();

    const closed = await api('DELETE', `/api/v1/runtime/instances/${encodeURIComponent(rows[0]!.key)}`, adminCookie);
    expect(closed.status).toBe(200);
    expect((closed.json.data as { closed: boolean }).closed).toBe(true);
    expect(pool.stats().instances).toBe(0);

    const after = await api('GET', '/api/v1/runtime/instances', adminCookie);
    expect((after.json.data as { instances: RuntimeRow[] }).instances).toHaveLength(0);

    const now = new Date();
    const table = `audit_log_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`;
    const hit = sqlite
      .prepare(`SELECT action, server_name FROM "${table}" WHERE action = 'runtime_instance_close'`)
      .all() as Array<{ action: string; server_name: string }>;
    expect(hit).toHaveLength(1);
    expect(hit[0]!.server_name).toBe('运行时演示资产');

    await handle.release();
  });

  it('关闭不存在的实例 → 404', async () => {
    const r = await api('DELETE', '/api/v1/runtime/instances/not-a-real-entry-key', adminCookie);
    expect(r.status).toBe(404);
  });

  it('成员访问 → 403（admin-only）', async () => {
    const listed = await api('GET', '/api/v1/runtime/instances', memberCookie);
    expect(listed.status).toBe(403);
    const closed = await api('DELETE', '/api/v1/runtime/instances/whatever', memberCookie);
    expect(closed.status).toBe(403);
  });
});
