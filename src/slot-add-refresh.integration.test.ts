/**
 * 回归测试：补槽位后的生效链路。
 *
 * 用户反馈（2026-11-20）：主机资产添加 AUTH_PASS 槽位后，「私钥口令槽位」区块
 * 需要手动刷新整个页面才能看到新槽位；且补槽位后已运行实例不会重建。
 *
 * 两处独立问题：
 *  1. 前端：补槽位只失效了 ['slots', assetId]，没失效 ['asset', assetId]，
 *     而该区块的候选来自 asset.credentialSlots → 页面不刷新就看不到。
 *  2. 后端：实例键只含「已绑定槽位」，不含声明列表；PATCH credentialSlots 后
 *     不回收实例，导致新槽位即便绑了值，运行中的实例仍用旧计划。
 * 本文件覆盖第 2 点（后端可测）；第 1 点靠浏览器验收。
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
import { CredentialService } from './services/credentials.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let cookie: string;

/** 记录被回收的实例键，用来断言"补槽位确实触发了回收" */
const invalidated = new Set<string>();

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'slot-refresh-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  app = await buildApp({
    db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, credentials,
    // 只实现 invalidate 的桩：本用例只关心"有没有被调用"，不关心池的真实行为
    instancePool: { invalidate: (key: string) => { invalidated.add(key); }, acquire: async () => { throw new Error('unused'); }, release: async () => {}, releaseAll: async () => {}, prewarm: async () => 0 } as never,
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

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function makeHostWithAuthBinding(id: string): Promise<string> {
  const cred = await api('POST', '/api/v1/credentials', {
    name: `c-${id}`, kind: 'ssh_key',
    values: { AUTH: '-----BEGIN OPENSSH PRIVATE KEY-----\nX\n-----END OPENSSH PRIVATE KEY-----', AUTH_PASS: 'pp' },
  });
  const credId = (cred.json.data as { id: string }).id;
  const srv = await api('POST', '/api/v1/servers', {
    name: id, type: 'native', executionMode: 'native', category: 'host',
    hostConn: { host: '10.0.0.9', port: 22, username: 'root', authSlot: 'AUTH' },
    credentialSlots: [{ target: 'env', name: 'AUTH', label: 'SSH', file: true }],
  });
  const serverId = (srv.json.data as { id: string }).id;
  await api('POST', `/api/v1/servers/${serverId}/slots`, { slotName: 'AUTH', credentialId: credId, scope: 'asset', credentialKey: 'AUTH' });
  return serverId;
}

describe('补槽位后：实例必须回收', { timeout: 20_000 }, () => {
  it('PATCH credentialSlots 新增 AUTH_PASS → 触发实例失效', async () => {
    const serverId = await makeHostWithAuthBinding('host-addslot');
    invalidated.clear();

    const r = await api('PATCH', `/api/v1/servers/${serverId}`, {
      credentialSlots: [
        { target: 'env', name: 'AUTH', label: 'SSH', file: true },
        { target: 'env', name: 'AUTH_PASS', label: '口令', file: false },
      ],
    });
    expect(r.status).toBe(200);

    const row = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
    const names = ((row!.credentialSlots ?? []) as Array<{ name: string }>).map((s) => s.name);
    expect(names).toEqual(['AUTH', 'AUTH_PASS']);
    // 关键断言：实例确实被回收（否则运行中的实例读不到新槽位）
    expect(invalidated.size).toBeGreaterThan(0);
  });

  it('不传 credentialSlots 的 PATCH 不触发回收', async () => {
    const serverId = await makeHostWithAuthBinding('host-nochange');
    invalidated.clear();
    const r = await api('PATCH', `/api/v1/servers/${serverId}`, { displayName: '仅改显示名' });
    expect(r.status).toBe(200);
    expect(invalidated.size).toBe(0);
  });

  it('新增槽位后可立即绑定并写入直填值（链路连通）', async () => {
    const serverId = await makeHostWithAuthBinding('host-bind-after-add');
    await api('PATCH', `/api/v1/servers/${serverId}`, {
      credentialSlots: [
        { target: 'env', name: 'AUTH', label: 'SSH', file: true },
        { target: 'env', name: 'AUTH_PASS', label: '口令', file: false },
      ],
    });
    // 槽位列表接口应立刻反映新槽位（前端刷新读的就是它）
    const list = await api('GET', `/api/v1/servers/${serverId}/slots`);
    const slotNames = (list.json.data as Array<{ slotName: string }>).map((s) => s.slotName);
    expect(slotNames).toContain('AUTH_PASS');

    // 直填值写入新槽位应成功（补槽位 → 可填值 的完整链路）
    const put = await app.inject({
      method: 'PUT', url: `/api/v1/servers/${serverId}/slots/AUTH_PASS/value`,
      payload: JSON.stringify({ value: 'some-passphrase' }),
      headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
    });
    expect(put.statusCode).toBe(200);
  });
});
