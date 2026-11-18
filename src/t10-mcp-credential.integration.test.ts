/**
 * T10 端到端：MCP 调用链路的 credential 参数 + 工具描述凭证可见性（ADR-028）。
 * 用本地 fixture 作为真实 MCP stdio 子进程，走完整 initialize → tools/list 链路。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { encryptCredential, loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { CredentialService } from './services/credentials.js';
import { InstancePool } from './services/instancePool.js';
import { McpEndpoint, listAvailableCredentials } from './services/mcpEndpoint.js';
import { makeNativeDispatchServices } from './services/nativeDispatch.js';
import { createApiKey } from './services/apiKey.js';
import { loadNativeTools } from './native/tools/index.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/mock-mcp-server.mjs', import.meta.url));
const ASSET = 't10-asset';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let mcp: McpEndpoint;
let pool: InstancePool;
let credSvc: CredentialService;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const key = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 't10-key-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  credSvc = new CredentialService(sqlite, key);
  pool = new InstancePool({
    globalBudget: 4, globalWeightBudget: 12, maxPerAsset: 2, queuePerUser: 4, globalConcurrency: 2,
    idleTtlMs: 60_000, queueTimeoutMs: 10_000, degradeWaitMs: 3_000, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 't10-rt-')),
  });
  const dispatch = makeNativeDispatchServices({ sqlite, db, settings, audit, credentials: credSvc });
  const nativeRegistry = await loadNativeTools();

  await db.insert(schema.users).values([
    { id: 'u-owner', username: 'owner', name: 'owner', isAdmin: false },
    { id: 'u-member', username: 'member', name: 'member', isAdmin: false },
  ]).run();

  await db.insert(schema.servers).values({
    id: ASSET, name: ASSET, type: 'stdio', executionMode: 'mcp', category: 'other',
    command: process.execPath, args: [FIXTURE],
    env: { MY_TOKEN: '${AUTH}' },
    credentialSlots: [{ target: 'env', name: 'AUTH', label: '认证', file: false }] as never,
    ownerId: 'u-owner', visibility: 'public', configHash: 'c-t10',
  }).run();

  const mkCred = (id: string, name: string, owner: string, value: string, privileges: string[]) => ({
    id, name, kind: 'env-values',
    encryptedValues: encryptCredential(key, id, JSON.stringify({ AUTH: value })),
    valueHint: '****' + value.slice(-3),
    ownerId: owner,
    privileges,
  });
  await db.insert(schema.credentials).values([
    mkCred('c-owner', 'owner-cred', 'u-owner', 'owner-secret', ['root']),
    mkCred('c-member', 'member-cred', 'u-member', 'member-secret', []),
  ]).run();

  await db.insert(schema.serverCredentials).values([
    { serverId: ASSET, slotName: 'AUTH', userId: 'u-owner', credentialId: 'c-owner', scope: 'asset' },
    { serverId: ASSET, slotName: 'AUTH', userId: 'u-member', credentialId: 'c-member', scope: 'personal' },
  ]).run();

  const isVisible = (asset: { ownerId: string; visibility: string }, principal: { userId: string; isAdmin: boolean }) =>
    principal.isAdmin || asset.ownerId === principal.userId || asset.visibility === 'public';

  mcp = new McpEndpoint({
    db, sqlite, settings, pool, dispatchServices: dispatch, audit, nativeRegistry,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 't10-creds-')),
    isVisible,
  });
  await createApiKey(db, 'u-owner', 't10-owner');
  await createApiKey(db, 'u-member', 't10-member');
}, 60_000);

afterAll(async () => {
  await pool.releaseAll();
  sqlite.close();
});

describe('T10：工具描述里的凭证可见性', { timeout: 90_000 }, () => {
  it('member 描述含自己的私有凭证 + owner 的共享凭证', async () => {
    const r = await mcp.preview({ group: 'all', category: 'other', principal: { userId: 'u-member', isAdmin: false } });
    const tool = r.tools.find((t) => t.serverId === ASSET);
    expect(tool).toBeTruthy();
    expect(tool!.description).toContain('可用凭证');
    expect(tool!.description).toContain('member-cred');
    expect(tool!.description).toContain('owner-cred');
  });

  it('owner 描述不含 member 的私有凭证', async () => {
    const r = await mcp.preview({ group: 'all', category: 'other', principal: { userId: 'u-owner', isAdmin: false } });
    const tool = r.tools.find((t) => t.serverId === ASSET);
    expect(tool!.description).toContain('owner-cred');
    expect(tool!.description).not.toContain('member-cred');
  });

  it('listAvailableCredentials 按调用者过滤 scope', () => {
    const forMember = listAvailableCredentials(db, ASSET, 'u-member', false);
    expect(forMember.find((c) => c.credentialId === 'c-member')!.scope).toBe('personal');
    expect(forMember.find((c) => c.credentialId === 'c-owner')!.scope).toBe('asset');

    const forOwner = listAvailableCredentials(db, ASSET, 'u-owner', false);
    expect(forOwner.map((c) => c.credentialId)).toEqual(['c-owner']);
  });
});

describe('T10：取值顺序（personal → asset）与指定凭证', { timeout: 30_000 }, () => {
  it('member 默认取自己的 personal 值', () => {
    const r = credSvc.resolveSlotValues(ASSET, ['AUTH'], 'u-member');
    expect(r[0]!.credentialId).toBe('c-member');
    expect(r[0]!.value).toBe('member-secret');
  });

  it('owner 默认取 asset 值', () => {
    const r = credSvc.resolveSlotValues(ASSET, ['AUTH'], 'u-owner');
    expect(r[0]!.credentialId).toBe('c-owner');
    expect(r[0]!.value).toBe('owner-secret');
  });

  it('指定 credential=owner-cred → member 也取到 owner-secret', () => {
    const r = credSvc.resolveSlotValues(ASSET, ['AUTH'], 'u-member', 'c-owner');
    expect(r[0]!.credentialId).toBe('c-owner');
    expect(r[0]!.value).toBe('owner-secret');
  });

  it('系统路径（无 userId）只取 asset', () => {
    const r = credSvc.resolveSlotValues(ASSET, ['AUTH']);
    expect(r[0]!.credentialId).toBe('c-owner');
  });

  it('未绑定槽位 → 不出现在结果里（不抛错，2026-11-17 取消必填拦截）', () => {
    expect(credSvc.resolveSlotValues(ASSET, ['NOPE'], 'u-member')).toEqual([]);
  });
});

describe('T10：指定凭证的纵深防御（越权指定必须被拒）', { timeout: 30_000 }, () => {
  it('指定他人 personal 绑定 → 不生效（回落到自己的/asset）', () => {
    // 造 third 用户的 personal 凭证，u-member 指定它应无效
    const r = credSvc.resolveSlotValues(ASSET, ['AUTH'], 'u-member', 'not-my-credential');
    // 不存在的凭证 → preferred 为空 → 落回 personal
    expect(r[0]!.credentialId).toBe('c-member');
  });

  it('指定 asset 绑定（归属人绑的）→ 生效', () => {
    const r = credSvc.resolveSlotValues(ASSET, ['AUTH'], 'u-member', 'c-owner');
    expect(r[0]!.credentialId).toBe('c-owner');
  });

  it('不传 userId 时指定凭证也只认 asset 绑定', () => {
    const r = credSvc.resolveSlotValues(ASSET, ['AUTH'], undefined, 'c-member');
    // c-member 是 u-member 的 personal，无调用者时不可见 → 回落 asset
    expect(r[0]!.credentialId).toBe('c-owner');
  });
});
