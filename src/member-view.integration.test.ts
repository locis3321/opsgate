/**
 * 成员视角权限收口（2026-11-17 用户 12 条反馈的回归锁定）。
 *
 * 覆盖：
 *  1. 成员只看自己相关的分组（REST + MCP 工具）
 *  2. 成员审计只看自己（列表 / 详情 / 统计）
 *  3. 内置安全规则管理员可改可删
 *  4. 分组关联构成查看权（组员能进详情页）
 *  5. 成员能在组内资产上绑自己的凭证
 *  6. 归属人同槽可并存 root(personal) + dev(asset)
 *  7. 共享开关：勾选=asset 全组可用、非归属人勾选被拒
 *  8. 条目分类变更同步派生资产
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
import { CredentialService } from './services/credentials.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
let bobId: string;
/** Alice 在 groupA；Bob 在 groupB */
let groupAId: string;
let groupBId: string;
/** 归 Alice 所有、关联到 groupA 的资产 */
let sharedAssetId: string;
let aliceCredId: string;
let bobCredId: string;

async function api(
  method: string,
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<{ status: number; json: { code: number; data: unknown; message?: string } }> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: payload !== undefined ? (payload as object) : undefined,
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as { code: number; data: unknown; message?: string } };
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in/username',
    payload: { username, password },
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
  });
  const cookies = res.headers['set-cookie'];
  const sc = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  return sc[0]!.split(';')[0]!;
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opsgate-member-view-'));
  sqlite = new Database(path.join(dir, 'test.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });

  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const key = loadCredentialKey(path.join(dir, 'test-master-key'));
  const credentials = new CredentialService(sqlite, key);
  const audit = new AuditService(sqlite, settings);
  const auth = createAuth(sqlite, { secret: 'x'.repeat(32), baseUrl: BASE_URL });
  await ensureAuthTables(auth);

  for (const [name, isAdmin] of [['admin', true], ['alice', false], ['bob', false]] as const) {
    const u = await createUserWithPassword(auth, { username: name, password: 'password-12345', isAdmin });
    if (name === 'alice') aliceId = u.user.id;
    if (name === 'bob') bobId = u.user.id;
  }

  // 分组：Alice 在 A，Bob 在 B（互不可见）
  const now = Date.now();
  const insGroup = sqlite.prepare('INSERT INTO groups (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)');
  insGroup.run('grp-a', 'team-a', 'A 组', now, now);
  insGroup.run('grp-b', 'team-b', 'B 组', now, now);
  groupAId = 'grp-a';
  groupBId = 'grp-b';
  const insMembership = sqlite.prepare('INSERT INTO group_users (group_id,user_id,created_at) VALUES (?,?,?)');
  insMembership.run(groupAId, aliceId, now);
  insMembership.run(groupBId, bobId, now);

  app = await buildApp({
    db,
    sqlite,
    auth,
    settings,
    credentials,
    audit,
    baseUrl: BASE_URL,
    cryptoKey: key,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'rt-')),
  });

  // 内置规则（生产由 db/seed.ts 播种；测试内联一条，避免为了跑测试去执行 CLI 脚本）
  sqlite.prepare(`INSERT INTO guard_rules (id, name, kind, target, pattern, enabled, priority, locked, builtin)
    VALUES ('gr-builtin-test','内置 block 测试','block','arg','^NEVER_MATCH$',1,1000,1,1)`).run();

  adminCookie = await login('admin', 'password-12345');
  aliceCookie = await login('alice', 'password-12345');
  bobCookie = await login('bob', 'password-12345');

  // Alice 建一个资产（visibility 默认 owner），再加进 groupA
  const srv = await api('POST', '/api/v1/servers', aliceCookie, {
    name: 'member-view-host',
    type: 'native',
    executionMode: 'native',
    category: 'host',
    hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
    credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
  });
  expect(srv.status, `POST /servers → ${srv.status}: ${srv.json.message}`).toBe(200);
  sharedAssetId = (srv.json.data as { id: string }).id;
  // 通过 admin 把它关联进 groupA（分组管理是 admin-only）
  const link = await api('POST', `/api/v1/groups/${groupAId}/servers`, adminCookie, { serverIds: [sharedAssetId] });
  expect(link.status).toBe(200);

  aliceCredId = ((await api('POST', '/api/v1/credentials', aliceCookie, { name: 'alice-ssh', values: { AUTH: 'k1' } })).json.data as { id: string }).id;
  bobCredId = ((await api('POST', '/api/v1/credentials', bobCookie, { name: 'bob-ssh', values: { AUTH: 'k2' } })).json.data as { id: string }).id;
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

describe('#1 成员只看自己相关的分组', () => {
  it('Alice 只看到 team-a，看不到 team-b', async () => {
    const res = await api('GET', '/api/v1/groups', aliceCookie);
    const names = (res.json.data as Array<{ name: string }>).map((g) => g.name);
    expect(names).toContain('team-a');
    expect(names).not.toContain('team-b');
  });

  it('admin 看到全部分组', async () => {
    const res = await api('GET', '/api/v1/groups', adminCookie);
    const names = (res.json.data as Array<{ name: string }>).map((g) => g.name);
    expect(names).toEqual(expect.arrayContaining(['team-a', 'team-b']));
  });

  it('Bob 打开 team-a 详情 → 403', async () => {
    const res = await api('GET', `/api/v1/groups/${groupAId}`, bobCookie);
    expect(res.status).toBe(403);
  });
});

describe('#2 成员审计只看自己', () => {
  it('Alice 的审计列表里只有自己的记录（userId 过滤被强制）', async () => {
    // 制造治理事件：双方各改自己资产的启用状态（写 asset_enabled_change 审计）
    await api('PATCH', `/api/v1/servers/${sharedAssetId}`, aliceCookie, { enabled: false });
    await api('PATCH', `/api/v1/servers/${sharedAssetId}`, aliceCookie, { enabled: true });
    const bobAsset = await api('POST', '/api/v1/servers', bobCookie, {
      name: 'bob-audit-asset', type: 'native', executionMode: 'native', category: 'host',
      hostConn: { host: '127.0.0.1', port: 22, username: 'ops', authSlot: 'AUTH' },
      credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    });
    const bobAssetId = (bobAsset.json.data as { id: string }).id;
    await api('PATCH', `/api/v1/servers/${bobAssetId}`, bobCookie, { enabled: false });

    const res = await api('GET', '/api/v1/audit?page=1', aliceCookie);
    const items = (res.json.data as { items: Array<{ user_id?: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((r) => r.user_id === aliceId)).toBe(true);
  });

  it('Alice 传 userId=bob 仍只拿到自己的记录（不能越权查询）', async () => {
    const res = await api('GET', `/api/v1/audit?page=1&userId=${bobId}`, aliceCookie);
    const items = (res.json.data as { items: Array<{ user_id?: string }> }).items;
    expect(items.every((r) => r.user_id === aliceId)).toBe(true);
  });

  it('成员取全局统计 → 403', async () => {
    expect((await api('GET', '/api/v1/audit/stats?groupBy=global&window=24h', aliceCookie)).status).toBe(403);
  });
});

describe('#3 内置安全规则可由管理员改删', () => {
  it('删除一条内置 block 规则 → 200 且留下审计', async () => {
    const rows = sqlite.prepare("SELECT id FROM guard_rules WHERE builtin=1 AND kind='block' LIMIT 1").get() as { id: string } | undefined;
    expect(rows).toBeDefined();
    const res = await api('DELETE', `/api/v1/guard-rules/${rows!.id}`, adminCookie);
    expect(res.status).toBe(200);
    expect(sqlite.prepare('SELECT id FROM guard_rules WHERE id=?').get(rows!.id)).toBeUndefined();
  });

  it('成员不能改规则（仍是 admin-only）', async () => {
    // 用新建的自定义规则（前面的用例可能已删掉内置规则）
    const created = await api('POST', '/api/v1/guard-rules', adminCookie, {
      name: 'member-view-test-rule', kind: 'mark', target: 'arg', pattern: '^MEMBER_VIEW_NEVER$',
    });
    expect(created.status).toBe(200);
    const ruleId = (created.json.data as { id: string }).id;
    const res = await api('PATCH', `/api/v1/guard-rules/${ruleId}`, aliceCookie, { enabled: false });
    expect(res.status).toBe(403);
  });
});

describe('#4 分组关联构成查看权', () => {
  it('Alice 能看自己资产的详情（基线）', async () => {
    expect((await api('GET', `/api/v1/servers/${sharedAssetId}`, aliceCookie)).status).toBe(200);
  });

  it('Bob（不在组内）看不到该资产 → 404', async () => {
    expect((await api('GET', `/api/v1/servers/${sharedAssetId}`, bobCookie)).status).toBe(404);
  });

  it('把 Bob 加进 groupA 后（资产仍是 owner 可见），Bob 能看详情 —— 分组关联即构成查看权', async () => {
    await api('POST', `/api/v1/groups/${groupAId}/users`, adminCookie, { userIds: [bobId] });
    // visibility 从未改动，仍是 owner
    const row = sqlite.prepare('SELECT visibility FROM servers WHERE id=?').get(sharedAssetId) as { visibility: string };
    expect(row.visibility).toBe('owner');
    const res = await api('GET', `/api/v1/servers/${sharedAssetId}`, bobCookie);
    expect(res.status).toBe(200);
  });
});

describe('#5/#6/#7 成员绑凭证 + 一槽多凭证 + 共享开关', () => {
  it('Bob（组员）能把自己的凭证绑到 Alice 的资产 → scope=personal', async () => {
    const res = await api('POST', `/api/v1/servers/${sharedAssetId}/slots`, bobCookie, { slotName: 'AUTH', credentialId: bobCredId });
    expect(res.status).toBe(200);
    const row = sqlite.prepare('SELECT scope FROM server_credentials WHERE server_id=? AND slot_name=? AND user_id=?').get(sharedAssetId, 'AUTH', bobId) as { scope: string };
    expect(row.scope).toBe('personal');
  });

  it('Bob 不能传 shared=true（不能把凭证共享给他人）', async () => {
    const res = await api('POST', `/api/v1/servers/${sharedAssetId}/slots`, bobCookie, { slotName: 'AUTH', credentialId: bobCredId, shared: true });
    expect(res.status).toBe(400);
  });

  it('Alice 同槽可并存 root(personal) 与 dev(asset) 两条绑定', async () => {
    const devCred = ((await api('POST', '/api/v1/credentials', aliceCookie, { name: 'alice-dev', values: { AUTH: 'devkey' } })).json.data as { id: string }).id;
    // root：自用
    expect((await api('POST', `/api/v1/servers/${sharedAssetId}/slots`, aliceCookie, { slotName: 'AUTH', credentialId: aliceCredId, label: 'root' })).status).toBe(200);
    // dev：共享给组内
    expect((await api('POST', `/api/v1/servers/${sharedAssetId}/slots`, aliceCookie, { slotName: 'AUTH', credentialId: devCred, label: 'dev', shared: true })).status).toBe(200);
    const rows = sqlite.prepare('SELECT credential_id, scope FROM server_credentials WHERE server_id=? AND slot_name=? AND user_id=?').all(sharedAssetId, 'AUTH', aliceId) as Array<{ credential_id: string; scope: string }>;
    expect(rows.map((r) => `${r.credential_id}:${r.scope}`).sort()).toEqual([`${aliceCredId}:personal`, `${devCred}:asset`].sort());
  });

  it('共享开关可切换 personal → asset（PATCH 带 credentialId）', async () => {
    const res = await api('PATCH', `/api/v1/servers/${sharedAssetId}/slots/AUTH`, aliceCookie, { credentialId: aliceCredId, shared: true });
    expect(res.status).toBe(200);
    const row = sqlite.prepare('SELECT scope FROM server_credentials WHERE server_id=? AND slot_name=? AND user_id=? AND credential_id=?').get(sharedAssetId, 'AUTH', aliceId, aliceCredId) as { scope: string };
    expect(row.scope).toBe('asset');
  });

  it('槽位列表：Bob 能看到自己的 + Alice 的 asset 绑定，看不到 Alice 的 personal', async () => {
    const res = await api('GET', `/api/v1/servers/${sharedAssetId}/slots`, bobCookie);
    const slot = (res.json.data as Array<{ slotName: string; bindings?: Array<{ userId: string; scope: string; credentialId: string }> }>)[0]!;
    const binds = slot.bindings ?? [];
    // 自己的那条（personal）
    expect(binds.some((b) => b.userId === bobId)).toBe(true);
    // Alice 的 asset（shared=true 的那条 root）
    expect(binds.some((b) => b.userId === aliceId && b.scope === 'asset')).toBe(true);
    // Alice 的 personal（dev）不该出现
    const alicePersonal = sqlite
      .prepare("SELECT credential_id AS cid FROM server_credentials WHERE server_id=? AND user_id=? AND scope='personal'")
      .all(sharedAssetId, aliceId) as Array<{ cid: string }>;
    for (const p of alicePersonal) {
      expect(binds.some((b) => b.credentialId === p.cid)).toBe(false);
    }
  });

  it('归属人写直填值 → 只清自己的绑定，成员的 personal 绑定保留', async () => {
    // 前置：Alice 在该槽位有自己的绑定、Bob 有 personal 绑定（上一批用例已建立）
    const before = sqlite
      .prepare('SELECT user_id, credential_id FROM server_credentials WHERE server_id=? AND slot_name=?')
      .all(sharedAssetId, 'AUTH') as Array<{ user_id: string; credential_id: string }>;
    expect(before.some((r) => r.user_id === aliceId)).toBe(true);
    expect(before.some((r) => r.user_id === bobId)).toBe(true);

    const put = await api('PUT', `/api/v1/servers/${sharedAssetId}/slots/AUTH/value`, aliceCookie, { value: 'owner-inline-secret' });
    expect(put.status).toBe(200);

    const after = sqlite
      .prepare('SELECT user_id FROM server_credentials WHERE server_id=? AND slot_name=?')
      .all(sharedAssetId, 'AUTH') as Array<{ user_id: string }>;
    // 归属人自己的绑定被清（与直填值互斥）
    expect(after.some((r) => r.user_id === aliceId)).toBe(false);
    // 成员的 personal 绑定必须还在 —— 归属人写直填值不该顺手删掉别人的凭证
    expect(after.some((r) => r.user_id === bobId)).toBe(true);
  });

  it('SSH 私钥凭证可带用户名：创建 → 绑定 → 按调用者解析出自己的账号', async () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const created = await api('POST', '/api/v1/credentials', bobCookie, {
      name: 'bob-ssh-key', kind: 'ssh_key', values: { AUTH: pem, username: 'deploy' },
    });
    expect(created.status, `创建 → ${created.status}: ${created.json.message}`).toBe(200);
    const credId = (created.json.data as { id: string }).id;
    expect((await api('POST', `/api/v1/servers/${sharedAssetId}/slots`, bobCookie, { slotName: 'AUTH', credentialId: credId })).status).toBe(200);
    // 候选列表回带凭证的键名：username 真的落库了（不是被表单吞掉）
    const cands = await api('GET', `/api/v1/credentials/candidates?assetId=${sharedAssetId}`, bobCookie);
    const mine = (cands.json.data as Array<{ id: string; keys?: string[] }>).find((c) => c.id === credId);
    expect(mine?.keys).toEqual(expect.arrayContaining(['AUTH', 'username']));
  });

  it('每条绑定可单独指定 SSH 用户名（PATCH username），可清除回落', async () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nBBBB\n-----END OPENSSH PRIVATE KEY-----';
    const created = await api('POST', '/api/v1/credentials', aliceCookie, {
      name: 'alice-bind-user', kind: 'ssh_key', values: { AUTH: pem },
    });
    const credId = (created.json.data as { id: string }).id;
    expect((await api('POST', `/api/v1/servers/${sharedAssetId}/slots`, aliceCookie, {
      slotName: 'AUTH', credentialId: credId, username: 'root',
    })).status).toBe(200);
    const col = () => (sqlite
      .prepare('SELECT username FROM server_credentials WHERE server_id=? AND slot_name=? AND user_id=? AND credential_id=?')
      .get(sharedAssetId, 'AUTH', aliceId, credId) as { username: string | null }).username;
    expect(col()).toBe('root');

    // 只改用户名（不带 shared）——PATCH 是部分更新
    const patch = await api('PATCH', `/api/v1/servers/${sharedAssetId}/slots/AUTH`, aliceCookie, { credentialId: credId, username: 'deploy' });
    expect(patch.status, `PATCH → ${patch.status}: ${patch.json.message}`).toBe(200);
    expect(col()).toBe('deploy');

    // 清空 = 回落凭证/资产上的用户名
    expect((await api('PATCH', `/api/v1/servers/${sharedAssetId}/slots/AUTH`, aliceCookie, { credentialId: credId, username: '' })).status).toBe(200);
    expect(col()).toBeNull();

    // 槽位列表把该值回给前端
    await api('PATCH', `/api/v1/servers/${sharedAssetId}/slots/AUTH`, aliceCookie, { credentialId: credId, username: 'root2' });
    const slots = await api('GET', `/api/v1/servers/${sharedAssetId}/slots`, aliceCookie);
    const binds = (slots.json.data as Array<{ slotName: string; bindings?: Array<{ credentialId: string; username?: string | null }> }>)
      .find((s) => s.slotName === 'AUTH')?.bindings ?? [];
    expect(binds.find((b) => b.credentialId === credId)?.username).toBe('root2');
  });
});

describe('#8 条目分类变更同步派生资产', () => {
  it('PATCH 条目 categories → 派生资产 category 跟着变', async () => {
    // makeMarketRoutes 需要实例池，本测试不装池；直接造"从该条目派生"的资产来验证同步逻辑
    const create = await api('POST', '/api/v1/market/entries', adminCookie, {
      key: 'sync-cat-test',
      name: 'sync-cat-test',
      displayName: 'Sync Cat Test',
      description: 'for category sync test',
      repository: 'https://example.invalid/repo',
      categories: ['other'],
      tags: [],
      runtime: 'npm',
      installations: { npm: { command: 'npx', args: ['-y', 'example'] } },
    });
    expect(create.status).toBe(201);
    const srv = await api('POST', '/api/v1/servers', aliceCookie, {
      name: 'sync-cat-asset',
      type: 'stdio',
      executionMode: 'mcp',
      category: 'other',
      command: 'npx',
      args: ['-y', 'example'],
      env: {},
    });
    expect(srv.status).toBe(200);
    const assetId = (srv.json.data as { id: string }).id;
    // 标记为来自该条目（实例化链路会写 market_key）
    sqlite.prepare('UPDATE servers SET market_key=? WHERE id=?').run('sync-cat-test', assetId);

    const patch = await api('PATCH', '/api/v1/market/entries/sync-cat-test', adminCookie, { categories: ['monitor'] });
    expect(patch.status, `PATCH entry → ${patch.status}: ${patch.json.message}`).toBe(200);
    expect((patch.json.data as { syncedAssets: number }).syncedAssets).toBe(1);
    expect((sqlite.prepare('SELECT category FROM servers WHERE id=?').get(assetId) as { category: string }).category).toBe('monitor');
  });
});
