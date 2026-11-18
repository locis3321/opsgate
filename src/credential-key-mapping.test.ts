/**
 * 槽位绑定显式指定凭证键（ADR-031）。
 *
 * 锁定取值口径：**精确匹配，不再猜**。
 *  - credential_key 有值 → 精确取该键；键不存在 → fail-closed
 *  - credential_key 为 NULL → 只接受「键名完全一致」或「归一化后一致」
 *  - 删除的两级：「凭证只有 1 个键就用它」「唯一敏感别名（password/token/secret…）」
 *
 * 起因：AUTH_PASS 归一化得 `pass`，ssh_key 凭证的键是 `passphrase`，
 * 旧的四级猜测全不中 → 连通性测试报「缺少槽位键 "AUTH_PASS"」。
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
import { encryptCredential, loadCredentialKey } from './services/crypto.js';
import { CredentialService } from './services/credentials.js';

const MIGRATIONS = fileURLToPath(new URL('./db/migrations', import.meta.url));

const OWNER = 'u-ck-owner';
const ASSET = 'srv-ck';

let sqlite: Database.Database;
let credentials: CredentialService;
let key: Buffer;

function insertCred(id: string, kind: string, values: Record<string, string>): void {
  sqlite
    .prepare(
      'INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,privileges,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(id, id, kind, encryptCredential(key, id, JSON.stringify(values)), '****', OWNER, '[]', Date.now(), Date.now());
}

function bind(slot: string, credId: string, credentialKey: string | null): void {
  sqlite
    .prepare(
      'INSERT INTO server_credentials (server_id,slot_name,user_id,credential_id,scope,credential_key,created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(ASSET, slot, OWNER, credId, 'asset', credentialKey, Date.now());
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opsgate-cred-key-'));
  sqlite = new Database(path.join(dir, 'test.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });

  key = loadCredentialKey(path.join(dir, 'credentials.key'));
  credentials = new CredentialService(sqlite, key);

  sqlite
    .prepare('INSERT INTO users (id,username,name,is_admin,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(OWNER, OWNER, OWNER, 0, Date.now(), Date.now());
  sqlite
    .prepare(
      'INSERT INTO servers (id,name,type,execution_mode,category,host_conn,tags,credential_slots,owner_id,config_hash,shared_with_user_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      ASSET, 'srv', 'native', 'native', 'host', JSON.stringify({ host: 'h', port: 22, username: 'u' }),
      '[]',
      JSON.stringify([
        { target: 'env', name: 'AUTH_PASS', label: '口令', file: false },
        { target: 'env', name: 'RABBITMQ_PASSWORD', label: '密码', file: false },
        { target: 'env', name: 'REDIS_PWD', label: '密码', file: false },
        { target: 'env', name: 'ONLY_ONE', label: '单键', file: false },
        { target: 'env', name: 'AUTH', label: '认证', file: false },
      ]),
      OWNER, 'cfg', '[]', Date.now(), Date.now(),
    );
});

afterAll(() => {
  sqlite?.close();
});

describe('credential_key 有值时精确取值', () => {
  beforeAll(() => {
    insertCred('c-pass', 'ssh_key', { AUTH: 'KEY', username: 'u', passphrase: 'pp' });
    bind('AUTH_PASS', 'c-pass', 'passphrase');
  });

  it('取到指定键的值', () => {
    const r = credentials.resolveSlotValues(ASSET, ['AUTH_PASS'], OWNER);
    expect(r).toHaveLength(1);
    expect(r[0]!.value).toBe('pp');
  });
});

describe('credential_key 指定的键不存在', () => {
  beforeAll(() => {
    bind('ONLY_ONE', 'c-pass', 'no_such_key');
  });

  it('fail-closed 报错，点名缺失的键', () => {
    expect(() => credentials.resolveSlotValues(ASSET, ['ONLY_ONE'], OWNER)).toThrow(/no_such_key/);
  });
});

describe('credential_key 为 NULL：只做同名/归一化匹配', () => {
  beforeAll(() => {
    insertCred('c-rabbit', 'user_password', { username: 'x', password: 'rabbit-pw' });
    insertCred('c-redis', 'redis_password', { REDIS_PASSWORD: 'redis-pw' });
    insertCred('c-single', 'env-values', { whatever: 'single-value' });
    bind('RABBITMQ_PASSWORD', 'c-rabbit', null);
    bind('REDIS_PWD', 'c-redis', null);
    bind('ONLY_ONE', 'c-single', null);
    bind('AUTH', 'c-rabbit', null);
  });

  it('归一化命中：RABBITMQ_PASSWORD ← password', () => {
    const r = credentials.resolveSlotValues(ASSET, ['RABBITMQ_PASSWORD'], OWNER);
    expect(r[0]!.value).toBe('rabbit-pw');
  });

  it('REDIS_PWD ← REDIS_PASSWORD 不再命中（pwd ≠ password），需显式指定', () => {
    expect(() => credentials.resolveSlotValues(ASSET, ['REDIS_PWD'], OWNER)).toThrow(/REDIS_PWD/);
  });

  it('单键凭证不再兜底：ONLY_ONE ← whatever 报错', () => {
    expect(() => credentials.resolveSlotValues(ASSET, ['ONLY_ONE'], OWNER)).toThrow(/ONLY_ONE/);
  });

  it('敏感别名不再兜底：AUTH ← password 报错', () => {
    expect(() => credentials.resolveSlotValues(ASSET, ['AUTH'], OWNER)).toThrow(/AUTH/);
  });
});

describe('未绑定的槽位仍不报错', () => {
  it('槽位没有绑定 → 不进返回值，不抛错（口径不变）', () => {
    const r = credentials.resolveSlotValues(ASSET, ['NEVER_BOUND'], OWNER);
    expect(r).toEqual([]);
  });
});
