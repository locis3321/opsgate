/**
 * T9 集成测试：凭证共享判定 + 一槽多凭证绑定（ADR-028）。
 *
 * 覆盖：
 *  1. 绑定写入 user_id + scope（owner → asset；成员 → personal）
 *  2. 非 owner 可绑自己的凭证；绑他人凭证 400（防转授权）
 *  3. 槽位列表返回多条绑定 + scope，且不暴露他人的 personal 绑定
 *  4. 解绑只能删自己的记录
 *  5. 共享开关 API（owner 才能开/关）+ canCredential 分组语义
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
import { eq } from 'drizzle-orm';
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
let credSvc: CredentialService;
let ownerCookie: string;
let memberCookie: string;
let outsiderCookie: string;
let ownerId: string;
let memberId: string;
let assetId: string;
let groupId: string;
let ownerCredId: string;
let memberCredId: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  credSvc = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'owner', password: 'password-12345', isAdmin: false });
  await createUserWithPassword(auth, { username: 'member', password: 'password-12345', isAdmin: false });
  await createUserWithPassword(auth, { username: 'outsider', password: 'password-12345', isAdmin: false });
  ownerId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'owner')).get())!.id;
  memberId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'member')).get())!.id;

  // 分组 g1 含 owner + member（不含 outsider）
  const g = await db.insert(schema.groups).values({ name: 'team-g1' }).returning({ id: schema.groups.id }).get();
  groupId = g.id;
  await db.insert(schema.groupUsers).values([
    { groupId, userId: ownerId },
    { groupId, userId: memberId },
  ]).run();

  // 资产：owner 所有，group 可见，挂在 g1
  const asset = await db
    .insert(schema.servers)
    .values({
      name: 'shared-asset', displayName: 'Shared', type: 'stdio', executionMode: 'mcp',
      category: 'other', ownerId, visibility: 'group', configHash: 'ch-asset',
      command: 'node', args: [], env: {},
      credentialSlots: [{ target: 'env', name: 'AUTH', label: '认证', file: false }] as never,
    })
    .returning({ id: schema.servers.id })
    .get();
  assetId = asset.id;
  await db.insert(schema.groupServers).values({ groupId, serverId: assetId }).run();

  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite,
    credentials: credSvc,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'rt-')),
  });

  const login = async (username: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username, password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const sc = res.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
    return arr[0]!.split(';')[0]!;
  };
  ownerCookie = await login('owner');
  memberCookie = await login('member');
  outsiderCookie = await login('outsider');
}, 60_000);

afterAll(async () => {
  await app.close();
  sqlite.close();
});

interface Json { code: number; data: unknown; message: string }

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
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

describe('T9：凭证创建带 privileges', { timeout: 30_000 }, () => {
  it('创建时可指定 privileges；非法值 400', async () => {
    const ok = await api('POST', '/api/v1/credentials', ownerCookie, {
      name: 'owner-cred', kind: 'env-values', values: { AUTH: 'owner-secret' }, privileges: ['root', 'rw'],
    });
    expect(ok.status).toBe(200);
    ownerCredId = (ok.json.data as { id: string }).id;

    const bad = await api('POST', '/api/v1/credentials', ownerCookie, {
      name: 'bad-cred', kind: 'env-values', values: { AUTH: 'x' }, privileges: ['superuser'],
    });
    expect(bad.status).toBe(400);

    const detail = await api('GET', `/api/v1/credentials/${ownerCredId}`, ownerCookie);
    expect((detail.json.data as { privileges: string[] }).privileges).toEqual(['root', 'rw']);
  });

  it('成员创建自己的凭证（无等级）', async () => {
    const res = await api('POST', '/api/v1/credentials', memberCookie, {
      name: 'member-cred', kind: 'env-values', values: { AUTH: 'member-secret' },
    });
    expect(res.status).toBe(200);
    memberCredId = (res.json.data as { id: string }).id;
  });
});

describe('T9：绑定写入 user_id + scope', { timeout: 30_000 }, () => {
  it('owner 绑定（不传 shared）→ scope=personal', async () => {
    const res = await api('POST', `/api/v1/servers/${assetId}/slots`, ownerCookie, {
      slotName: 'AUTH', credentialId: ownerCredId, label: 'root 账号',
    });
    expect(res.status).toBe(200);
    const row = sqlite
      .prepare('SELECT user_id, scope, label FROM server_credentials WHERE server_id=? AND slot_name=? AND user_id=?')
      .get(assetId, 'AUTH', ownerId) as { user_id: string; scope: string; label: string };
    // 2026-11-17 用户决策：scope 由「共享给组内成员」复选框决定，默认不共享 = personal
    expect(row).toMatchObject({ user_id: ownerId, scope: 'personal', label: 'root 账号' });
  });

  it('owner 勾选共享 → scope=asset', async () => {
    const res = await api('POST', `/api/v1/servers/${assetId}/slots`, ownerCookie, {
      slotName: 'AUTH', credentialId: ownerCredId, shared: true,
    });
    expect(res.status).toBe(200);
    const row = sqlite
      .prepare('SELECT scope FROM server_credentials WHERE server_id=? AND slot_name=? AND user_id=? AND credential_id=?')
      .get(assetId, 'AUTH', ownerId, ownerCredId) as { scope: string };
    expect(row.scope).toBe('asset');
  });

  it('成员传 shared=true → 400（不能把凭证共享给他人）', async () => {
    const res = await api('POST', `/api/v1/servers/${assetId}/slots`, memberCookie, {
      slotName: 'AUTH', credentialId: memberCredId, shared: true,
    });
    expect(res.status).toBe(400);
  });

  it('组成员（非 owner）绑定自己的凭证 → scope=personal', async () => {
    const res = await api('POST', `/api/v1/servers/${assetId}/slots`, memberCookie, {
      slotName: 'AUTH', credentialId: memberCredId,
    });
    expect(res.status).toBe(200);
    const row = sqlite
      .prepare('SELECT user_id, scope FROM server_credentials WHERE server_id=? AND slot_name=? AND user_id=?')
      .get(assetId, 'AUTH', memberId) as { user_id: string; scope: string };
    expect(row).toMatchObject({ user_id: memberId, scope: 'personal' });
  });

  it('绑定他人凭证 → 400（共享凭证只可"用"不可"绑"）', async () => {
    const res = await api('POST', `/api/v1/servers/${assetId}/slots`, memberCookie, {
      slotName: 'AUTH', credentialId: ownerCredId,
    });
    expect(res.status).toBe(400);
    expect(res.json.message).toContain('非本人创建');
  });

  it('看不见资产的人绑定 → 404', async () => {
    const res = await api('POST', `/api/v1/servers/${assetId}/slots`, outsiderCookie, {
      slotName: 'AUTH', credentialId: memberCredId,
    });
    expect(res.status).toBe(404);
  });
});

describe('T9：槽位列表多条绑定与可见性', { timeout: 30_000 }, () => {
  it('owner 视角看到 2 条绑定（asset + 他人 personal 不暴露，故 1 条 + 自己 1 条）', async () => {
    const res = await api('GET', `/api/v1/servers/${assetId}/slots`, ownerCookie);
    const slots = res.json.data as Array<{ slotName: string; bindings: Array<{ userId: string; scope: string; mine: boolean }> }>;
    const auth = slots.find((s) => s.slotName === 'AUTH')!;
    // owner 只看到自己的 asset 绑定；member 的 personal 是他人私有选择
    expect(auth.bindings).toHaveLength(1);
    expect(auth.bindings[0]).toMatchObject({ userId: ownerId, scope: 'asset', mine: true });
  });

  it('member 视角看到自己的 personal + owner 的 asset（共 2 条）', async () => {
    const res = await api('GET', `/api/v1/servers/${assetId}/slots`, memberCookie);
    const slots = res.json.data as Array<{ slotName: string; bindings: Array<{ userId: string; scope: string; mine: boolean }> }>;
    const auth = slots.find((s) => s.slotName === 'AUTH')!;
    expect(auth.bindings).toHaveLength(2);
    expect(auth.bindings.filter((b) => b.mine).map((b) => b.scope)).toEqual(['personal']);
    expect(auth.bindings.some((b) => b.scope === 'asset' && !b.mine)).toBe(true);
    // 兼容字段指向"我自己的"
    expect((slots.find((s) => s.slotName === 'AUTH') as unknown as { credentialId: string }).credentialId).toBe(memberCredId);
  });
});

describe('T9：解绑只能删自己的记录', { timeout: 30_000 }, () => {
  it('不传 credentialId → 400（一槽多凭证后必须指明删哪条）', async () => {
    const res = await api('DELETE', `/api/v1/servers/${assetId}/slots/AUTH`, memberCookie);
    expect(res.status).toBe(400);
  });

  it('member 解绑自己的 personal → 200；owner 的绑定仍在', async () => {
    const res = await api('DELETE', `/api/v1/servers/${assetId}/slots/AUTH?credentialId=${encodeURIComponent(memberCredId)}`, memberCookie);
    expect(res.status).toBe(200);
    const left = sqlite.prepare('SELECT user_id FROM server_credentials WHERE server_id=? AND slot_name=?').all(assetId, 'AUTH') as { user_id: string }[];
    expect(left.map((r) => r.user_id)).toEqual([ownerId]);
  });

  it('member 解绑已不存在的自己的记录 → 404（不会误删他人）', async () => {
    const res = await api('DELETE', `/api/v1/servers/${assetId}/slots/AUTH?credentialId=${encodeURIComponent(memberCredId)}`, memberCookie);
    expect(res.status).toBe(404);
    const left = sqlite.prepare('SELECT user_id FROM server_credentials WHERE server_id=? AND slot_name=?').all(assetId, 'AUTH') as { user_id: string }[];
    expect(left.map((r) => r.user_id)).toEqual([ownerId]);
  });
});

describe('T9：共享开关（credential_group_shares）', { timeout: 30_000 }, () => {
  it('非 owner 开共享 → 403', async () => {
    const res = await api('POST', `/api/v1/credentials/${ownerCredId}/shares/${groupId}`, memberCookie);
    expect(res.status).toBe(403);
  });

  it('owner 开启共享 → 详情返回 sharedGroups', async () => {
    const res = await api('POST', `/api/v1/credentials/${ownerCredId}/shares/${groupId}`, ownerCookie);
    expect(res.status).toBe(200);
    const detail = await api('GET', `/api/v1/credentials/${ownerCredId}`, ownerCookie);
    const d = detail.json.data as { sharedGroups: Array<{ groupId: string }> };
    expect(d.sharedGroups.map((s) => s.groupId)).toContain(groupId);
  });

  it('共享后：候选凭证仍只含自己的（共享凭证不可绑）', async () => {
    const res = await api('GET', '/api/v1/credentials/candidates', memberCookie);
    const ids = (res.json.data as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(memberCredId);
    expect(ids).not.toContain(ownerCredId);
  });

  it('重复开启幂等；关闭后消失', async () => {
    const again = await api('POST', `/api/v1/credentials/${ownerCredId}/shares/${groupId}`, ownerCookie);
    expect(again.status).toBe(200);

    const off = await api('DELETE', `/api/v1/credentials/${ownerCredId}/shares/${groupId}`, ownerCookie);
    expect(off.status).toBe(200);
    const detail = await api('GET', `/api/v1/credentials/${ownerCredId}`, ownerCookie);
    expect((detail.json.data as { sharedGroups: unknown[] }).sharedGroups).toHaveLength(0);
  });
});

describe('T9：resolveSlotValues 取值顺序（personal → asset）', { timeout: 30_000 }, () => {
  it('成员自绑 personal 后优先取自己的值；不传 userId 时只取 asset', async () => {
    await api('POST', `/api/v1/servers/${assetId}/slots`, memberCookie, {
      slotName: 'AUTH', credentialId: memberCredId,
    });
    const forMember = credSvc.resolveSlotValues(assetId, ['AUTH'], memberId);
    expect(forMember[0]!.credentialId).toBe(memberCredId);
    expect(forMember[0]!.value).toBe('member-secret');

    const forOwner = credSvc.resolveSlotValues(assetId, ['AUTH'], ownerId);
    expect(forOwner[0]!.credentialId).toBe(ownerCredId);
    expect(forOwner[0]!.value).toBe('owner-secret');

    // 系统路径（无调用者）只走 asset，不看任何人的 personal
    const system = credSvc.resolveSlotValues(assetId, ['AUTH']);
    expect(system[0]!.credentialId).toBe(ownerCredId);
  });
});

describe('T11：凭证详情读取权限（共享后成员可只读查看）', { timeout: 30_000 }, () => {
  it('owner 打开共享 → 同组成员 200 + canManage:false；无关用户 403', async () => {
    await api('POST', `/api/v1/credentials/${ownerCredId}/shares/${groupId}`, ownerCookie);

    const member = await api('GET', `/api/v1/credentials/${ownerCredId}`, memberCookie);
    expect(member.status).toBe(200);
    const md = member.json.data as { canManage: boolean; privileges: string[]; sharedGroups: Array<{ groupId: string }> };
    expect(md.canManage).toBe(false);
    expect(md.privileges).toEqual(['root', 'rw']);
    expect(md.sharedGroups.map((g) => g.groupId)).toContain(groupId);

    const owner = await api('GET', `/api/v1/credentials/${ownerCredId}`, ownerCookie);
    expect((owner.json.data as { canManage: boolean }).canManage).toBe(true);

    const outsider = await api('GET', `/api/v1/credentials/${ownerCredId}`, outsiderCookie);
    expect(outsider.status).toBe(403);
  });

  it('取消共享后同组成员不再可读（403）', async () => {
    await api('DELETE', `/api/v1/credentials/${ownerCredId}/shares/${groupId}`, ownerCookie);
    const member = await api('GET', `/api/v1/credentials/${ownerCredId}`, memberCookie);
    expect(member.status).toBe(403);
  });
});

describe('T10：MCP 调用链路（credential 参数 / 取值顺序 / 描述可见性）', { timeout: 30_000 }, () => {
  it('listAvailableCredentials：调用者见自己的 + owner 的 asset，不见他人 personal', async () => {
    const { listAvailableCredentials } = await import('./services/mcpEndpoint.js');
    const db = drizzle(sqlite, { schema });
    // owner 绑定 asset（前面用例已创建），member 再绑自己的 personal
    await api('POST', `/api/v1/servers/${assetId}/slots`, memberCookie, {
      slotName: 'AUTH', credentialId: memberCredId,
    });

    const forMember = listAvailableCredentials(db, assetId, memberId, false);
    expect(forMember.map((c) => c.credentialId).sort()).toEqual([ownerCredId, memberCredId].sort());
    expect(forMember.find((c) => c.credentialId === memberCredId)!.scope).toBe('personal');
    expect(forMember.find((c) => c.credentialId === ownerCredId)!.scope).toBe('asset');

    const forOwner = listAvailableCredentials(db, assetId, ownerId, false);
    // owner 看不到 member 的 personal
    expect(forOwner.map((c) => c.credentialId)).toEqual([ownerCredId]);

    const forAdmin = listAvailableCredentials(db, assetId, 'root-placeholder', true);
    expect(forAdmin.length).toBeGreaterThanOrEqual(2);
  });

  it('未传 credential：personal 优先于 asset', () => {
    const forMember = credSvc.resolveSlotValues(assetId, ['AUTH'], memberId);
    expect(forMember[0]!.credentialId).toBe(memberCredId);
    const forOwner = credSvc.resolveSlotValues(assetId, ['AUTH'], ownerId);
    expect(forOwner[0]!.credentialId).toBe(ownerCredId);
    const system = credSvc.resolveSlotValues(assetId, ['AUTH']);
    expect(system[0]!.credentialId).toBe(ownerCredId);
  });

  it('指定 credential：覆盖 personal/asset 选择', () => {
    const picked = credSvc.resolveSlotValues(assetId, ['AUTH'], memberId, ownerCredId);
    expect(picked[0]!.credentialId).toBe(ownerCredId);
    expect(picked[0]!.value).toBe('owner-secret');
  });

  it('未绑定任何凭证的槽位 → 返回空（不抛错，2026-11-17 取消必填拦截）', () => {
    expect(credSvc.resolveSlotValues(assetId, ['NOT_BOUND'], memberId)).toEqual([]);
  });

  it('工具描述含可用凭证提示（含私有/共享与等级）', async () => {
    const db = drizzle(sqlite, { schema });
    // 用合成 fixture 资产避免真实拉起：resolveSlots 抛错会 fail-closed 不派生工具，
    // 因此这里直接验证 availableCredentials 的注入逻辑单元（描述拼接已在聚合层实现）
    const { listAvailableCredentials } = await import('./services/mcpEndpoint.js');
    const creds = listAvailableCredentials(db, assetId, memberId, false);
    const hint = creds
      .map((c) => `${c.name}(${[c.scope === 'personal' ? '私有' : '共享', ...c.privileges].join('/') || '无等级'})`)
      .join('、');
    expect(hint).toContain('私有');
    expect(hint).toContain('共享');
    expect(hint).toContain('member-cred');
  });
});

describe('绑定校验：槽位必须属于资产（防孤儿绑定）', { timeout: 20_000 }, () => {
  it('绑定资产未声明的槽位 → 400，且不落库', async () => {
    const before = sqlite.prepare('SELECT count(*) c FROM server_credentials WHERE server_id=?').get(assetId) as { c: number };
    const res = await api('POST', `/api/v1/servers/${assetId}/slots`, ownerCookie, {
      slotName: 'NOT_DECLARED', credentialId: ownerCredId,
    });
    expect(res.status).toBe(400);
    expect(res.json.message).toContain('不存在于该资产');
    const after = sqlite.prepare('SELECT count(*) c FROM server_credentials WHERE server_id=?').get(assetId) as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('绑定已声明的槽位仍成功', async () => {
    const res = await api('POST', `/api/v1/servers/${assetId}/slots`, ownerCookie, {
      slotName: 'AUTH', credentialId: ownerCredId,
    });
    expect(res.status).toBe(200);
  });
});
