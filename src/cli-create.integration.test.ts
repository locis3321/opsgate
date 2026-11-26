/**
 * Task 7：CLI 资产创建校验（fail-closed，设计说明 D13）。
 *
 * 断言四件事：
 * 1. cli + PATH 里不存在的二进制 → 400（避免建出永远跑不起来的资产）；
 * 2. cli + `echo` → 200 且落库 executionMode='cli'（正向路径真的通得了）；
 * 3. cli + 缺 command → 400（必填事实缺失显式失败，不猜默认值）；
 * 4. 非 cli 资产创建不受影响（mcp stdio 回归）。
 * 另加平台闸门：非 Linux 一律 400「CLI 资产仅支持 Linux 部署」（部署目标是 Linux）。
 * 另加 fail-open 回归（Task 7 修复轮）：`--version` 选项注入、目录冒充二进制、非字符串 command、
 * 绝对路径正向用例，以及 `type!=='native'` 与 executionMode=cli 矛盾的形态校验。
 *
 * 平台注入说明：路由里的平台判定读 `process.platform`（生产事实），开发机是 Windows，
 * 因此正向用例用 `withPlatform('linux')` 临时改写该属性（Node 允许 defineProperty），
 * 用例结束还原——不改生产代码去迁就测试环境。
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
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CredentialService } from './services/credentials.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';

/**
 * SSRF 的 DNS 解析固定化（与 market-cli.integration.test.ts 同构，但按主机分流）：
 * - `db.internal` → 私网 10.1.2.3，用来复现"内网域名"这条分支；
 * - 其余主机 → RFC 5737 公网保留段 203.0.113.10，用来复现"可解析的公网域名"。
 * 若像 market-cli 那样一律返回公网地址，`db.internal` 会被判成公网，私网域名分支就测不出来。
 */
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) =>
    host === 'db.internal'
      ? [{ address: '10.1.2.3', family: 4 }]
      : [{ address: '203.0.113.10', family: 4 }],
}));

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let cookie: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'cli-create-k-')), 'k'));
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: true });
  app = await buildApp({
    db, auth, baseUrl: BASE_URL, settings, cryptoKey, sqlite,
    audit: new AuditService(sqlite, settings),
    credentials: new CredentialService(sqlite, cryptoKey),
  });

  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username: 'alice', password: 'password-12345' },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const c = res.headers['set-cookie'];
  cookie = (Array.isArray(c) ? c : [c])[0]!.split(';')[0]!;
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); });

interface Json { code: number; data: unknown; message: string }

async function createAsset(payload: Record<string, unknown>): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/servers',
    payload: JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function patchAsset(id: string, payload: Record<string, unknown>): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method: 'PATCH', url: `/api/v1/servers/${id}`,
    payload: JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

/**
 * 临时把 process.platform 伪装成指定值，用例结束还原。
 * 只影响被包裹的那一次调用；vitest 同文件内用例串行执行。
 */
async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const rowByName = async (name: string) =>
  await db.select().from(schema.servers).where(eq(schema.servers.name, name)).get();

describe('CLI 资产创建校验（fail-closed）', { timeout: 20_000 }, () => {
  it('cli + PATH 里不存在的二进制 → 400，且不落库', async () => {
    const r = await withPlatform('linux', () => createAsset({
      name: 'cli-missing-bin', type: 'native', executionMode: 'cli', category: 'other',
      command: 'definitely-not-a-bin-xyz',
    }));
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('definitely-not-a-bin-xyz');
    expect(await rowByName('cli-missing-bin')).toBeUndefined();
  });

  it('cli + 存在的二进制（echo）→ 200，落库 executionMode=cli', async () => {
    const r = await withPlatform('linux', () => createAsset({
      name: 'cli-echo', type: 'native', executionMode: 'cli', category: 'other',
      command: 'echo',
    }));
    expect(r.status).toBe(200);
    const row = await rowByName('cli-echo');
    expect(row?.executionMode).toBe('cli');
    expect(row?.command).toBe('echo');
  });

  it('cli 缺 command → 400（必填事实缺失显式失败）', async () => {
    const r = await withPlatform('linux', () => createAsset({
      name: 'cli-no-cmd', type: 'native', executionMode: 'cli', category: 'other',
    }));
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('二进制');
    expect(await rowByName('cli-no-cmd')).toBeUndefined();
  });

  it('command 以 -- 开头（which 选项注入）→ 400，不落库', async () => {
    // `which --version` 自身 status=0 → 旧实现误判为"二进制存在"（fail-open）。
    // 修法是 `which -- <bin>` 结束选项解析，所以这里必须是 400。
    const r = await withPlatform('linux', () => createAsset({
      name: 'cli-opt-inject', type: 'native', executionMode: 'cli', category: 'other',
      command: '--version',
    }));
    expect(r.status).toBe(400);
    expect(await rowByName('cli-opt-inject')).toBeUndefined();
  });

  it('command 指向目录（/tmp）→ 400，不落库', async () => {
    // 目录的 X_OK（可搜索）为真 → 旧实现只判 accessSync(X_OK) 会放行（fail-open）。
    const r = await withPlatform('linux', () => createAsset({
      name: 'cli-dir', type: 'native', executionMode: 'cli', category: 'other',
      command: '/tmp',
    }));
    expect(r.status).toBe(400);
    expect(await rowByName('cli-dir')).toBeUndefined();
  });

  it('command 是非字符串（123）→ 400，不是未捕获 500', async () => {
    const r = await withPlatform('linux', () => createAsset({
      name: 'cli-non-str', type: 'native', executionMode: 'cli', category: 'other',
      command: 123,
    }));
    expect(r.status).toBe(400);
    expect(await rowByName('cli-non-str')).toBeUndefined();
  });

  it('command 是绝对路径的普通可执行文件 → 200', async () => {
    const r = await withPlatform('linux', () => createAsset({
      name: 'cli-abs-path', type: 'native', executionMode: 'cli', category: 'other',
      command: process.execPath,
    }));
    expect(r.status).toBe(200);
    expect((await rowByName('cli-abs-path'))?.command).toBe(process.execPath);
  });

  it('cli 但 type=stdio（形态与执行方式矛盾）→ 400，不落库', async () => {
    const r = await withPlatform('linux', () => createAsset({
      name: 'cli-stdio', type: 'stdio', executionMode: 'cli', category: 'other',
      command: 'echo',
    }));
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('native');
    expect(await rowByName('cli-stdio')).toBeUndefined();
  });

  it('非 Linux 平台 → 400「CLI 资产仅支持 Linux 部署」', async () => {
    const r = await withPlatform('win32', () => createAsset({
      name: 'cli-win', type: 'native', executionMode: 'cli', category: 'other', command: 'echo',
    }));
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('Linux');
    expect(await rowByName('cli-win')).toBeUndefined();
  });

  it('回归：非 cli 资产创建不受影响（mcp stdio 仍可建）', async () => {
    const r = await createAsset({
      name: 'mcp-stdio-ok', type: 'stdio', executionMode: 'mcp', category: 'other', command: 'echo',
    });
    expect(r.status).toBe(200);
    const row = await rowByName('mcp-stdio-ok');
    expect(row?.executionMode).toBe('mcp');
  });
});

/**
 * CLI 资产的 `host:port` 目标地址必须真的过 SSRF 闸门（Task 8 修复轮 2）。
 *
 * 旁路成因：`new URL('db.internal:3306')` 把 `db.internal:` 当 scheme、hostname 是空串；
 * `assertUrlAllowed` 对空 hostname 走域名分支，`lookup('')` 在 Node 返回**空数组而不抛错**，
 * 逐个地址的判定循环一次都不执行 → 校验静默通过（fail-open）。
 * 因此这里钉住：PATCH 与 POST 两条写入口都先把裸 `host:port` 归一化，再显式要求解析出主机名。
 */
describe('CLI 目标地址的 SSRF 校验（PATCH / POST）', { timeout: 20_000 }, () => {
  /** 建一个 cli 资产（不带 url）：平台与 PATH 同既有用例，command=echo 保证能过二进制探测 */
  async function makeCli(name: string): Promise<string> {
    const r = await withPlatform('linux', () => createAsset({
      name, type: 'native', executionMode: 'cli', category: 'other', command: 'echo',
    }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return (r.json.data as { id: string }).id;
  }

  it('PATCH url=db.internal:3306（私网域名）→ 400；同请求开 allowPrivateNetwork → 200', async () => {
    const id = await makeCli('cli-patch-priv-domain');

    const denied = await patchAsset(id, { url: 'db.internal:3306' });
    expect(denied.status, JSON.stringify(denied.json)).toBe(400);
    expect(denied.json.message).toContain('SSRF');
    // 未通过校验就不得落库（不留"看起来改成功"的行）
    expect((await rowByName('cli-patch-priv-domain'))?.url).toBeNull();

    // 同一请求带上开关 → 按"变更后的最终值"判定，不必发两次
    const allowed = await patchAsset(id, { url: 'db.internal:3306', allowPrivateNetwork: true });
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
    expect((await rowByName('cli-patch-priv-domain'))?.url).toBe('db.internal:3306');
  });

  it('PATCH url 改为可解析的公网目标 → 200（归一化不误伤正常地址）', async () => {
    const id = await makeCli('cli-patch-pub-domain');
    // lookup 被固定为公网保留段（见文件头 mock），故 example.invalid 视为可解析的公网域名
    const r = await patchAsset(id, { url: 'example.invalid:3306' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await rowByName('cli-patch-pub-domain'))?.url).toBe('example.invalid:3306');
  });

  it('PATCH url=10.0.0.5:3306（私网 IP）→ 400，且不落库', async () => {
    const id = await makeCli('cli-patch-priv-ip');
    const r = await patchAsset(id, { url: '10.0.0.5:3306' });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.message).toContain('SSRF');
    expect((await rowByName('cli-patch-priv-ip'))?.url).toBeNull();
  });

  it('PATCH allowPrivateNetwork 非布尔（"false"/"no"/1/0）→ 400，不把字符串当 truthy 开启私网', async () => {
    const id = await makeCli('cli-patch-allowpt-badtype');
    // 只传 allowPrivateNetwork（不带 url），验证类型校验独立生效，而非被 SSRF 顺带挡下
    for (const bad of ['false', 'no', 1, 0]) {
      const r = await patchAsset(id, { allowPrivateNetwork: bad });
      expect(r.status, `bad=${JSON.stringify(bad)} → ${JSON.stringify(r.json)}`).toBe(400);
    }
    // 合法布尔仍可改
    const ok = await patchAsset(id, { allowPrivateNetwork: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await rowByName('cli-patch-allowpt-badtype'))?.allowPrivateNetwork).toBe(true);
  });

  it('归一化后仍取不到主机名 → 400（不把"没校验"当通过）', async () => {
    const id = await makeCli('cli-patch-no-host');
    // ':3306' / '/tmp/x' 归一化成 tcp:// 后 hostname 仍是空串：旧实现会把空数组当"无违规地址"放行
    for (const bad of [':3306', '/tmp/x']) {
      const r = await patchAsset(id, { url: bad });
      expect(r.status, `${bad} 应被拒绝`).toBe(400);
      expect(r.json.message).toContain('主机名');
    }
    expect((await rowByName('cli-patch-no-host'))?.url).toBeNull();
  });

  it('创建路径同口径：cli + url=db.internal:3306 → 400；开私网开关 → 200', async () => {
    // 创建与 PATCH 必须一致，否则换个入口就能绕过
    const denied = await withPlatform('linux', () => createAsset({
      name: 'cli-create-priv', type: 'native', executionMode: 'cli', category: 'other',
      command: 'echo', url: 'db.internal:3306',
    }));
    expect(denied.status, JSON.stringify(denied.json)).toBe(400);
    expect(denied.json.message).toContain('SSRF');
    expect(await rowByName('cli-create-priv')).toBeUndefined();

    const allowed = await withPlatform('linux', () => createAsset({
      name: 'cli-create-priv', type: 'native', executionMode: 'cli', category: 'other',
      command: 'echo', url: 'db.internal:3306', allowPrivateNetwork: true,
    }));
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
    expect((await rowByName('cli-create-priv'))?.url).toBe('db.internal:3306');
  });

  it('回归：非 cli 资产 PATCH url 仍是原 URL 语义（私网 400 / 公网 200）', async () => {
    const created = await createAsset({
      name: 'mcp-http-patch', type: 'http', executionMode: 'mcp', category: 'other',
      url: 'http://203.0.113.10:8080/mcp',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = (created.json.data as { id: string }).id;

    const denied = await patchAsset(id, { url: 'http://10.0.0.5:8080/mcp' });
    expect(denied.status, JSON.stringify(denied.json)).toBe(400);
    expect(denied.json.message).toContain('SSRF');

    const ok = await patchAsset(id, { url: 'http://203.0.113.11:8080/mcp' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await rowByName('mcp-http-patch'))?.url).toBe('http://203.0.113.11:8080/mcp');
  });
});
