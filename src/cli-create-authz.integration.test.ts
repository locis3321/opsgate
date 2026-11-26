/**
 * 最终审查 C-1 / I-1：CLI 资产创建的**授权边界**与 args/headers 拒绝。
 *
 * 用户决策：**admin 可建任意 CLI 资产；成员只能建白名单二进制**（L1 `cli.member_allowed_binaries`）。
 * 为什么这是安全边界而不是体验优化：CLI 资产的 `command` 就是网关主机上要 spawn 的程序，
 * 成员能建 `command='bash'` 的资产等于拿到"以网关进程身份跑任意程序"的口子。
 *
 * 断言：
 * 1. 成员 + `bash`（不在白名单）→ 403 且**不落库**；
 * 2. 成员 + 白名单内的二进制 → 200（白名单按 **basename** 比对：绝对路径也能命中）；
 * 3. 成员 + 绝对路径但 basename 不在白名单 → 403（写全路径不能绕过）；
 * 4. 白名单空数组 = 成员一个也建不了（明确语义，不是"未配置就放行"）；
 * 5. admin + `bash` → 200（admin 不受白名单限制）；
 * 6. I-1：cli 资产带非空 `args` / `headers` → 400（本期 CLI 链路只跑 bin+argv，静默丢弃违反 §2 原则 5），
 *    admin 同样被拒；空 `[]` / `{}` 等价于未传 → 200；
 * 6b. **非法形态**（最终审查复检 Important-1）：`args: '--version'`（字符串）/ `args: {a:1}`（对象）/
 *    `headers: 'Authorization'`（字符串）都必须 400 —— 原判据只认"非空数组/非空对象"，
 *    字符串与对象形态会漏过（前者静默落库、后者在 `for...of` 处抛 TypeError 变 500）；
 * 7. Market 实例化 cli 条目同口径：非 admin + bin 不在白名单 → 403 不落库；admin 放行；
 *    条目 installations 声明了 args/headers → 400；
 * 8. 回归：非 cli 资产不受白名单影响；
 * 9. 白名单配置容错：非数组（字符串）→ 成员全 403（fail-closed）；条目带空格 → trim 后命中；
 * 10. command 落库值 trim（校验口径与生效口径一致）；
 * 11. 403 留审计 `cli_create_denied`（含 command 与 actor，status=blocked）。
 *
 * 白名单注入方式：用真实 `Settings`（schema 默认值生效）+ `setCache` 改当前生效值——
 * 与 `/settings` PATCH 的热生效路径同一份读语义（AC-55），不改生产代码去迁就测试。
 *
 * 平台与二进制：`cliCreateError` 读 `process.platform`（部署事实是 Linux），开发机是 Windows，
 * 正向用例用 `withPlatform('linux')` 临时改写并还原；二进制用 `process.execPath`（一定存在），
 * 使"白名单命中 → 200"不依赖测试机是否装了 kubectl。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { SETTINGS_BY_KEY } from './config/settingsSchema.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CredentialService } from './services/credentials.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import type { CatalogEntry } from './services/marketCatalog.js';
import { buildApp } from './app.js';

// CLI 的 url 可能被填成 host:port（本站用例不填 url），但 app 装配会加载 SSRF 模块；
// 固定 DNS 让任何解析结果都与网络环境无关。
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

/** 测试用 CLI 条目：bin 用 process.execPath（一定存在），白名单决定成员能否实例化 */
const TEST_CLI_ENTRY: CatalogEntry = {
  key: 'test-cli-authz',
  name: 'test-cli-authz',
  displayName: '测试：CLI 授权边界',
  description: '',
  repository: 'https://example.invalid/cli',
  categories: ['other'],
  tags: ['cli'],
  runtime: 'npm',
  executionMode: 'cli',
  // bin 用本机 node 的绝对路径：一定存在且可执行，"白名单命中 → 200"不依赖测试机装了什么
  cli: { bin: process.execPath },
  slotLabels: {},
  installations: { npm: {} },
};

/** 负例条目：installations 声明了 args（I-1 第二半：条目声明也不许落进 CLI 资产） */
const TEST_CLI_ENTRY_WITH_ARGS: CatalogEntry = {
  ...TEST_CLI_ENTRY,
  key: 'test-cli-authz-args',
  name: 'test-cli-authz-args',
  displayName: '测试：CLI 条目带 args',
  installations: { npm: { args: ['--prefix'] } },
};

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let settings: Settings;
let adminCookie: string;
let memberCookie: string;

/** 本机 node 二进制的 basename（白名单按 basename 比对） */
const NODE_BIN = path.basename(process.execPath);

async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** 临时改白名单生效值（与 PATCH /settings 的热生效同一读路径）；用例内自行恢复 */
function setWhitelist(bins: unknown): void {
  settings.setCache('cli.member_allowed_binaries', bins);
}

/** 审计月表名（与 AuditService.writeIntent 的建表规则一致） */
function auditTable(): string {
  const now = new Date();
  return `audit_log_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function auditCount(action: string): number {
  const table = auditTable();
  // 该月表只在有写入时由 ensureAuditTable 创建：还没写过审计就是 0 行（不是错误）
  const exists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name: string } | undefined;
  if (!exists) return 0;
  const row = sqlite.prepare(`SELECT COUNT(*) c FROM ${table} WHERE action = ?`).get(action) as { c: number };
  return row.c;
}

/** 最近一条指定 action 的审计摘要（input_summary 是脱敏后的 JSON 串） */
function lastAuditSummary(action: string): { status: string; input_summary: string } | undefined {
  const table = auditTable();
  const exists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name: string } | undefined;
  if (!exists) return undefined;
  return sqlite
    .prepare(`SELECT status, input_summary FROM ${table} WHERE action = ? ORDER BY ts DESC LIMIT 1`)
    .get(action) as { status: string; input_summary: string } | undefined;
}

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'cli-authz-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'admin', password: 'password-12345', isAdmin: true });
  await createUserWithPassword(auth, { username: 'member', password: 'password-12345', isAdmin: false });
  app = await buildApp({
    db, auth, baseUrl: BASE_URL, settings, cryptoKey, sqlite, audit, credentials,
    // Market 路由仅在 instancePool + credentials 齐备时注册；CLI 条目不会走实例池
    instancePool: {
      invalidate: () => {}, acquire: async () => { throw new Error('unused'); },
      release: async () => {}, releaseAll: async () => {}, prewarm: async () => 0,
    } as never,
    // 不走 market_entries 表，直接注入条目（entryOf 优先用注入集）
    marketEntries: [TEST_CLI_ENTRY, TEST_CLI_ENTRY_WITH_ARGS],
  });

  const signIn = async (username: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const c = res.headers['set-cookie'];
    return (Array.isArray(c) ? c : [c])[0]!.split(';')[0]!;
  };
  adminCookie = await signIn('admin');
  memberCookie = await signIn('member');
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); });

interface Json { code: number; data: unknown; message: string }

async function createAsset(cookie: string, payload: Record<string, unknown>): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/servers',
    payload: JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function instantiate(cookie: string, payload: Record<string, unknown>): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/market/instantiate',
    payload: JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

const rowByName = async (name: string) =>
  await db.select().from(schema.servers).where(eq(schema.servers.name, name)).get();

/** cli 资产请求体（形态复用 type=native，见 Spec §4.1.1） */
function cliPayload(name: string, command: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, type: 'native', executionMode: 'cli', category: 'other', command, ...extra };
}

describe('设置项声明（L1 cli.member_allowed_binaries）', () => {
  it('是 json 列表、热生效、非 secret，默认覆盖一期运维工具', () => {
    const def = SETTINGS_BY_KEY.get('cli.member_allowed_binaries')!;
    expect(def).toBeDefined();
    expect(def.type).toBe('json');
    expect(def.requiresRestart).toBe(false);
    expect(def.secret).toBe(false);
    expect(def.default).toEqual(['kubectl', 'mysql', 'redis-cli', 'kafka-topics.sh', 'mc', 'jq']);
  });
});

describe('C-1 POST /servers：CLI 创建授权（成员白名单 / admin 任意）', { timeout: 30_000 }, () => {
  it('成员建 command=bash（不在白名单）→ 403 且不落库', async () => {
    setWhitelist(['kubectl', 'mysql']);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-member-bash', 'bash')));
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.message).toContain('白名单');
    expect(await rowByName('cli-member-bash')).toBeUndefined();
  });

  it('成员建白名单内的二进制（绝对路径按 basename 命中）→ 200 且落库', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-member-allowed', process.execPath)));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const row = await rowByName('cli-member-allowed');
    expect(row?.executionMode).toBe('cli');
    expect(row?.command).toBe(process.execPath);
  });

  it('成员用绝对路径但 basename 不在白名单 → 403（写全路径不能绕过）', async () => {
    setWhitelist(['kubectl']);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-member-abs', process.execPath)));
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(await rowByName('cli-member-abs')).toBeUndefined();
  });

  it('白名单为空数组 → 成员一个也建不了（不是"未配置就放行"）', async () => {
    setWhitelist([]);
    // 默认白名单里的 kubectl 也被拒：生效值以 settings 为准，不是 schema 默认
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-member-empty-wl', process.execPath)));
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(await rowByName('cli-member-empty-wl')).toBeUndefined();
  });

  it('admin 建 command=bash（不在白名单）→ 200（admin 不受白名单限制）', async () => {
    setWhitelist([]);
    const r = await withPlatform('linux', () => createAsset(adminCookie, cliPayload('cli-admin-bash', 'bash')));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await rowByName('cli-admin-bash'))?.command).toBe('bash');
  });

  it('回归：非 cli 资产不受白名单影响（成员仍可建 mcp stdio）', async () => {
    setWhitelist([]);
    const r = await createAsset(memberCookie, {
      name: 'member-mcp-stdio', type: 'stdio', executionMode: 'mcp', category: 'other', command: 'definitely-not-a-bin-xyz',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await rowByName('member-mcp-stdio'))?.executionMode).toBe('mcp');
  });

  // —— 白名单配置容错（复检 Minor） ——
  it('白名单被写成字符串（非数组）→ 成员 403（fail-closed，不是"读不到就放行"）', async () => {
    // settings 的 type:'json' 会挡住这种值从 PATCH 入口进来，但 stub / 直接写库 / 未来改类型都可能出现。
    // 判据必须自己对形态免疫：非数组 → 空白名单。
    setWhitelist('kubectl');
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-wl-str', process.execPath)));
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(await rowByName('cli-wl-str')).toBeUndefined();
  });

  it('白名单条目带空格（" kubectl "）→ trim 后仍命中，不静默失效', async () => {
    setWhitelist([` ${NODE_BIN} `]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-wl-space', process.execPath)));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await rowByName('cli-wl-space')).toBeDefined();
  });

  it('白名单条目只有空白 → 等价于空条目（成员建不了）', async () => {
    // 空白条目 trim 后为空 → 丢弃；不能变成"匹配空串"从而对任何 basename 都放行
    setWhitelist(['   ']);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-wl-blank', process.execPath)));
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(await rowByName('cli-wl-blank')).toBeUndefined();
  });

  // —— command 落库值 trim（复检 Minor：校验口径 = 生效口径） ——
  it('command 带首尾空格 → 落库值是 trim 后的（校验、白名单与 spawn 用同一个值）', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () =>
      createAsset(memberCookie, cliPayload('cli-cmd-space', `  ${process.execPath}  `)),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await rowByName('cli-cmd-space'))?.command).toBe(process.execPath);
  });

  // —— 403 留审计（复检可选增强） ——
  it('成员被 403 时写一条 cli_create_denied 审计（含 command 与 actor，status=blocked）', async () => {
    setWhitelist(['kubectl']);
    const before = auditCount('cli_create_denied');
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-audit-denied', 'bash')));
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.message).not.toContain('kubectl'); // 不回显白名单内容
    expect(auditCount('cli_create_denied')).toBe(before + 1);

    const row = lastAuditSummary('cli_create_denied');
    expect(row?.status).toBe('blocked');
    expect(row?.input_summary).toContain('bash');
    const member = sqlite.prepare("SELECT id FROM users WHERE username='member'").get() as { id: string };
    const actor = sqlite
      .prepare(`SELECT user_id FROM ${auditTable()} WHERE action='cli_create_denied' ORDER BY ts DESC LIMIT 1`)
      .get() as { user_id: string };
    expect(actor.user_id).toBe(member.id);
  });
});

describe('I-1 POST /servers：cli 资产的 args/headers 显式拒绝', { timeout: 30_000 }, () => {
  it('成员建 cli 资产带非空 args → 400 且不落库', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-args', process.execPath, { args: ['--version'] })));
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.message).toContain('argv');
    expect(await rowByName('cli-args')).toBeUndefined();
  });

  it('成员建 cli 资产带非空 headers → 400 且不落库', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-headers', process.execPath, { headers: { Authorization: 'Bearer x' } })));
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.message).toContain('argv');
    expect(await rowByName('cli-headers')).toBeUndefined();
  });

  it('admin 带非空 args 同样 400（能力缺失对所有人一致，不是成员专属限制）', async () => {
    const r = await withPlatform('linux', () => createAsset(adminCookie, cliPayload('cli-admin-args', 'bash', { args: ['-c'] })));
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(await rowByName('cli-admin-args')).toBeUndefined();
  });

  it('args: [] / headers: {} 等价于未传 → 200（不误伤合法请求）', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-empty-fields', process.execPath, { args: [], headers: {} })));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await rowByName('cli-empty-fields')).toBeDefined();
  });

  // —— 非法形态（复检 Important-1）：原判据只认"非空数组 / 非空对象"，以下几种都漏过 ——
  it('args 是字符串（"--version"）→ 400 且不落库（不是 200 静默落库）', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-args-str', process.execPath, { args: '--version' })));
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.message).toContain('argv');
    expect(await rowByName('cli-args-str')).toBeUndefined();
  });

  it('args 是非数组对象（{a:1}）→ 400 且不落库（不是 500 不可迭代）', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-args-obj', process.execPath, { args: { a: 1 } })));
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.message).toContain('argv');
    expect(await rowByName('cli-args-obj')).toBeUndefined();
  });

  it('headers 是字符串（"Authorization"）→ 400 且不落库（不是 200 静默落库）', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-headers-str', process.execPath, { headers: 'Authorization' })));
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.message).toContain('argv');
    expect(await rowByName('cli-headers-str')).toBeUndefined();
  });

  it('args 是数字（0 / 1）→ 400 且不落库（非法标量同样不是"未传"）', async () => {
    setWhitelist([NODE_BIN]);
    const r1 = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-args-num', process.execPath, { args: 1 })));
    expect(r1.status, JSON.stringify(r1.json)).toBe(400);
    expect(await rowByName('cli-args-num')).toBeUndefined();
  });

  it('args: null / 空字符串 → 视为未传（200），只有"带了内容"才拒绝', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => createAsset(memberCookie, cliPayload('cli-args-null', process.execPath, { args: null, headers: '' })));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await rowByName('cli-args-null')).toBeDefined();
  });
});

describe('C-1 / I-1 Market 实例化 cli 条目同口径', { timeout: 30_000 }, () => {
  it('非 admin + bin 不在白名单 → 403 且不落库', async () => {
    setWhitelist(['kubectl']);
    const r = await withPlatform('linux', () => instantiate(memberCookie, { pkgName: TEST_CLI_ENTRY.key, name: 'mkt-cli-member' }));
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.message).toContain('白名单');
    expect(await rowByName('mkt-cli-member')).toBeUndefined();
  });

  it('admin + 同一空白名单 → 200（403 的判据是角色，不是配置不可用）', async () => {
    setWhitelist([]);
    const r = await withPlatform('linux', () => instantiate(adminCookie, { pkgName: TEST_CLI_ENTRY.key, name: 'mkt-cli-admin' }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const row = await rowByName('mkt-cli-admin');
    expect(row?.executionMode).toBe('cli');
    expect(row?.command).toBe(process.execPath);
    expect(row?.args).toEqual([]);
  });

  it('非 admin + bin 在白名单 → 200（成员仍能用内置 CLI 条目）', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => instantiate(memberCookie, { pkgName: TEST_CLI_ENTRY.key, name: 'mkt-cli-member-ok' }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await rowByName('mkt-cli-member-ok'))?.command).toBe(process.execPath);
  });

  it('条目 installations 声明了 args → 400（条目声明也不许落成 CLI 资产的 args）', async () => {
    setWhitelist([NODE_BIN]);
    const r = await withPlatform('linux', () => instantiate(adminCookie, { pkgName: TEST_CLI_ENTRY_WITH_ARGS.key, name: 'mkt-cli-entry-args' }));
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.message).toContain('argv');
    expect(await rowByName('mkt-cli-entry-args')).toBeUndefined();
  });

  it('Market 侧 403 同样留 cli_create_denied 审计（两条入口口径一致）', async () => {
    setWhitelist(['kubectl']);
    const before = auditCount('cli_create_denied');
    const r = await withPlatform('linux', () => instantiate(memberCookie, { pkgName: TEST_CLI_ENTRY.key, name: 'mkt-cli-denied-audit' }));
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(await rowByName('mkt-cli-denied-audit')).toBeUndefined();
    expect(auditCount('cli_create_denied')).toBe(before + 1);
    expect(lastAuditSummary('cli_create_denied')?.input_summary).toContain('market/instantiate');
  });
});
