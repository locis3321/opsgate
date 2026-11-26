/**
 * Task 9 集成：运行时 CLI 观测端点 + Prometheus 计数指标。
 *
 * 覆盖三件事（均为端点级契约，不打桩服务内部）：
 *  1. 权限：成员 403（admin-only），管理员 200 且 `data` 含 runs/stats/health；
 *  2. 关闭：DELETE 不存在的 runId → 404（与"实例不存在"同口径，不伪造 killed:false 成功）；
 *     DELETE 真实在飞 runId → killed:true，进程结束，并落一条 `runtime_cli_kill` 审计；
 *  3. 指标：`/api/v1/runtime/metrics` 出现 CLI 两个指标行，且 total 随真实执行递增。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CliRunner } from './services/cliRunner.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { auditTableName } from './db/audit.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';
/** 假凭证：CLI 用例不需要凭证槽位，这里只保证资产行字段完整 */
const CLI_BIN = process.execPath;

let app: FastifyInstance;
let sqlite: Database.Database;
// 外层持有：未装配执行器的场景需要同一份 db/auth 再造一个 app（只差 cliRunner）
let db: BetterSQLite3Database<typeof schema>;
let auth: ReturnType<typeof createAuth>;
let settings: Settings;
let audit: AuditService;
let cryptoKey: ReturnType<typeof loadCredentialKey>;
let cliRunner: CliRunner;
let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  settings = new Settings({ getAll: async () => [] });
  await settings.init();
  cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'cli-rt-k-')), 'k'));
  audit = new AuditService(sqlite, settings);
  auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'admin', password: 'password-12345', isAdmin: true });
  await createUserWithPassword(auth, { username: 'member', password: 'password-12345', isAdmin: false });

  const adminId = (sqlite.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: string }).id;
  // 两条 cli 资产：一条可执行（绝对路径），一条二进制缺失 → health 必须区分 healthy / bin-missing
  await db.insert(schema.servers).values({
    id: 'srv-cli-ok', name: 'cli-runtime-demo', displayName: 'CLI 运行时演示',
    type: 'native', executionMode: 'cli', category: 'other', ownerId: adminId,
    enabled: true, visibility: 'private', configHash: 'ch-cli-1', command: CLI_BIN,
  }).run();
  await db.insert(schema.servers).values({
    id: 'srv-cli-missing', name: 'cli-runtime-missing', displayName: 'CLI 缺二进制',
    type: 'native', executionMode: 'cli', category: 'other', ownerId: adminId,
    enabled: true, visibility: 'private', configHash: 'ch-cli-2', command: 'opsgate-no-such-bin',
  }).run();

  const dataDir = mkdtempSync(path.join(tmpdir(), 'cli-rt-data-'));
  cliRunner = new CliRunner({
    dataDir,
    runtimeCredsDir: path.join(dataDir, 'rt'),
    // 测试文件豁免 AC-61：这里读宿主 PATH 是为了让 health/exec 能解析到真实二进制
    baseEnv: { PATH: process.env.PATH ?? '' },
    outputTruncateBytes: () => 4096,
    commandTimeoutMs: () => 20_000,
    // 沙箱不做正向断言（CIP 容器未必有 bwrap），关掉以免 healthy 被环境改写成本用例之外的结论
    sandboxEnabled: () => false,
  });

  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, cliRunner });

  const login = async (username: string): Promise<string> => {
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
interface CliRuntimeData {
  /** 执行器是否装配：与装配但零在飞同形，只有这个字段能区分（与 /runtime/long-connections 同口径） */
  available: boolean;
  runs: Array<{ runId: string; assetId: string; userId: string }>;
  stats: { active: number; total: number };
  health: Array<{ assetId: string; name: string; status: string }>;
}

async function api(method: 'GET' | 'DELETE', url: string, cookie: string): Promise<{ status: number; json: Json }> {
  const res = await app.inject({ method, url, headers: { cookie, origin: BASE_URL } });
  return { status: res.statusCode, json: res.json() as Json };
}

async function metrics(cookie: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/runtime/metrics', headers: { cookie, origin: BASE_URL } });
  expect(res.statusCode).toBe(200);
  return res.body;
}

describe('Task 9 运行时 CLI 端点', { timeout: 30_000 }, () => {
  it('成员访问 /runtime/cli 与删除 → 403（admin-only）', async () => {
    const listed = await api('GET', '/api/v1/runtime/cli', memberCookie);
    expect(listed.status).toBe(403);
    const killed = await api('DELETE', '/api/v1/runtime/cli/whatever', memberCookie);
    expect(killed.status).toBe(403);
  });

  it('管理员 GET → available:true 且 runs/stats/health 三段齐全，health 覆盖全部 cli 资产', async () => {
    const r = await api('GET', '/api/v1/runtime/cli', adminCookie);
    expect(r.status).toBe(200);
    const data = r.json.data as CliRuntimeData;
    // 装配了执行器：空 runs 必须能与"未装配"区分开
    expect(data.available).toBe(true);
    expect(Array.isArray(data.runs)).toBe(true);
    expect(data.stats).toMatchObject({ active: 0, total: 0 });
    // health 是"全部 cli 资产"的健康快照，不是"在飞进程列表"
    const byId = new Map(data.health.map((h) => [h.assetId, h]));
    expect(byId.get('srv-cli-ok')).toMatchObject({ name: 'CLI 运行时演示', status: 'healthy' });
    expect(byId.get('srv-cli-missing')).toMatchObject({ status: 'bin-missing' });
    // 非 cli 资产（本库无 mcp 行）不会出现在 health 里
    expect(data.health).toHaveLength(2);
  });

  it('执行器未装配 → available:false（空 runs/stats/health 不与"装配了但零在飞"同形）', async () => {
    // 同一份 db/auth，只是不传 cliRunner：空观测的形状必须靠 available 区分开
    const bare = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite });
    try {
      const res = await bare.inject({
        method: 'GET', url: '/api/v1/runtime/cli',
        headers: { cookie: adminCookie, origin: BASE_URL },
      });
      expect(res.statusCode).toBe(200);
      const data = (res.json() as Json).data as CliRuntimeData;
      expect(data.available).toBe(false);
      expect(data.runs).toEqual([]);
      expect(data.stats).toMatchObject({ active: 0, total: 0 });
      expect(data.health).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it('DELETE 不存在的 runId → 404（不伪造成功）', async () => {
    const r = await api('DELETE', '/api/v1/runtime/cli/no-such-run', adminCookie);
    expect(r.status).toBe(404);
    expect(r.json.code).toBe(404);
  });

  it('DELETE 在飞 runId → killed:true，进程结束后登记清空，并写 runtime_cli_kill 审计', async () => {
    // 真启动一个长驻子进程：kill 必须作用在真实在飞登记上（用 mock 列表测不出 tree-kill 是否发出）
    const running = cliRunner.exec({
      asset: {
        id: 'srv-cli-ok', name: 'cli-runtime-demo', category: 'other', ownerId: null,
        executionMode: 'cli', command: CLI_BIN, url: null, env: {}, args: [], credentialSlots: [],
        configHash: 'ch-cli-1',
      },
      argv: ['-e', 'setTimeout(() => {}, 30000)'],
      credentials: {},
      userId: 'u-admin',
    });

    // 等在飞登记可见（exec 内部 spawn 后立即登记；这里轮询端点，顺带验证 GET 能看到在飞进程）
    let data: CliRuntimeData | undefined;
    for (let i = 0; i < 50; i++) {
      const listed = await api('GET', '/api/v1/runtime/cli', adminCookie);
      data = listed.json.data as CliRuntimeData;
      if (data.runs.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(data?.runs).toHaveLength(1);
    const runId = data!.runs[0]!.runId;
    expect(data!.runs[0]!.assetId).toBe('srv-cli-ok');
    expect(data!.stats.active).toBe(1);
    expect(data!.stats.total).toBe(1);

    const killed = await api('DELETE', `/api/v1/runtime/cli/${encodeURIComponent(runId)}`, adminCookie);
    expect(killed.status).toBe(200);
    expect((killed.json.data as { killed: boolean }).killed).toBe(true);

    // 进程收尾后 exec 必须 settle（tree-kill 生效的证据），登记随之清空
    await running;
    const after = await api('GET', '/api/v1/runtime/cli', adminCookie);
    expect((after.json.data as CliRuntimeData).runs).toHaveLength(0);
    expect((after.json.data as CliRuntimeData).stats.active).toBe(0);

    const table = auditTableName(new Date());
    const hit = sqlite
      .prepare(`SELECT action, server_name, input_summary FROM "${table}" WHERE action = 'runtime_cli_kill'`)
      .all() as Array<{ action: string; server_name: string; input_summary: string }>;
    expect(hit).toHaveLength(1);
    expect(hit[0]!.server_name).toBe('CLI 运行时演示');
    expect(hit[0]!.input_summary).toContain(runId);
  });

  it('metrics 含 CLI 两个指标行，total 反映真实执行次数', async () => {
    const text = await metrics(adminCookie);
    expect(text).toContain('# TYPE opsgate_cli_executions_active gauge');
    expect(text).toMatch(/^opsgate_cli_executions_active \d+$/m);
    expect(text).toContain('# TYPE opsgate_cli_executions_total counter');
    // 上一条用例真跑过一次（并在其中被 kill），total 至少为 1
    const m = /^opsgate_cli_executions_total (\d+)$/m.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(cliRunner.stats().total);
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);
  });
});
