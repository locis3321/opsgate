/**
 * SSH 凭证按调用者解析（2026-11-17 用户反馈：成员绑了自己的凭证，实际连的却是归属人的账号）。
 *
 * 锁定三件事：
 *  1. 成员自绑的 personal 凭证优先于归属人的 asset 凭证；归属人自己仍用自己的
 *  2. 连接池按「资产 + 凭证指纹」隔离：两个成员用不同凭证 → 两条独立连接条目，绝不串用
 *  3. 凭证里的 username 随凭证走（ssh_key 现在也能填用户名），未填则回落资产上的
 *
 * 走真实链路（SshConnector.acquire → resolveSshCredential → resolveSlotValues），
 * 只把最后一步网络握手省掉（acquire 后立即 release）——验证的是凭证选择，不是 ssh2。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from './db/schema.js';
import { Settings } from './config/settings.js';
import { loadCredentialKey, encryptCredential } from './services/crypto.js';
import { CredentialService } from './services/credentials.js';
import { SshConnector, type SshCredential } from './native/connectors/ssh.js';
import { resolveSshCredential } from './services/sshCredential.js';
import type { AssetView } from './framework/types.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));

const OWNER = 'u-owner';
const MEMBER = 'u-member';
const ASSET_ID = 'srv-ssh';
const OWNER_CRED = 'cred-owner';
const MEMBER_CRED = 'cred-member';
const KEY_HEAD = '-----BEGIN OPENSSH PRIVATE KEY-----';

let sqlite: Database.Database;
let key: Buffer;
let credentials: CredentialService;
let ssh: SshConnector;
/** 每次 acquire 实际用到的凭证（按调用顺序） */
const acquired: SshCredential[] = [];

function assetView(): AssetView {
  return {
    id: ASSET_ID,
    name: 'shared-host',
    category: 'host',
    ownerId: OWNER,
    executionMode: 'native',
    hostConn: { host: '127.0.0.1', port: 2222, username: 'asset-user', authSlot: 'AUTH' },
    credentialSlots: [{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }],
    configHash: 'cfg',
  };
}

function insertCredential(id: string, userId: string, values: Record<string, string>): void {
  sqlite
    .prepare(
      'INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,privileges,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(id, id, 'ssh_key', encryptCredential(key, id, JSON.stringify(values)), '****', userId, '[]', Date.now(), Date.now());
}

function bind(id: string, userId: string, scope: 'asset' | 'personal'): void {
  sqlite
    .prepare('INSERT INTO server_credentials (server_id,slot_name,user_id,credential_id,scope,created_at) VALUES (?,?,?,?,?,?)')
    .run(ASSET_ID, 'AUTH', userId, id, scope, Date.now());
}

function insertUser(id: string): void {
  sqlite
    .prepare('INSERT INTO users (id,username,name,is_admin,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, id, id, 0, Date.now(), Date.now());
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opsgate-ssh-cred-'));
  sqlite = new Database(path.join(dir, 'test.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });

  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  key = loadCredentialKey(path.join(dir, 'credentials.key'));
  credentials = new CredentialService(sqlite, key);

  insertUser(OWNER);
  insertUser(MEMBER);

  sqlite
    .prepare(
      'INSERT INTO servers (id,name,type,execution_mode,category,host_conn,tags,credential_slots,owner_id,config_hash,shared_with_user_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      ASSET_ID, 'shared-host', 'native', 'native', 'host',
      JSON.stringify({ host: '127.0.0.1', port: 2222, username: 'asset-user', authSlot: 'AUTH' }),
      '[]',
      JSON.stringify([{ target: 'env', name: 'AUTH', label: 'AUTH', file: false }]),
      OWNER, 'cfg', '[]', Date.now(), Date.now(),
    );

  // 归属人：root 私钥共享给资产；成员：自己的私钥 + 自己的用户名（personal）
  insertCredential(OWNER_CRED, OWNER, { AUTH: `${KEY_HEAD}\nOWNER\n-----END OPENSSH PRIVATE KEY-----`, username: 'root' });
  insertCredential(MEMBER_CRED, MEMBER, { AUTH: `${KEY_HEAD}\nMEMBER\n-----END OPENSSH PRIVATE KEY-----`, username: 'deploy' });
  bind(OWNER_CRED, OWNER, 'asset');
  bind(MEMBER_CRED, MEMBER, 'personal');

  ssh = new SshConnector({
    idleTtlMs: 60_000,
    semaphore: 4,
    queueTimeoutMs: 5_000,
    truncateBytes: 4096,
    resolveCredential: (asset, userId) => {
      const cred = resolveSshCredential(credentials, asset, userId);
      acquired.push(cred);
      return Promise.resolve(cred);
    },
    expectFingerprint: () => null,
  });
  // acquire 后立即 release：不建立 TCP/SSH 连接，只观察凭证选择与池条目
  const realAcquire = ssh.acquire.bind(ssh);
  ssh.acquire = async (asset, ref, principal) => {
    const h = await realAcquire(asset, ref, principal);
    ssh.release(h);
    return h;
  };
});

afterAll(() => {
  sqlite?.close();
});

describe('SSH 凭证按调用者解析', () => {
  it('成员用自己绑的 personal 凭证与自己的用户名', async () => {
    acquired.length = 0;
    await ssh.acquire(assetView(), 'AUTH', { userId: MEMBER, isAdmin: false });
    expect(acquired).toHaveLength(1);
    expect(acquired[0]!.credentialId).toBe(MEMBER_CRED);
    expect(acquired[0]!.username).toBe('deploy');
    expect(acquired[0]!.privateKey).toContain('MEMBER');
  });

  it('归属人仍然用自己绑的凭证（不被成员的 personal 覆盖）', async () => {
    acquired.length = 0;
    await ssh.acquire(assetView(), 'AUTH', { userId: OWNER, isAdmin: false });
    expect(acquired[0]!.credentialId).toBe(OWNER_CRED);
    expect(acquired[0]!.username).toBe('root');
  });

  it('系统级路径（无调用者）只看到共享凭证', () => {
    const cred = resolveSshCredential(credentials, assetView());
    expect(cred.credentialId).toBe(OWNER_CRED);
  });

  it('不同调用者的连接池条目互相独立（按凭证指纹分条）', async () => {
    await ssh.acquire(assetView(), 'AUTH', { userId: MEMBER, isAdmin: false });
    await ssh.acquire(assetView(), 'AUTH', { userId: OWNER, isAdmin: false });
    // 两套凭证 → 两条条目；若键里丢了凭证指纹，这里只会剩 1 条（成员会复用到归属人的连接）
    expect(ssh.stats().total).toBe(2);
    // 同一人重复调用复用自己那条，不再新增
    await ssh.acquire(assetView(), 'AUTH', { userId: MEMBER, isAdmin: false });
    expect(ssh.stats().total).toBe(2);
  });

  it('凭证未带 username → 回落到资产上的用户名', () => {
    insertUser('u-nouser');
    insertCredential('cred-no-user', 'u-nouser', { AUTH: `${KEY_HEAD}\nNOUSER\n-----END OPENSSH PRIVATE KEY-----` });
    bind('cred-no-user', 'u-nouser', 'personal');
    const cred = resolveSshCredential(credentials, assetView(), 'u-nouser');
    expect(cred.credentialId).toBe('cred-no-user');
    expect(cred.username).toBeUndefined();
  });

  it('同一人同槽位的两条 personal → 按 privileges 取权限最高的', () => {
    insertUser('u-two');
    sqlite
      .prepare('INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,privileges,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('cred-two-ro', 'cred-two-ro', 'ssh_key', encryptCredential(key, 'cred-two-ro', JSON.stringify({ AUTH: `${KEY_HEAD}\nRO\n-----END OPENSSH PRIVATE KEY-----`, username: 'ro' })), '****', 'u-two', '["ro"]', Date.now(), Date.now());
    sqlite
      .prepare('INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,privileges,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('cred-two-root', 'cred-two-root', 'ssh_key', encryptCredential(key, 'cred-two-root', JSON.stringify({ AUTH: `${KEY_HEAD}\nROOT\n-----END OPENSSH PRIVATE KEY-----`, username: 'root2' })), '****', 'u-two', '["root"]', Date.now(), Date.now());
    bind('cred-two-ro', 'u-two', 'personal');
    bind('cred-two-root', 'u-two', 'personal');
    const cred = resolveSshCredential(credentials, assetView(), 'u-two');
    expect(cred.credentialId).toBe('cred-two-root');
    expect(cred.username).toBe('root2');
  });

  it('绑定级用户名优先于凭证自带的 username', () => {
    insertUser('u-binduser');
    insertCredential('cred-binduser', 'u-binduser', { AUTH: `${KEY_HEAD}\nBU\n-----END OPENSSH PRIVATE KEY-----`, username: 'from-cred' });
    sqlite
      .prepare('INSERT INTO server_credentials (server_id,slot_name,user_id,credential_id,scope,username,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(ASSET_ID, 'AUTH', 'u-binduser', 'cred-binduser', 'personal', 'from-binding', Date.now());
    const cred = resolveSshCredential(credentials, assetView(), 'u-binduser');
    expect(cred.credentialId).toBe('cred-binduser');
    expect(cred.username).toBe('from-binding');
  });

  it('绑定未填用户名 → 回落到该凭证的 username 键（不串到同槽其它绑定的账号）', () => {
    // u-owner 的 asset 绑定凭证带 username 'root'，绑定行未设 username
    const cred = resolveSshCredential(credentials, assetView(), OWNER);
    expect(cred.credentialId).toBe(OWNER_CRED);
    expect(cred.username).toBe('root');
  });

  it('改绑定用户名 → 连接池换新条目（不会复用旧账号建立的连接）', async () => {
    insertUser('u-rename');
    insertCredential('cred-rename', 'u-rename', { AUTH: `${KEY_HEAD}\nRN\n-----END OPENSSH PRIVATE KEY-----` });
    bind('cred-rename', 'u-rename', 'personal');
    await ssh.acquire(assetView(), 'AUTH', { userId: 'u-rename', isAdmin: false }); // 无用户名
    const before = ssh.stats().total;
    sqlite
      .prepare('UPDATE server_credentials SET username = ? WHERE server_id = ? AND slot_name = ? AND user_id = ? AND credential_id = ?')
      .run('newuser', ASSET_ID, 'AUTH', 'u-rename', 'cred-rename');
    await ssh.acquire(assetView(), 'AUTH', { userId: 'u-rename', isAdmin: false });
    expect(ssh.stats().total).toBe(before + 1);
  });
});
