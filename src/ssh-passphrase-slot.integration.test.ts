/**
 * 回归测试：SSH 私钥口令槽位（authPassSlot）的补写与解析。
 *
 * 缺陷背景（2026-11-20 用户报告）：
 *   加密 OpenSSH 私钥的资产，在详情页手动补了 AUTH_PASS 槽位并绑定了口令，
 *   信任指纹/连通测试仍报 "Encrypted private OpenSSH key detected, but no passphrase given"。
 *
 * 根因：`hostConn.authPassSlot` 只在创建弹窗写入（AssetCreateModal），
 * PATCH /servers/:id 不接受 hostConn —— 创建后无法补写，resolveSshCredential 永远取不到口令。
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
import { resolveSshCredential } from './services/sshCredential.js';
import { createAuth, ensureAuthTables, createUserWithPassword } from './services/auth.js';
import { buildApp } from './app.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));
const BASE_URL = 'http://127.0.0.1:8080';

let app: FastifyInstance;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let credentials: CredentialService;
let cookie: string;
let aliceId: string;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const cryptoKey = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'pass-slot-k-')), 'k'));
  const audit = new AuditService(sqlite, settings);
  credentials = new CredentialService(sqlite, cryptoKey);
  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  await createUserWithPassword(auth, { username: 'alice', password: 'password-12345', isAdmin: false });
  app = await buildApp({ db, auth, baseUrl: BASE_URL, audit, settings, cryptoKey, sqlite, credentials });
  aliceId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'alice')).get())!.id;

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

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method, url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { cookie, origin: BASE_URL, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: res.statusCode, json: res.json() as Json };
}

/** 造一台"加密私钥 + 口令"的原生主机：AUTH 绑私钥，AUTH_PASS 绑口令 */
async function makeEncryptedKeyHost(id: string): Promise<{ serverId: string; credId: string }> {
  const cred = await api('POST', '/api/v1/credentials', {
    name: `ssh-${id}`,
    kind: 'ssh_key',
    values: {
      AUTH: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----',
      AUTH_PASS: 'my-passphrase',
      username: 'superuser',
    },
  });
  if (cred.status !== 200) throw new Error(`create cred failed: ${cred.json.message}`);
  const credId = (cred.json.data as { id: string }).id;

  const srv = await api('POST', '/api/v1/servers', {
    name: id, type: 'native', executionMode: 'native', category: 'host',
    hostConn: { host: '10.0.0.9', port: 22322, username: 'superuser', authSlot: 'AUTH' },
    credentialSlots: [
      { target: 'env', name: 'AUTH', label: 'SSH 凭证', file: true },
      { target: 'env', name: 'AUTH_PASS', label: '口令', file: false },
    ],
  });
  if (srv.status !== 200) throw new Error(`create server failed: ${srv.json.message}`);
  const serverId = (srv.json.data as { id: string }).id;

  for (const [slot, key] of [['AUTH', 'AUTH'], ['AUTH_PASS', 'AUTH_PASS']] as const) {
    const b = await api('POST', `/api/v1/servers/${serverId}/slots`, {
      slotName: slot, credentialId: credId, scope: 'asset', credentialKey: key,
    });
    if (b.status !== 200) throw new Error(`bind ${slot} failed: ${b.json.message}`);
  }
  return { serverId, credId };
}

describe('authPassSlot：创建后可补写，且解析能取到口令', { timeout: 30_000 }, () => {
  it('创建时未设 authPassSlot → PATCH 补写后 resolveSshCredential 带出 passphrase', async () => {
    const { serverId } = await makeEncryptedKeyHost('host-enc-1');

    // 补写前：hostConn 无 authPassSlot → 解析出来的 passphrase 应为空（这正是用户遇到的故障）
    const viewBefore = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
    const before = resolveSshCredential(credentials, viewBefore as never, aliceId);
    expect(before.passphrase).toBeUndefined();

    // PATCH 补写 authPassSlot（本次修复新增的能力）
    const patch = await api('PATCH', `/api/v1/servers/${serverId}`, {
      hostConn: { authPassSlot: 'AUTH_PASS' },
    });
    expect(patch.status).toBe(200);

    const viewAfter = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
    const hc = viewAfter!.hostConn as Record<string, unknown>;
    expect(hc.authPassSlot).toBe('AUTH_PASS');
    // 其余字段必须原样保留（合并语义，不是整体替换）
    expect(hc.host).toBe('10.0.0.9');
    expect(hc.port).toBe(22322);
    expect(hc.username).toBe('superuser');
    expect(hc.authSlot).toBe('AUTH');

    const after = resolveSshCredential(credentials, viewAfter as never, aliceId);
    expect(after.passphrase).toBe('my-passphrase');
    expect(after.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(after.username).toBe('superuser');
  });

  it('清空 authPassSlot（传 null）→ 解析回到没有口令', async () => {
    const { serverId } = await makeEncryptedKeyHost('host-enc-2');
    await api('PATCH', `/api/v1/servers/${serverId}`, { hostConn: { authPassSlot: 'AUTH_PASS' } });
    const clear = await api('PATCH', `/api/v1/servers/${serverId}`, { hostConn: { authPassSlot: null } });
    expect(clear.status).toBe(200);
    const row = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
    expect((row!.hostConn as Record<string, unknown>).authPassSlot).toBeUndefined();
    expect(resolveSshCredential(credentials, row as never, aliceId).passphrase).toBeUndefined();
  });

  it('PATCH hostConn 是受限白名单：host/port/username 等连接参数不可经此修改', async () => {
    const { serverId } = await makeEncryptedKeyHost('host-enc-3');
    // 只允许改 authPassSlot；其它字段即使传了也不生效（防止绕过创建期的校验与审计）
    const r = await api('PATCH', `/api/v1/servers/${serverId}`, {
      hostConn: { authPassSlot: 'AUTH_PASS', host: '1.2.3.4', port: 22, username: 'root' },
    });
    expect(r.status).toBe(200);
    const row = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
    const hc = row!.hostConn as Record<string, unknown>;
    expect(hc.authPassSlot).toBe('AUTH_PASS');
    expect(hc.host).toBe('10.0.0.9');
    expect(hc.port).toBe(22322);
    expect(hc.username).toBe('superuser');
  });

  it('非 native host 资产 → 400（口令槽位只对 SSH 主机有意义）', async () => {
    const srv = await api('POST', '/api/v1/servers', {
      name: 'srv-mcp-1', type: 'stdio', executionMode: 'mcp', category: 'other',
      command: 'node', args: ['-e', ''],
    });
    const id = (srv.json.data as { id: string }).id;
    const r = await api('PATCH', `/api/v1/servers/${id}`, { hostConn: { authPassSlot: 'AUTH_PASS' } });
    expect(r.status).toBe(400);
  });

  it('非归属人 → 403', async () => {
    const { serverId } = await makeEncryptedKeyHost('host-enc-4');
    const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
    await createUserWithPassword(auth, { username: 'bob', password: 'password-12345', isAdmin: false });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in/username',
      payload: { username: 'bob', password: 'password-12345' },
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
    });
    const c = res.headers['set-cookie'];
    const bob = (Array.isArray(c) ? c : [c])[0]!.split(';')[0]!;
    const r = await app.inject({
      method: 'PATCH', url: `/api/v1/servers/${serverId}`,
      payload: JSON.stringify({ hostConn: { authPassSlot: 'AUTH_PASS' } }),
      headers: { cookie: bob, origin: BASE_URL, 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
  });
});
