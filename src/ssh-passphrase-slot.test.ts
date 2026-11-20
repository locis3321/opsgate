/**
 * SSH 私钥口令槽位（authPassSlot）解析 + 认证参数装配。
 *
 * 锁定两个真实缺陷（2026-11-18 用户报 tke-host-16.251 连通性测试失败）：
 *  1. 资产声明 authPassSlot=AUTH_PASS 且该槽位绑定 ssh_key 凭证时，
 *     resolveSlotValues 按槽位名找键（AUTH_PASS → 归一化 pass），而凭证键是 passphrase
 *     → 抛「缺少槽位键 "AUTH_PASS"（fail-closed）」，口令根本到不了 ssh2。
 *  2. 主机指纹采集端点自己拼 ssh2 连接参数，漏传 passphrase
 *     → 加密私钥报「Encrypted private OpenSSH key detected, but no passphrase given」。
 *
 * 两条路径必须共用同一份认证参数装配，否则还会再漂移。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from './db/schema.js';
import { encryptCredential, loadCredentialKey } from './services/crypto.js';
import { CredentialService } from './services/credentials.js';
import { resolveSshCredential } from './services/sshCredential.js';
import { sshAuthParams } from './native/connectors/ssh.js';
import type { AssetView } from './framework/types.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));

const OWNER = 'u-pass-owner';
const ASSET_ID = 'srv-pass';
const CRED = 'cred-pass';
const PASSPHRASE = 'pphrase-from-credential';
const KEY_HEAD = '-----BEGIN OPENSSH PRIVATE KEY-----';

let sqlite: Database.Database;
let credentials: CredentialService;
let TEST_KEY: Buffer;

function assetView(): AssetView {
  return {
    id: ASSET_ID,
    name: 'tke-host',
    category: 'host',
    ownerId: OWNER,
    executionMode: 'native',
    hostConn: {
      host: '127.0.0.1',
      port: 22322,
      username: 'asset-user',
      authSlot: 'AUTH',
      authPassSlot: 'AUTH_PASS',
    },
    credentialSlots: [
      { target: 'env', name: 'AUTH', label: 'SSH 私钥', file: true },
      { target: 'env', name: 'AUTH_PASS', label: '私钥口令（可选）', file: false },
    ],
    configHash: 'cfg',
  };
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opsgate-ssh-pass-'));
  sqlite = new Database(path.join(dir, 'test.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });

  const key = loadCredentialKey(path.join(dir, 'credentials.key'));
  TEST_KEY = key;
  credentials = new CredentialService(sqlite, key);

  sqlite
    .prepare(
      'INSERT INTO users (id,username,name,is_admin,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(OWNER, OWNER, OWNER, 0, Date.now(), Date.now());
  sqlite
    .prepare(
      'INSERT INTO servers (id,name,type,execution_mode,category,host_conn,tags,credential_slots,owner_id,config_hash,shared_with_user_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      ASSET_ID, 'tke-host', 'native', 'native', 'host',
      JSON.stringify({
        host: '127.0.0.1', port: 22322, username: 'asset-user',
        authSlot: 'AUTH', authPassSlot: 'AUTH_PASS',
      }),
      '[]',
      JSON.stringify([
        { target: 'env', name: 'AUTH', label: 'SSH 私钥', file: true },
        { target: 'env', name: 'AUTH_PASS', label: '私钥口令（可选）', file: false },
      ]),
      OWNER, 'cfg', '[]', Date.now(), Date.now(),
    );

  // ssh_key 凭证：键名是 AUTH / username / passphrase（与 CREDENTIAL_TYPES 一致）
  sqlite
    .prepare(
      'INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,privileges,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      CRED, CRED, 'ssh_key',
      encryptCredential(key, CRED, JSON.stringify({
        AUTH: `${KEY_HEAD}\nOWNER\n-----END OPENSSH PRIVATE KEY-----`,
        username: 'superuser',
        passphrase: PASSPHRASE,
      })),
      '****', OWNER, '[]', Date.now(), Date.now(),
    );

  // 两个槽位都绑定同一条凭证——这是前端创建 SSH 私钥资产时的实际写法
  const bind = sqlite.prepare(
    'INSERT INTO server_credentials (server_id,slot_name,user_id,credential_id,scope,created_at) VALUES (?,?,?,?,?,?)',
  );
  bind.run(ASSET_ID, 'AUTH', OWNER, CRED, 'asset', Date.now());
  bind.run(ASSET_ID, 'AUTH_PASS', OWNER, CRED, 'asset', Date.now());
});

afterAll(() => {
  sqlite?.close();
});

describe('SSH 口令槽位解析', () => {
  // ADR-031：口令槽位与其他槽位同口径——绑定上指定 credential_key 才精确取值。
  // 本组把 AUTH_PASS 的绑定改为显式指定 passphrase（这是用户在界面上应做的动作）。
  beforeAll(() => {
    sqlite
      .prepare("UPDATE server_credentials SET credential_key = 'passphrase' WHERE slot_name = 'AUTH_PASS'")
      .run();
  });

  it('authPassSlot 绑定的 ssh_key 凭证里取到 passphrase，不报"缺少槽位键"', () => {
    const cred = resolveSshCredential(credentials, assetView(), OWNER);
    expect(cred.credentialId).toBe(CRED);
    expect(cred.privateKey).toContain('PRIVATE KEY');
    expect(cred.passphrase).toBe(PASSPHRASE);
  });

  it('系统级路径（无调用者）同样取到口令', () => {
    const cred = resolveSshCredential(credentials, assetView());
    expect(cred.passphrase).toBe(PASSPHRASE);
  });

  it('未指定 credential_key 时按 ADR-031 报错，提示在绑定上指定键名', () => {
    sqlite
      .prepare("UPDATE server_credentials SET credential_key = NULL WHERE slot_name = 'AUTH_PASS'")
      .run();
    expect(() => resolveSshCredential(credentials, assetView(), OWNER)).toThrow(/请在绑定上指定键名/);
    sqlite
      .prepare("UPDATE server_credentials SET credential_key = 'passphrase' WHERE slot_name = 'AUTH_PASS'")
      .run();
  });
});

/**
 * 真实用户场景（2026-11-20 用户报告 tke-elk-kibana-01-16-227-host-16-227）：
 * 凭证键名就是 AUTH_PASS（不是 'passphrase'），绑定上 credential_key 也写成 AUTH_PASS。
 * 此时按槽位名精确命中即应取到口令。
 *
 * 信任指纹端点此前用 slotCredentialKey(id, slot, 'passphrase') 硬编码键名，
 * 在这组数据下取不到值，于是"连通测试通过、信任指纹报 no passphrase"。
 */
describe('凭证键名就是 AUTH_PASS 时（未经改名）', () => {
  beforeEach(() => {
    // 换成真实用户的凭证形态：键名就是 AUTH_PASS，不叫 passphrase
    sqlite
      .prepare('UPDATE credentials SET encrypted_values = ? WHERE id = ?')
      .run(
        encryptCredential(TEST_KEY, CRED, JSON.stringify({
          AUTH: `${KEY_HEAD}\nOWNER\n-----END OPENSSH PRIVATE KEY-----`,
          username: 'superuser',
          AUTH_PASS: PASSPHRASE,
        })),
        CRED,
      );
    sqlite.prepare("UPDATE server_credentials SET credential_key = 'AUTH_PASS' WHERE slot_name = 'AUTH_PASS'").run();
  });

  it('resolveSshCredential 取到口令', () => {
    const cred = resolveSshCredential(credentials, assetView(), OWNER);
    expect(cred.passphrase).toBe(PASSPHRASE);
  });

  it('slotCredentialKey 用硬编码 passphrase 取不到（旧实现的缺陷点）', () => {
    expect(credentials.slotCredentialKey(ASSET_ID, 'AUTH_PASS', 'passphrase', OWNER)).toBeNull();
    // 正确口径：按绑定指定的键名取
    expect(credentials.slotCredentialKey(ASSET_ID, 'AUTH_PASS', 'AUTH_PASS', OWNER)?.value).toBe(PASSPHRASE);
  });
});

describe('ssh2 认证参数装配（连接器与指纹采集共用）', () => {
  it('私钥 + 口令：两个字段都进连接参数', () => {
    const p = sshAuthParams(
      { host: '10.0.0.1', port: 22322, username: 'asset-user' },
      { value: `${KEY_HEAD}\nX\n-----END OPENSSH PRIVATE KEY-----`, username: 'superuser' },
      PASSPHRASE,
    );
    expect(p).toMatchObject({ host: '10.0.0.1', port: 22322, username: 'superuser' });
    expect(p.privateKey).toContain('PRIVATE KEY');
    expect(p.password).toBeUndefined();
    expect(p.passphrase).toBe(PASSPHRASE);
  });

  it('口令缺省时不传 passphrase（未加密的私钥不该带空口令）', () => {
    const p = sshAuthParams(
      { host: 'h', username: 'u' },
      { value: `${KEY_HEAD}\nX\n-----END OPENSSH PRIVATE KEY-----` },
      undefined,
    );
    expect('passphrase' in p).toBe(false);
    expect(p.port).toBe(22);
  });

  it('密码认证不带 privateKey；凭证用户名优先于资产用户名', () => {
    const p = sshAuthParams(
      { host: 'h', port: 22, username: 'asset-user' },
      { value: 'secret-pw', username: 'from-cred' },
      undefined,
    );
    expect(p.password).toBe('secret-pw');
    expect(p.privateKey).toBeUndefined();
    expect(p.username).toBe('from-cred');
  });
});
