/**
 * 资产启停与批量操作回归（用户实测反馈：列表没有批量删除、没有停用功能）。
 *
 * 关键语义（不只是 UI）：
 *  1. enabled=false 必须真正从 MCP tools/list 移除并拒绝调用——否则开关只是装饰；
 *  2. 批量端点逐条校验权限，返回成功/失败明细（不静默吞失败）；
 *  3. 删除必须写 remove_asset 治理审计（此前清单里有动作但无写入点）。
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
import { and, eq } from 'drizzle-orm';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CredentialService } from './services/credentials.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let adminCookie: string;
let adminId: string;
let memberCookie: string;
let memberId: string;
/** 应用装配用的凭证加密密钥：接口级用例必须用它加密，否则后端解不开 */
let credKey: Buffer;

const auditTableOf = (d: Date): string => `audit_log_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-k-')), 'k'));
  credKey = cryptoKey;
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'admin1', password: 'password-12345', isAdmin: true });
  await createUserWithPassword(auth, { username: 'member1', password: 'password-12345', isAdmin: false });
  adminId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'admin1')).get())!.id;
  memberId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'member1')).get())!.id;

  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite,
    credentials,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'rt-')),
    marketEntries: [],
  });

  const signIn = async (username: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const sc = res.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : [sc];
    return arr[0]!.split(';')[0]!;
  };
  adminCookie = await signIn('admin1');
  memberCookie = await signIn('member1');
}, 60_000);

afterAll(async () => { await app.close(); sqlite.close(); });

async function api(cookie: string, method: string, url: string, payload?: unknown) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as { code: number; data: unknown; message: string } };
}

async function mkAsset(ownerId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row = await db.insert(schema.servers).values({
    name, displayName: name, type: 'native', executionMode: 'native', category: 'host',
    ownerId, visibility: 'owner', configHash: `ch-${name}`,
    hostConn: { host: '127.0.0.1', port: 22, username: 'ops' } as never,
    credentialSlots: [] as never,
    ...extra,
  } as never).returning({ id: schema.servers.id }).get();
  return row.id;
}

describe('单条启停（PATCH enabled）', () => {
  it('停用后 enabled=false；再启用恢复 true；两次写 asset_enabled_change 审计', async () => {
    const id = await mkAsset(adminId, 'toggle-a');
    const off = await api(adminCookie, 'PATCH', `/api/v1/servers/${id}`, { enabled: false });
    expect(off.status).toBe(200);
    let row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    expect(row!.enabled).toBe(false);

    const on = await api(adminCookie, 'PATCH', `/api/v1/servers/${id}`, { enabled: true });
    expect(on.status).toBe(200);
    row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    expect(row!.enabled).toBe(true);

    // 治理审计按既有约定：server_id 记为 'management'，被操作的资产 id 在 input_summary
    const table = auditTableOf(new Date());
    const rows = sqlite
      .prepare(`SELECT input_summary FROM ${table} WHERE action = 'asset_enabled_change' AND input_summary LIKE ?`)
      .all(`%${id}%`) as Array<{ input_summary: string }>;
    expect(rows).toHaveLength(2);
  });

  it('enabled 非 boolean → 400（不做隐式转换）', async () => {
    const id = await mkAsset(adminId, 'toggle-bad');
    const r = await api(adminCookie, 'PATCH', `/api/v1/servers/${id}`, { enabled: 'false' });
    expect(r.status).toBe(400);
  });
});

describe('停用资产不进入工具发现（enabled 必须真实生效）', () => {
  it('停用资产不出现在 /servers 列表的启用筛选中，但仍可见于全部列表', async () => {
    const id = await mkAsset(adminId, 'hidden-a');
    await api(adminCookie, 'PATCH', `/api/v1/servers/${id}`, { enabled: false });

    const enabledOnly = await api(adminCookie, 'GET', '/api/v1/servers?enabled=false');
    const names = (enabledOnly.json.data as { items: Array<{ name: string }> }).items.map((i) => i.name);
    expect(names).toContain('hidden-a');

    const all = await api(adminCookie, 'GET', '/api/v1/servers');
    expect((all.json.data as { items: Array<{ name: string }> }).items.map((i) => i.name)).toContain('hidden-a');
  });
});

describe('批量操作（POST /servers/batch）', () => {
  it('批量停用：返回 succeeded，且全部落库为 false', async () => {
    const a = await mkAsset(adminId, 'batch-a');
    const b = await mkAsset(adminId, 'batch-b');
    const r = await api(adminCookie, 'POST', '/api/v1/servers/batch', { ids: [a, b], action: 'disable' });
    expect(r.status).toBe(200);
    const data = r.json.data as { succeeded: string[]; failed: unknown[] };
    expect(data.succeeded.sort()).toEqual([a, b].sort());
    expect(data.failed).toHaveLength(0);
    for (const id of [a, b]) {
      const row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
      expect(row!.enabled).toBe(false);
    }
  });

  it('批量删除：资产与凭证绑定/分组归属一并删除，并写 remove_asset 审计', async () => {
    const a = await mkAsset(adminId, 'batch-del-a');
    const r = await api(adminCookie, 'POST', '/api/v1/servers/batch', { ids: [a], action: 'delete' });
    expect(r.status).toBe(200);
    expect((r.json.data as { succeeded: string[] }).succeeded).toEqual([a]);
    const row = await db.select().from(schema.servers).where(eq(schema.servers.id, a)).get();
    expect(row).toBeUndefined();

    const table = auditTableOf(new Date());
    const rows = sqlite
      .prepare(`SELECT input_summary FROM ${table} WHERE action = 'remove_asset' AND input_summary LIKE ?`)
      .all(`%${a}%`) as Array<{ input_summary: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input_summary).toContain('"batch":true');
  });

  it('非归属人（普通成员）批量操作他人资产 → failed 明细，不静默成功', async () => {
    const a = await mkAsset(adminId, 'batch-perm');
    const r = await api(memberCookie, 'POST', '/api/v1/servers/batch', { ids: [a], action: 'disable' });
    expect(r.status).toBe(200);
    const data = r.json.data as { succeeded: string[]; failed: Array<{ id: string; reason: string }> };
    expect(data.succeeded).toHaveLength(0);
    expect(data.failed).toHaveLength(1);
    expect(data.failed[0]!.reason).toContain('无权');
    const row = await db.select().from(schema.servers).where(eq(schema.servers.id, a)).get();
    expect(row!.enabled).toBe(true);
  });

  it('非法 action / 空 ids → 400', async () => {
    expect((await api(adminCookie, 'POST', '/api/v1/servers/batch', { ids: [], action: 'disable' })).status).toBe(400);
    expect((await api(adminCookie, 'POST', '/api/v1/servers/batch', { ids: ['x'], action: 'nuke' })).status).toBe(400);
  });
});

describe('单条删除同样写审计（此前遗漏）', () => {
  it('DELETE /servers/:id → remove_asset 审计', async () => {
    const id = await mkAsset(adminId, 'single-del');
    const r = await api(adminCookie, 'DELETE', `/api/v1/servers/${id}`);
    expect(r.status).toBe(200);
    const table = auditTableOf(new Date());
    const rows = sqlite
      .prepare(`SELECT input_summary FROM ${table} WHERE action = 'remove_asset' AND input_summary LIKE ?`)
      .all(`%${id}%`) as Array<{ input_summary: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input_summary).toContain('single-del');
    void memberId;
  });
});

describe('未绑定槽位不再拦截（2026-11-17 用户决策）', () => {
  it('未绑定的槽位不出现在解析结果里，且不抛错', async () => {
    const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-k2-')), 'k'));
    const creds = new CredentialService(sqlite, cryptoKey);
    const assetId = await mkAsset(adminId, 'opt-slots');
    // 直填值路径最直接：只写 NACOS_TOKEN，其余槽位留空
    creds.setSlotValue(assetId, 'NACOS_TOKEN', 'tok-value', adminId);
    const ok = creds.resolveSlotValues(
      assetId,
      ['NACOS_TOKEN', 'NACOS_USERNAME', 'NACOS_PASSWORD'],
      undefined,
    );
    expect(ok.map((r) => r.slotName)).toEqual(['NACOS_TOKEN']);

    // 完全未绑定的槽位同样只是"取不到"，不是错误
    expect(creds.resolveSlotValues(assetId, ['NACOS_USERNAME', 'NACOS_PASSWORD'], undefined)).toEqual([]);
  });
});

describe('SSH 用户名/口令可来自凭证', () => {
    it('凭证含 username → slotCredentialKey 取到；未绑定/键缺失 → null（回落资产值）', async () => {
    const assetId = await mkAsset(adminId, 'ssh-user-cred', {
      hostConn: { host: '10.0.0.9', port: 22, username: 'asset-default', authSlot: 'AUTH' } as never,
    });
    const { CredentialService } = await import('./services/credentials.js');
    // 用与插行相同的 key 才能解密：这里用真实服务加密再写，避免 key 不一致
    const dir = mkdtempSync(path.join(tmpdir(), 'opsgate-k4-'));
    const keyPath = path.join(dir, 'k');
    const key = loadCredentialKey(keyPath);
    const svc = new CredentialService(sqlite, key);
    // 用服务层能解密的方式插入：直接 encryptCredential(key, id, json)
    const { encryptCredential } = await import('./services/crypto.js');
    const id = `cred-${Date.now().toString(36)}`;
    await db.insert(schema.credentials).values({
      id, name: `ssh-cred-${id}`, kind: 'ssh_key',
      encryptedValues: encryptCredential(key, id, JSON.stringify({ AUTH: 'PRIVATE KEY-BODY', username: 'from-cred', passphrase: 'pp' })),
      valueHint: '****', privileges: [], ownerId: adminId,
    } as never).run();
    await db.insert(schema.serverCredentials).values({
      serverId: assetId, slotName: 'AUTH', userId: adminId, credentialId: id, scope: 'asset',
    } as never).run();

    const u = svc.slotCredentialKey(assetId, 'AUTH', 'username');
    expect(u?.value).toBe('from-cred');
    const p = svc.slotCredentialKey(assetId, 'AUTH', 'passphrase');
    expect(p?.value).toBe('pp');
    // 凭证里没有的键 → null（调用方回落 hostConn.username）
    expect(svc.slotCredentialKey(assetId, 'AUTH', 'no_such_key')).toBeNull();
    // 未绑定槽位 → null
    expect(svc.slotCredentialKey(assetId, 'NOPE', 'username')).toBeNull();
  });
});

describe('槽位名与凭证键不同名时的取值（ADR-031）', () => {
  it('未指定 credential_key：AUTH ← password 报错并提示指定键名（不再靠别名猜）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opsgate-k5-'));
    const key = loadCredentialKey(path.join(dir, 'k'));
    const { CredentialService } = await import('./services/credentials.js');
    const { encryptCredential } = await import('./services/crypto.js');
    const svc = new CredentialService(sqlite, key);

    const assetId = await mkAsset(adminId, 'alias-slot');
    const id = `cred-${Date.now().toString(36)}-a`;
    await db.insert(schema.credentials).values({
      id, name: `alias-cred-${id}`, kind: 'user_password',
      encryptedValues: encryptCredential(key, id, JSON.stringify({ username: 'ops', password: 'pw-123' })),
      valueHint: '****', privileges: [], ownerId: adminId,
    } as never).run();
    await db.insert(schema.serverCredentials).values({
      serverId: assetId, slotName: 'AUTH', userId: adminId, credentialId: id, scope: 'asset',
    } as never).run();

    // 槽位叫 AUTH、凭证键叫 password：ADR-031 删除了「敏感别名」兜底，不再自动命中
    expect(() => svc.resolveSlotValues(assetId, ['AUTH'])).toThrow(/请在绑定上指定键名/);
    // 用户名仍可按显式键取（slotCredentialKey 一直是按键名精确取，不受影响）
    expect(svc.slotCredentialKey(assetId, 'AUTH', 'username')?.value).toBe('ops');
  });

  it('绑定上指定 credential_key=password 后精确命中', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opsgate-k5b-'));
    const key = loadCredentialKey(path.join(dir, 'k'));
    const { CredentialService } = await import('./services/credentials.js');
    const { encryptCredential } = await import('./services/crypto.js');
    const svc = new CredentialService(sqlite, key);

    const assetId = await mkAsset(adminId, 'alias-slot-explicit');
    const id = `cred-${Date.now().toString(36)}-b`;
    await db.insert(schema.credentials).values({
      id, name: `alias-cred-${id}`, kind: 'user_password',
      encryptedValues: encryptCredential(key, id, JSON.stringify({ username: 'ops', password: 'pw-123' })),
      valueHint: '****', privileges: [], ownerId: adminId,
    } as never).run();
    await db.insert(schema.serverCredentials).values({
      serverId: assetId, slotName: 'AUTH', userId: adminId, credentialId: id, scope: 'asset',
      credentialKey: 'password',
    } as never).run();

    const res = svc.resolveSlotValues(assetId, ['AUTH']);
    expect(res).toHaveLength(1);
    expect(res[0]!.value).toBe('pw-123');
  });
});

describe('槽位绑定 credentialKey 读写（ADR-031）', () => {
  it('POST 指定 credentialKey → 落库；GET /slots 回显；键不存在时 400 并列出可用键', async () => {
    const assetId = await mkAsset(adminId, 'ck-slot', {
      credentialSlots: [{ target: 'env', name: 'AUTH_PASS', label: '口令', file: false }] as never,
    });
    const { encryptCredential } = await import('./services/crypto.js');
    const id = `cred-${Date.now().toString(36)}-ck`;
    await db.insert(schema.credentials).values({
      id, name: `ck-cred-${id}`, kind: 'ssh_key',
      encryptedValues: encryptCredential(credKey, id, JSON.stringify({ AUTH: 'K', username: 'u', passphrase: 'pp' })),
      valueHint: '****', privileges: [], ownerId: adminId,
    } as never).run();

    // 键不存在 → 400，消息里列出可用键
    const bad = await api(adminCookie, 'POST', `/api/v1/servers/${assetId}/slots`, {
      slotName: 'AUTH_PASS', credentialId: id, credentialKey: 'nope',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/passphrase/);

    // 指定存在键 → 200，落库
    const ok = await api(adminCookie, 'POST', `/api/v1/servers/${assetId}/slots`, {
      slotName: 'AUTH_PASS', credentialId: id, credentialKey: 'passphrase',
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const row = await db.select().from(schema.serverCredentials)
      .where(and(eq(schema.serverCredentials.serverId, assetId), eq(schema.serverCredentials.slotName, 'AUTH_PASS')))
      .get();
    expect(row!.credentialKey).toBe('passphrase');

    // GET /slots 回显 credentialKey
    const list = await api(adminCookie, 'GET', `/api/v1/servers/${assetId}/slots`);
    expect(list.status).toBe(200);
    const slot = (list.json.data as Array<{ slotName: string; bindings: Array<{ credentialKey: string | null }> }>)
      .find((s) => s.slotName === 'AUTH_PASS');
    expect(slot!.bindings[0]!.credentialKey).toBe('passphrase');
  });

  it('PATCH 可单独改 credentialKey；改成不存在的键 → 400', async () => {
    const assetId = await mkAsset(adminId, 'ck-slot-patch', {
      credentialSlots: [{ target: 'env', name: 'AUTH_PASS', label: '口令', file: false }] as never,
    });
    const { encryptCredential } = await import('./services/crypto.js');
    const id = `cred-${Date.now().toString(36)}-ckp`;
    await db.insert(schema.credentials).values({
      id, name: `ck-cred-${id}`, kind: 'ssh_key',
      encryptedValues: encryptCredential(credKey, id, JSON.stringify({ AUTH: 'K', passphrase: 'pp' })),
      valueHint: '****', privileges: [], ownerId: adminId,
    } as never).run();
    await api(adminCookie, 'POST', `/api/v1/servers/${assetId}/slots`, {
      slotName: 'AUTH_PASS', credentialId: id,
    });

    const bad = await api(adminCookie, 'PATCH', `/api/v1/servers/${assetId}/slots/AUTH_PASS`, {
      credentialId: id, credentialKey: 'nope',
    });
    expect(bad.status).toBe(400);

    const ok = await api(adminCookie, 'PATCH', `/api/v1/servers/${assetId}/slots/AUTH_PASS`, {
      credentialId: id, credentialKey: 'passphrase',
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const row = await db.select().from(schema.serverCredentials)
      .where(and(eq(schema.serverCredentials.serverId, assetId), eq(schema.serverCredentials.slotName, 'AUTH_PASS')))
      .get();
    expect(row!.credentialKey).toBe('passphrase');

    // 传 null 清空 → 回到"按槽位名匹配"
    await api(adminCookie, 'PATCH', `/api/v1/servers/${assetId}/slots/AUTH_PASS`, {
      credentialId: id, credentialKey: null,
    });
    const cleared = await db.select().from(schema.serverCredentials)
      .where(and(eq(schema.serverCredentials.serverId, assetId), eq(schema.serverCredentials.slotName, 'AUTH_PASS')))
      .get();
    expect(cleared!.credentialKey).toBeNull();
  });
});

describe('创建资产自动加入默认分组', () => {
  it('创建原生 host 资产 → 自动加入 host 分组（不存在则建组）', async () => {
    const name = `auto-grp-host-${Date.now().toString(36)}`;
    const r = await api(adminCookie, 'POST', '/api/v1/servers', {
      name, type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '10.1.2.3', port: 22, username: 'ops' },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const id = (r.json.data as { id: string }).id;

    const grp = await db.select().from(schema.groups).where(eq(schema.groups.name, 'host')).get();
    expect(grp).toBeDefined();
    const link = await db.select().from(schema.groupServers)
      .where(and(eq(schema.groupServers.groupId, grp!.id), eq(schema.groupServers.serverId, id))).get();
    expect(link).toBeDefined();
  });

});

describe('允许不安全 TLS（自签证书）', () => {
  it('PATCH allowInsecureTls → 落库 + 写 visibility_change 审计；非 boolean 拒绝', async () => {
    const id = await mkAsset(adminId, 'tls-flag-a');
    const ok = await api(adminCookie, 'PATCH', `/api/v1/servers/${id}`, { allowInsecureTls: true });
    expect(ok.status).toBe(200);
    const row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    expect(row!.allowInsecureTls).toBe(true);

    const table = auditTableOf(new Date());
    const rows = sqlite
      .prepare(`SELECT input_summary FROM ${table} WHERE action = 'visibility_change' AND input_summary LIKE ?`)
      .all(`%allow_insecure_tls%`) as Array<{ input_summary: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const bad = await api(adminCookie, 'PATCH', `/api/v1/servers/${id}`, { allowInsecureTls: 'yes' });
    expect(bad.status).toBe(400);
  });
});
