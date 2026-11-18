/**
 * T11/T12 集成测试：Market 目录/详情/实例化（注入本地夹具条目，离线）+ 槽位端点 + candidates。
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
import { CredentialService } from './services/credentials.js';
import { InstancePool } from './services/instancePool.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';
import { serverInstanceKeys } from './routes/assets.js';
import type { CatalogEntry } from './services/marketCatalog.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/mock-mcp-server.mjs', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

/** 合成目录条目（离线）：本地 fixture 作为 stdio 命令，env 带占位符 */
const SYNTHETIC: CatalogEntry = {
  key: 'test-echo',
  name: 'test-echo',
  displayName: 'Test Echo MCP',
  description: '测试用（离线夹具）',
  repository: 'https://example.invalid',
  categories: ['other'],
  tags: [],
  runtime: 'npm',
  slotLabels: { AUTH: '认证口令' },
  installations: { npm: { command: process.execPath, args: [FIXTURE], env: { MY_TOKEN: '${AUTH}' } } },
};

let app: FastifyInstance;
let sqlite: Database.Database;
let cookie: string;
let auth: ReturnType<typeof createAuth>;
let credentials: CredentialService;
const pool = new InstancePool({
  globalBudget: 4, globalWeightBudget: 12, maxPerAsset: 2, queuePerUser: 4, globalConcurrency: 2,
  idleTtlMs: 60_000, queueTimeoutMs: 5_000, degradeWaitMs: 3_000, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
  runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-rt-')),
});

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials0 = new CredentialService(sqlite, cryptoKey);
  credentials = credentials0;
  auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite,
    instancePool: pool, credentials: credentials0,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'rt-')),
    marketEntries: [SYNTHETIC],
  });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username: 'alice', password: 'password-12345' },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc];
  cookie = arr[0]!.split(';')[0]!;
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); await pool.releaseAll(); });

interface ApiRes { status: number; json: { code: number; data: unknown; message: string } }

async function request(cookie: string, method: string, url: string, payload?: unknown): Promise<ApiRes> {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  const ct = String(res.headers['content-type'] ?? '');
  const isJson = ct.includes('application/json');
  return { status: res.statusCode, json: isJson ? (res.json() as ApiRes['json']) : ({ code: 0, data: res.body, message: 'ok' } as ApiRes['json']) };
}

async function api(method: string, url: string, payload?: unknown): Promise<ApiRes> {
  return request(cookie, method, url, payload);
}

async function signin(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in/username',
    payload: { username, password },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc];
  return arr[0]!.split(';')[0]!;
}

describe('T11 Market（ADR-025）', () => {
  it('目录列表 + addedCount 徽章（当前 0）', async () => {
    const r = await api('GET', '/api/v1/market/catalog');
    expect(r.status).toBe(200);
    const items = (r.json.data as { items: Array<{ key: string; addedCount: number }> }).items;
    expect(items.map((i) => i.key)).toContain('test-echo');
    expect(items[0]!.addedCount).toBe(0);
  });

  it('详情：预览 + 槽位识别（AC-63：占位符 + AUTH 敏感/标签）', async () => {
    const r = await api('GET', '/api/v1/market/catalog/test-echo');
    const d = r.json.data as { preview: { args: string[] }; slots: Array<{ name: string; sensitive: boolean; label: string }> };
    expect(d.preview.args[0]).toBe(FIXTURE);
    expect(d.slots).toHaveLength(1);
    expect(d.slots[0]!).toMatchObject({ name: 'AUTH', sensitive: true, label: '认证口令' });
  });

  it('实例化（AC-64）：落库 + 绑定 + market_key + 审计 asset_create；名称冲突 400；batch 未注册 403', async () => {
    const cred = await api('POST', '/api/v1/credentials', { name: 'alice-cred', values: { AUTH: 'v123' } });
    const credId = (cred.json.data as { id: string }).id;
    const inst = await api('POST', '/api/v1/market/instantiate', { pkgName: 'test-echo', name: 'echo-1', credentialRefs: { AUTH: credId } });
    expect(inst.status).toBe(200);
    const out = inst.json.data as { server: { id: string; marketKey: string | null }; bound: string[]; missingSlots: string[] };
    expect(out.server.marketKey).toBe('test-echo');
    expect(out.bound).toEqual(['AUTH']);
    expect(out.missingSlots).toEqual([]);
    const boundRows = sqlite.prepare('SELECT COUNT(*) c FROM server_credentials WHERE server_id=?').get(out.server.id) as { c: number };
    expect(boundRows.c).toBe(1);
    const _auditTbl = `audit_log_${new Date().getFullYear()}_${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const auditRows = sqlite
      .prepare(`SELECT COUNT(*) c FROM ${_auditTbl} WHERE action='asset_create'`)
      .get() as { c: number };
    expect(auditRows.c).toBeGreaterThanOrEqual(1);

    const dup = await api('POST', '/api/v1/market/instantiate', { pkgName: 'test-echo', name: 'echo-1', credentialRefs: {} });
    expect(dup.status).toBe(400);

    const batch = await api('POST', '/api/v1/market/batch-instantiate', { pkgName: 'test-echo', name: 'x', credentialRefs: {} });
    expect(batch.status).toBe(403); // default-deny：未注册
  });

  it('运行时解耦（AC-65/68）：实例化后 configHash 已固化（不运行时读目录）', async () => {
    const row = sqlite.prepare("SELECT config_hash FROM servers WHERE name='echo-1'").get() as { config_hash: string };
    expect(row.config_hash).toBeTruthy();
  });

  it('自定义配置覆盖：追加 env/args 后按新配置识别槽位并落库', async () => {
    const inst = await api('POST', '/api/v1/market/instantiate', {
      pkgName: 'test-echo',
      name: 'echo-custom',
      credentialRefs: {},
      config: {
        command: process.execPath,
        args: [FIXTURE, '--custom'],
        env: { MY_TOKEN: '${AUTH}', EXTRA: 'plain-value', NEW_ONE: '${NEW_SLOT}' },
      },
    });
    expect(inst.status).toBe(200);
    const out = inst.json.data as { server: { id: string }; missingSlots: string[] };
    // 槽位按**最终配置**识别：默认只有 AUTH，新增 ${NEW_SLOT} 后应有两个
    expect(out.missingSlots.sort()).toEqual(['AUTH', 'NEW_SLOT']);

    const row = sqlite.prepare("SELECT env, args, command FROM servers WHERE name='echo-custom'").get() as {
      env: string; args: string; command: string;
    };
    const env = JSON.parse(row.env) as Record<string, string>;
    expect(env.EXTRA).toBe('plain-value');     // 追加的 env 已落库
    expect(env.NEW_ONE).toBe('${NEW_SLOT}');   // 占位符原样保留（值运行时注入）
    expect(env.MY_TOKEN).toBe('${AUTH}');
    expect(JSON.parse(row.args)).toContain('--custom'); // 追加的 args 已落库
  });
});

describe('T12 槽位绑定（后端）', () => {
  it('创建→GET slots 空→绑定→GET 反映→candidates 仅本人→解绑→审计 credential_unbind', async () => {
    const cred = await api('POST', '/api/v1/credentials', { name: 'ssh-cred', values: { AUTH: 'pw' } });
    const credId = (cred.json.data as { id: string }).id;
    const srv = await api('POST', '/api/v1/servers', {
      name: 'bind-host', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    });
    const sid = (srv.json.data as { id: string }).id;
    const empty = await api('GET', `/api/v1/servers/${sid}/slots`);
    expect((empty.json.data as Array<{ credentialId: string | null }>)[0]!.credentialId).toBeNull();

    const bind = await api('POST', `/api/v1/servers/${sid}/slots`, { slotName: 'AUTH', credentialId: credId });
    expect(bind.status).toBe(200);
    const after = await api('GET', `/api/v1/servers/${sid}/slots`);
    expect((after.json.data as Array<{ credentialId: string | null }>)[0]!.credentialId).toBe(credId);

    const cands = await api('GET', `/api/v1/credentials/candidates?assetId=${sid}`);
    expect(cands.json.data as Array<{ name: string; kind: string; valueHint: string }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ssh-cred', kind: 'env-values' })]),
    );
    // 回归：candidates 必须带凭证的键名（keys），否则前端槽位下拉恒为空（credentials 未注入 → valueKeysOf 空）
    const withKeys = cands.json.data as Array<{ name: string; keys?: string[] }>;
    expect(withKeys.find((c) => c.name === 'ssh-cred')!.keys).toEqual(['AUTH']);

    // 一槽多凭证后解绑必须指明 credentialId（否则会删掉该槽位所有本人绑定）
    const boundCredId = (await api('GET', `/api/v1/servers/${sid}/slots`)).json.data as Array<{ credentialId: string | null }>;
    const unbind = await api('DELETE', `/api/v1/servers/${sid}/slots/AUTH?credentialId=${encodeURIComponent(boundCredId[0]!.credentialId!)}`);
    expect(unbind.status).toBe(200);
    const _unbindTbl = `audit_log_${new Date().getFullYear()}_${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const auditUnbind = sqlite.prepare(`SELECT COUNT(*) c FROM ${_unbindTbl} WHERE action='credential_unbind'`).get() as { c: number };
    expect(auditUnbind.c).toBeGreaterThanOrEqual(1);
  });

  it('candidates：admin 见全部（Spec §8.5），非 admin 仅本人（ADR-020）', async () => {
    // alice 的凭证
    const a = await api('POST', '/api/v1/credentials', { name: 'alice-only', values: { K: 'v' } });
    expect(a.status).toBe(200);
    // admin bob
    await createUserWithPassword(auth, { username: 'bob', password: 'password-12345', isAdmin: true });
    const bobCookie = await signin('bob', 'password-12345');
    const bobCred = await request(bobCookie, 'POST', '/api/v1/credentials', { name: 'bob-cred', values: { K: 'v' } });
    expect(bobCred.status).toBe(200);

    const bobCands = await request(bobCookie, 'GET', '/api/v1/credentials/candidates');
    const bobList = bobCands.json.data as Array<{ name: string; kind: string; valueHint: string }>;
    expect(bobList.map((c) => c.name)).toEqual(expect.arrayContaining(['alice-only', 'bob-cred']));
    expect(bobList.every((c) => typeof c.kind === 'string' && typeof c.valueHint === 'string')).toBe(true);

    const aliceCands = await api('GET', '/api/v1/credentials/candidates');
    const aliceList = aliceCands.json.data as Array<{ name: string }>;
    expect(aliceList.map((c) => c.name)).toContain('alice-only');
    expect(aliceList.map((c) => c.name)).not.toContain('bob-cred');
  });
});

describe('T14 槽位直填值（ADR-027：直填值不是凭证）', () => {
  it('PUT 直填值 → GET slots 回显明文 + 不进凭证列表 + 运行时可解析', async () => {
    const srv = await api('POST', '/api/v1/servers', {
      name: 'inline-host', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    });
    const sid = (srv.json.data as { id: string }).id;

    const before = await api('GET', '/api/v1/credentials');
    const beforeCount = (before.json.data as unknown[]).length;

    const put = await api('PUT', `/api/v1/servers/${sid}/slots/AUTH/value`, { value: 'inline-secret-pw' });
    expect(put.status).toBe(200);

    const slots = await api('GET', `/api/v1/servers/${sid}/slots`);
    const row = (slots.json.data as Array<{ slotName: string; credentialId: string | null; inlineValue: string | null }>)[0]!;
    expect(row.slotName).toBe('AUTH');
    expect(row.inlineValue).toBe('inline-secret-pw');
    // 关键回归：直填值不是凭证 —— 不产生绑定，也不新增凭证行
    expect(row.credentialId).toBeNull();
    const after = await api('GET', '/api/v1/credentials');
    expect((after.json.data as unknown[]).length).toBe(beforeCount);

    // 运行时解析：直填值参与槽位取值（不再需要凭证）
    const resolved = credentials.resolveSlotValues(sid, ['AUTH']);
    expect(resolved[0]!.value).toBe('inline-secret-pw');
    expect(resolved[0]!.inline).toBe(true);

    // 密文落库：DB 里不是明文
    const raw = sqlite.prepare('SELECT encrypted_value AS e FROM server_slot_values WHERE server_id = ? AND slot_name = ?').get(sid, 'AUTH') as { e: string };
    expect(raw.e).not.toContain('inline-secret-pw');
    expect(raw.e.startsWith('v1.')).toBe(true);
  });

  it('直填值与凭证绑定互斥：绑凭证 → 清直填值；写直填值 → 清绑定', async () => {
    const cred = await api('POST', '/api/v1/credentials', { name: 'inline-mix-cred', values: { AUTH: 'cred-pw' } });
    const credId = (cred.json.data as { id: string }).id;
    const srv = await api('POST', '/api/v1/servers', {
      name: 'inline-mix', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    });
    const sid = (srv.json.data as { id: string }).id;

    await api('PUT', `/api/v1/servers/${sid}/slots/AUTH/value`, { value: 'v1' });
    await api('POST', `/api/v1/servers/${sid}/slots`, { slotName: 'AUTH', credentialId: credId });
    let row = (await api('GET', `/api/v1/servers/${sid}/slots`)).json.data as Array<{ credentialId: string | null; inlineValue: string | null }>;
    expect(row[0]!.credentialId).toBe(credId);
    expect(row[0]!.inlineValue).toBeNull();

    await api('PUT', `/api/v1/servers/${sid}/slots/AUTH/value`, { value: 'v2' });
    row = (await api('GET', `/api/v1/servers/${sid}/slots`)).json.data as Array<{ credentialId: string | null; inlineValue: string | null }>;
    expect(row[0]!.credentialId).toBeNull();
    expect(row[0]!.inlineValue).toBe('v2');
  });

  it('DELETE 直填值 → 清空；未定义槽位 400；非归属人 403', async () => {
    const srv = await api('POST', '/api/v1/servers', {
      name: 'inline-del', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    });
    const sid = (srv.json.data as { id: string }).id;
    await api('PUT', `/api/v1/servers/${sid}/slots/AUTH/value`, { value: 'to-delete' });

    const bad = await api('PUT', `/api/v1/servers/${sid}/slots/NOPE/value`, { value: 'x' });
    expect(bad.status).toBe(400);

    const del = await api('DELETE', `/api/v1/servers/${sid}/slots/AUTH/value`);
    expect(del.status).toBe(200);
    const row = (await api('GET', `/api/v1/servers/${sid}/slots`)).json.data as Array<{ inlineValue: string | null }>;
    expect(row[0]!.inlineValue).toBeNull();

    // 非归属人（bob admin 可写；普通成员不可写）
    await createUserWithPassword(auth, { username: 'carol', password: 'password-12345', isAdmin: false });
    const carolCookie = await signin('carol', 'password-12345');
    const res = await request(carolCookie, 'PUT', `/api/v1/servers/${sid}/slots/AUTH/value`, { value: 'hack' });
    expect(res.status).toBe(403);
  });

  it('直填值变更 → 实例键变化（值指纹进入实例键）', async () => {
    const srv = await api('POST', '/api/v1/servers', {
      name: 'inline-key', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    });
    const sid = (srv.json.data as { id: string }).id;
    await api('PUT', `/api/v1/servers/${sid}/slots/AUTH/value`, { value: 'k1' });
    const key1 = await serverInstanceKeys(drizzle(sqlite, { schema }), sid);
    await api('PUT', `/api/v1/servers/${sid}/slots/AUTH/value`, { value: 'k2' });
    const key2 = await serverInstanceKeys(drizzle(sqlite, { schema }), sid);
    expect(key1).not.toEqual(key2);
  });
});

describe('T15 凭证详情（归属用户名 / 引用去重 / 明文查看）', () => {
  it('归属显示用户名；同资产多槽位只列一次并列出槽位', async () => {
    const cred = await api('POST', '/api/v1/credentials', { name: 'detail-cred', values: { username: 'u1', password: 'p1' } });
    const credId = (cred.json.data as { id: string }).id;
    const srv = await api('POST', '/api/v1/servers', {
      name: 'detail-asset', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
      credentialSlots: [
        { target: 'env', name: 'username', label: '用户名', file: false },
        { target: 'env', name: 'password', label: '密码', file: false },
      ],
    });
    const sid = (srv.json.data as { id: string }).id;
    await api('POST', `/api/v1/servers/${sid}/slots`, { slotName: 'username', credentialId: credId });
    await api('POST', `/api/v1/servers/${sid}/slots`, { slotName: 'password', credentialId: credId });

    const detail = await api('GET', `/api/v1/credentials/${credId}`);
    expect(detail.status).toBe(200);
    const d = detail.json.data as {
      ownerName: string;
      boundServers: Array<{ serverId: string; name: string; slots: string[] }>;
    };
    // 归属展示用户名（不是 id 前 8 位）
    expect(d.ownerName).toBe('alice');
    // 同一资产绑 2 个槽位 → 只列 1 行，槽位列说明绑定位置
    expect(d.boundServers.length).toBe(1);
    expect(d.boundServers[0]!.serverId).toBe(sid);
    expect(d.boundServers[0]!.slots.sort()).toEqual(['password', 'username']);

    // 列表接口同样带 ownerName
    const list = await api('GET', '/api/v1/credentials');
    const row = (list.json.data as Array<{ id: string; ownerName: string }>).find((c) => c.id === credId);
    expect(row!.ownerName).toBe('alice');
  });

  it('明文查看：归属人可看且留审计；他人 403', async () => {
    const cred = await api('POST', '/api/v1/credentials', { name: 'reveal-cred', values: { password: 'super-secret-pw' } });
    const credId = (cred.json.data as { id: string }).id;

    const reveal = await api('GET', `/api/v1/credentials/${credId}/reveal`);
    expect(reveal.status).toBe(200);
    expect((reveal.json.data as { values: Record<string, string> }).values.password).toBe('super-secret-pw');

    // 揭示明文属敏感操作 → 治理审计留痕
    const tbl = `audit_log_${new Date().getFullYear()}_${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const row = sqlite.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE action='credential_reveal'`).get() as { c: number };
    expect(row.c).toBeGreaterThanOrEqual(1);

    // 他人不可看
    await createUserWithPassword(auth, { username: 'dave', password: 'password-12345', isAdmin: false });
    const daveCookie = await signin('dave', 'password-12345');
    const res = await request(daveCookie, 'GET', `/api/v1/credentials/${credId}/reveal`);
    expect(res.status).toBe(403);
  });
});

describe('R6 修复回归（F-R6-1/4/5 + AC-67）', () => {
  it('同槽位绑第二个凭证 → 追加为第二条绑定（不再覆盖）；解绑仍精确到条', async () => {
    const c1 = (await api('POST', '/api/v1/credentials', { name: 'rebind-c1', values: { AUTH: 'p1' } })).json.data as { id: string };
    const c2 = (await api('POST', '/api/v1/credentials', { name: 'rebind-c2', values: { AUTH: 'p2' } })).json.data as { id: string };
    const srv = await api('POST', '/api/v1/servers', {
      name: 'rebind-host', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    });
    const sid = (srv.json.data as { id: string }).id;
    const b1 = await api('POST', `/api/v1/servers/${sid}/slots`, { slotName: 'AUTH', credentialId: c1.id });
    expect(b1.status).toBe(200);
    const b2 = await api('POST', `/api/v1/servers/${sid}/slots`, { slotName: 'AUTH', credentialId: c2.id });
    expect(b2.status).toBe(200);
    const after = (await api('GET', `/api/v1/servers/${sid}/slots`)).json.data as Array<{ bindings?: Array<{ credentialId: string }> }>;
    // 主键含 credential_id：两条都在（root 自用 + dev 共享的典型形态）
    expect((after[0]!.bindings ?? []).map((b) => b.credentialId).sort()).toEqual([c1.id, c2.id].sort());
    const _bindTbl = `audit_log_${new Date().getFullYear()}_${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const binds = sqlite.prepare(`SELECT COUNT(*) c FROM ${_bindTbl} WHERE action='credential_bind'`).get() as { c: number };
    expect(binds.c).toBeGreaterThanOrEqual(2);
  });

  it('HTTP 型 mcp 资产：url 无需 command（SSRF 校验仍生效 fail-closed）', async () => {
    const ok = await api('POST', '/api/v1/servers', {
      name: 'http-ok', type: 'http', executionMode: 'mcp', category: 'other', url: 'http://1.1.1.1:8080',
    });
    expect(ok.status).toBe(200);
    expect((ok.json.data as { id: string }).id).toBeTruthy();
    const bad = await api('POST', '/api/v1/servers', {
      name: 'http-bad', type: 'http', executionMode: 'mcp', category: 'other', url: 'http://127.0.0.1:9',
    });
    expect(bad.status).toBe(400);
    expect((bad.json as { message: string }).message).toContain('SSRF');
    const nocfg = await api('POST', '/api/v1/servers', { name: 'no-cfg', type: 'http', executionMode: 'mcp', category: 'other' });
    expect(nocfg.status).toBe(400);
  });

  it('资产级端点：instances/tools(PATCH+GET) 与 prewarm（F-R6-4）', async () => {
    const list = (await api('GET', '/api/v1/servers?search=http-ok')).json.data as { items: Array<{ id: string }> };
    const id = list.items[0]!.id;
    expect((await api('GET', `/api/v1/servers/${id}/instances`)).status).toBe(200);
    expect((await api('GET', `/api/v1/servers/${id}/tools`)).status).toBe(200);
    const tp = await api('PATCH', `/api/v1/servers/${id}/tools`, { disabledTools: ['foo'] });
    expect(tp.status).toBe(200);
    const t1 = await api('GET', `/api/v1/servers/${id}/tools`);
    expect((t1.json.data as { disabledTools: string[] }).disabledTools).toEqual(['foo']);
    // prewarm：对 fixture stdio 资产（echo-1，已绑定）——真启动一次
    const echo = (await api('GET', '/api/v1/servers?search=echo-1')).json.data as { items: Array<{ id: string }> };
    const warm = await api('POST', `/api/v1/servers/${echo.items[0]!.id}/prewarm`, {});
    expect(warm.status).toBe(200);
  });

  it('运行时端点：metrics/ssh-connections/transfer-staging（admin-only）', async () => {
    const bobCookie = await signin('bob', 'password-12345');
    const metrics = await request(bobCookie, 'GET', '/api/v1/runtime/metrics');
    expect(metrics.status).toBe(200);
    expect(String(metrics.json.data)).toContain('opsgate_instances_ready');
    expect((await request(bobCookie, 'GET', '/api/v1/runtime/ssh-connections')).status).toBe(200);
    expect((await request(bobCookie, 'GET', '/api/v1/runtime/transfer-staging')).status).toBe(200);
    // 非 admin → 403
    expect((await api('GET', '/api/v1/runtime/metrics')).status).toBe(403);
  });
});

describe('凭证引用 ref.<凭证名>.<键名>（2026-10-22 用户决策：一个凭证服务多个资产）', () => {
  it('创建资产 env 引用凭证 → 200 且原文存留；不存在的引用 → 400', async () => {
    const c = await api('POST', '/api/v1/credentials', { name: 'conn-a', kind: 'user_password', values: { host: '10.0.0.5', username: 'ro', password: 'p@ss' } });
    expect(c.status).toBe(200);
    const ok = await api('POST', '/api/v1/servers', {
      name: 'ref-db-01', type: 'stdio', executionMode: 'mcp', category: 'mysql',
      command: 'uvx', args: ['--from', 'mysql-mcp-server==0.1.4', 'mysql_mcp_server'],
      env: { MYSQL_HOST: 'ref.conn-a.host', MYSQL_USER: 'ref.conn-a.username', MYSQL_PASSWORD: 'ref.conn-a.password' },
    });
    expect(ok.status).toBe(200);
    const list = (await api('GET', '/api/v1/servers?search=ref-db-01')).json.data as { items: Array<{ id: string; env: Record<string, string> }> };
    expect(list.items[0]!.env.MYSQL_HOST).toBe('ref.conn-a.host'); // 原文存留（运行期才解析，快照语义）
    const bad = await api('POST', '/api/v1/servers', {
      name: 'ref-bad', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'echo', env: { X: 'ref.nope.key' },
    });
    expect(bad.status).toBe(400);
    expect((bad.json as { message: string }).message).toContain('不存在');
  });

  it('引用非本人凭证 → 400（ADR-020）；valueOfRef 按键取值/缺失 null', async () => {
    const cross = await api('POST', '/api/v1/servers', {
      name: 'ref-cross', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'echo', env: { X: 'ref.bob-cred.K' },
    });
    expect(cross.status).toBe(400);
    expect((cross.json as { message: string }).message).toContain('非本人');
    const v = credentials.valueOfRef('conn-a', 'password');
    expect(v?.value).toBe('p@ss');
    expect(v?.credentialId).toBeTruthy();
    expect(credentials.valueOfRef('conn-a', 'nope')).toBeNull();
  });
});
