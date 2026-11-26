/**
 * Task 8：Market CLI 条目（ADR-037 / 设计说明 §6）。
 *
 * 断言：
 * 1. 内置目录含 4 条 `executionMode='cli'` 条目，且目录列表接口把它们暴露为 cli；
 * 2. 实例化 kubectl-cli → 落库 `executionMode='cli'`、`command='kubectl'`、env 含 KUBECONFIG、
 *    url 取 body.url、credentialSlots 里 KUBECONFIG 是文件类槽位；
 * 3. 条目的 bin 在主机上不存在 → 400（与 `POST /servers` 共用 `cliCreateError`，同口径 fail-closed），
 *    且不落任何行；
 * 4. cli 的 body.url 走 SSRF 闸门（D12）：公网放行、私网默认 400、显式 allowPrivateNetwork 放行；
 * 5. mysql-cli 的 env 承接 `${OPSGATE_TARGET}`：填的目标地址真成为 MYSQL_HOST（CliRunner 渲染）；
 * 6. cli 条目收到非空 body.config → 400（不静默丢弃用户改动）。
 *
 * SSRF 与 DNS：`assertUrlAllowed` 对域名做 `lookup`，`.invalid` 在真实 DNS 上解析失败即
 * fail-closed 拒绝。故本文件把 `node:dns/promises` 的 lookup 固定为一段**公网文档地址**
 * （203.0.113.0/24，RFC 5737 保留段，ipaddr.js 判为 reserved 非 private），
 * 使"可解析的域名"这一前提确定化，同时不触网。
 *
 * 平台与 PATH 注入说明（与 cli-create.integration.test.ts 同构）：
 * - `cliCreateError` 的平台判定读 `process.platform`（部署事实是 Linux），开发机是 Windows，
 *   正向用例用 `withPlatform('linux')` 临时改写并在 `finally` 还原；
 * - 二进制解析走 `which` 子进程（它继承调用方 PATH），因此正向用例把临时目录里的
 *   `kubectl` / `mysql` 垫到 PATH 最前面——不依赖开发机/CI 是否真装了它们，也不改生产代码。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CredentialService } from './services/credentials.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { loadCatalog, type CatalogEntry } from './services/marketCatalog.js';
import { entryToRow } from './db/marketEntries.js';
import { buildApp } from './app.js';

// SSRF 的 DNS 解析固定为公网保留段：让"域名可解析"确定成立，且判定结果与网络环境无关
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

/** 测试专用条目：bin 明确不存在，用于校验复用 `cliCreateError` 的 fail-closed 分支 */
const BROKEN_CLI_ENTRY: CatalogEntry = {
  key: 'test-cli-missing-bin',
  name: 'test-cli-missing-bin',
  displayName: '测试：二进制不存在',
  description: '',
  repository: 'https://example.invalid/cli',
  categories: ['other'],
  tags: ['cli'],
  runtime: 'npm',
  executionMode: 'cli',
  cli: { bin: 'definitely-not-a-bin-xyz' },
  slotLabels: {},
  installations: { npm: {} },
};

const CLI_KEYS = ['kafka-topics-cli', 'kubectl-cli', 'mysql-cli', 'redis-cli-cli'];

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let cookie: string;
/** PATH 垫片目录：放一个名为 kubectl 的可执行文件，模拟"主机已预装" */
let shimDir: string;

/** 临时把 process.platform 伪装成指定值，用例结束还原（该属性 configurable，Node 允许改写） */
async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** 临时把 shimDir 垫到 PATH 最前，用例结束还原原值 */
async function withShimPath<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${original ?? ''}`;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'mkt-cli-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: true });
  // 与生产首启同一条种子路径（ADR-029 / marketSeedSync）：内置目录 + 负例条目落 market_entries
  const catalog = [...loadCatalog(), BROKEN_CLI_ENTRY];
  for (const entry of catalog) {
    db.insert(schema.marketEntries).values(entryToRow(entry, 'verified'))
      .onConflictDoNothing({ target: schema.marketEntries.key }).run();
  }

  shimDir = mkdtempSync(path.join(tmpdir(), 'mkt-cli-bin-'));
  writeFileSync(path.join(shimDir, 'kubectl'), '#!/bin/sh\necho stub\n', { mode: 0o755 });
  writeFileSync(path.join(shimDir, 'mysql'), '#!/bin/sh\necho stub\n', { mode: 0o755 });

  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, credentials,
    // 不注入 catalogEntries：走生产同一条路径——条目从 market_entries 表读，
    // 顺便验证 cli 段在落库/读回之间不丢（entryToRow / rowToEntry 的往返）
    instancePool: { invalidate: () => {}, acquire: async () => { throw new Error('unused'); }, release: async () => {}, releaseAll: async () => {}, prewarm: async () => 0 } as never,
  });

  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username: 'alice', password: 'password-12345' },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const c = res.headers['set-cookie'];
  cookie = (Array.isArray(c) ? c : [c])[0]!.split(';')[0]!;
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }
async function api(method: 'POST' | 'GET', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

const rowOf = (name: string) => db.select().from(schema.servers).all().find((r) => r.name === name);

describe('Market CLI 条目', () => {
  it('目录含 4 条 executionMode=cli，且列表接口按 cli 暴露', async () => {
    expect(loadCatalog().filter((e) => e.executionMode === 'cli').map((e) => e.key).sort()).toEqual(CLI_KEYS);
    const r = await api('GET', '/api/v1/market/catalog');
    expect(r.status).toBe(200);
    const items = (r.json.data as { items: Array<{ key: string; executionMode: string }> }).items;
    for (const key of CLI_KEYS) {
      expect(items.find((i) => i.key === key)?.executionMode, `${key} 未按 cli 暴露`).toBe('cli');
    }
  });

  it('实例化 kubectl-cli → 落库 cli / command=kubectl / env 含 KUBECONFIG / url 入列', async () => {
    const r = await withPlatform('linux', () => withShimPath(() => api('POST', '/api/v1/market/instantiate', {
      pkgName: 'kubectl-cli',
      name: 'k8s-prod',
      url: 'https://k8s.example.invalid:6443',
    })));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const row = rowOf('k8s-prod');
    expect(row, '资产未落库').toBeDefined();
    expect(row!.executionMode).toBe('cli');
    // 形态复用 native（无 MCP 子进程包装），但执行方式是 cli
    expect(row!.type).toBe('native');
    expect(row!.command).toBe('kubectl');
    expect(row!.args).toEqual([]);
    // env 保留 `${KUBECONFIG}` 模板：值由 CliRunner 在运行时按槽位渲染，库内不落明文
    expect(row!.env).toEqual({ KUBECONFIG: '${KUBECONFIG}' });
    expect(row!.url).toBe('https://k8s.example.invalid:6443');
    expect(row!.category).toBe('k8s');
    expect(row!.marketKey).toBe('kubectl-cli');
    // kubeconfig 是文件内容：槽位必须标记 file（CliRunner 落 0600 临时文件，env 只给路径）
    expect(row!.credentialSlots).toEqual([
      expect.objectContaining({ target: 'env', name: 'KUBECONFIG', label: 'kubeconfig 文件', file: true }),
    ]);
  });

  it('mysql-cli 的 env 承接 ${OPSGATE_TARGET}：填的目标地址成为 MYSQL_HOST 的渲染来源', async () => {
    // 落库的 env 是**模板**（`${OPSGATE_TARGET}`），渲染发生在 CliRunner：
    // 它把 `${OPSGATE_TARGET}` 替换为 asset.url（src/services/cliRunner.ts）。
    // 所以这里同时断言两件事：模板里有这个占位 + url 落到了 asset.url。
    const target = 'mysql.example.invalid:3306';
    const r = await withPlatform('linux', () => withShimPath(() => api('POST', '/api/v1/market/instantiate', {
      pkgName: 'mysql-cli',
      name: 'mysql-prod',
      url: target,
    })));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const row = rowOf('mysql-prod');
    expect(row, '资产未落库').toBeDefined();
    expect(row!.executionMode).toBe('cli');
    expect(row!.command).toBe('mysql');
    // 模板：MYSQL_HOST 引用 url 占位（这是"填的地址真生效"的唯一落点），MYSQL_PWD 引用凭证槽位
    expect(row!.env).toEqual({ MYSQL_HOST: '${OPSGATE_TARGET}', MYSQL_PWD: '${MYSQL_PWD}' });
    expect(row!.url).toBe(target);
    // 渲染后的值就是填的地址（与 CliRunner 的替换规则一致：整值替换）
    const rendered = (row!.env as Record<string, string>).MYSQL_HOST!.replace('${OPSGATE_TARGET}', row!.url ?? '');
    expect(rendered).toBe(target);

    // 不填地址时不注入 MYSQL_HOST：绝不落一个会被渲染成空串的变量（那等于"连本机"被伪装成已配置）
    const noUrl = await withPlatform('linux', () => withShimPath(() => api('POST', '/api/v1/market/instantiate', {
      pkgName: 'mysql-cli',
      name: 'mysql-nourl',
    })));
    expect(noUrl.status, JSON.stringify(noUrl.json)).toBe(200);
    const noUrlRow = rowOf('mysql-nourl');
    expect(noUrlRow!.url).toBeNull();
    expect(noUrlRow!.env).toEqual({ MYSQL_PWD: '${MYSQL_PWD}' });
    // 槽位声明不受影响（槽位来自 slotLabels，不是从 env 扫描）
    expect(noUrlRow!.credentialSlots).toEqual([
      expect.objectContaining({ name: 'MYSQL_PWD', target: 'env', file: false }),
    ]);
  });

  it('cli 的 body.url 走 SSRF 闸门：私网默认 400，显式 allowPrivateNetwork 放行', async () => {
    // D12：资产 url 沿用现有 SSRF 校验，cli 不能因为执行方式不同就跳过。
    // 私网地址（10.0.0.5）默认拒绝 —— fail-closed，且不落库。
    const denied = await withPlatform('linux', () => withShimPath(() => api('POST', '/api/v1/market/instantiate', {
      pkgName: 'mysql-cli',
      name: 'mysql-private',
      url: '10.0.0.5:3306',
    })));
    expect(denied.status, JSON.stringify(denied.json)).toBe(400);
    expect(denied.json.message).toContain('SSRF');
    expect(rowOf('mysql-private')).toBeUndefined();

    // 显式开启私网（与原生条目同一个开关）后才允许，且开关随资产落库
    const allowed = await withPlatform('linux', () => withShimPath(() => api('POST', '/api/v1/market/instantiate', {
      pkgName: 'mysql-cli',
      name: 'mysql-private',
      url: '10.0.0.5:3306',
      allowPrivateNetwork: true,
    })));
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
    const row = rowOf('mysql-private');
    expect(row!.url).toBe('10.0.0.5:3306');
    expect(row!.allowPrivateNetwork).toBe(true);
  });

  it('cli 条目收到非空 body.config → 400（不静默丢弃用户改动）', async () => {
    // 详情页对 cli 条目已隐藏配置编辑区；仍有调用方直发 config 时必须显式失败，
    // 否则"看起来提交成功了、改的东西不存在"（§2 原则 5）。
    const r = await withPlatform('linux', () => withShimPath(() => api('POST', '/api/v1/market/instantiate', {
      pkgName: 'kubectl-cli',
      name: 'k8s-config',
      config: { env: { KUBECONFIG: '/tmp/x' } },
    })));
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('不支持安装配置');
    expect(rowOf('k8s-config')).toBeUndefined();

    // 空对象等价于"没传"（前端某些路径会带 `{}`），不能因此拒绝合法请求
    const empty = await withPlatform('linux', () => withShimPath(() => api('POST', '/api/v1/market/instantiate', {
      pkgName: 'kubectl-cli',
      name: 'k8s-empty-cfg',
      config: {},
    })));
    expect(empty.status, JSON.stringify(empty.json)).toBe(200);
    expect(rowOf('k8s-empty-cfg')!.command).toBe('kubectl');
  });

  it('详情接口对 cli 条目回传 cli 段（前端据此判断是否渲染目标地址输入框）', async () => {
    // 前端 MarketDetail 用 `Object.values(cli.env)` 里是否含 `${OPSGATE_TARGET}` 决定要不要给
    // "目标地址"输入框：条目没有承接地址的环境变量就不该收地址。该判据依赖详情接口把 cli 段
    // 原样回传（含从 installations 还原的那份），否则前端永远看不到模板。
    const mysql = await api('GET', '/api/v1/market/catalog/mysql-cli');
    expect(mysql.status).toBe(200);
    const m = mysql.json.data as { cli?: { bin: string; env?: Record<string, string> } };
    expect(m.cli?.bin).toBe('mysql');
    expect(Object.values(m.cli?.env ?? {}).some((v) => v.includes('${OPSGATE_TARGET}'))).toBe(true);

    const kubectl = await api('GET', '/api/v1/market/catalog/kubectl-cli');
    const k = kubectl.json.data as { cli?: { bin: string; env?: Record<string, string> } };
    expect(Object.values(k.cli?.env ?? {}).some((v) => v.includes('${OPSGATE_TARGET}'))).toBe(false);
  });

  it('条目的 bin 在主机上不存在 → 400，且不落库（与创建路径同口径）', async () => {
    const r = await withPlatform('linux', () => api('POST', '/api/v1/market/instantiate', {
      pkgName: 'test-cli-missing-bin',
      name: 'cli-missing',
    }));
    expect(r.status).toBe(400);
    expect(r.json.message).toContain('definitely-not-a-bin-xyz');
    expect(rowOf('cli-missing')).toBeUndefined();
  });

  it('管理端探测 CLI 条目不拉起 MCP 子进程（否则会报误导性的 listTools 失败）', async () => {
    // alice 是 admin，可直接打管理端端点。CLI 条目没有 MCP server 可探测：
    // 应答必须是"无子进程可探测"的说明，而不是把 kubectl 当 MCP server 拉起来的错误。
    const r = await api('POST', '/api/v1/market/entries/kubectl-cli/test');
    expect(r.status).toBe(200);
    const d = r.json.data as { ok: boolean; tools?: number; slots?: string[]; note?: string };
    expect(d.ok).toBe(true);
    expect(d.tools).toBe(0);
    expect(d.slots).toContain('KUBECONFIG');
    expect(d.note).toContain('CLI');
  });
});
