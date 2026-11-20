/**
 * 同一槽位多账号且**权限等级相同**时的确定性择优（2026-11-19 迁移暴露）。
 *
 * 背景：v1 迁移后大量资产一个槽位绑了 2~3 个同为 admin 级的账号
 * （如 tke-nacosdb-mysql-16.79 的 root 与 nacos 账号都是 admin）。
 * 旧实现只按 privileges 排序取第一条，同分时**结果取决于 SQLite 行序** ——
 * 同一份数据在不同机器上可能取到不同账号，属隐式不确定（AGENTS.md §2 原则 8）。
 *
 * 规则（用户 2026-11-19 决策）：同分时优先取**管理类账号**（凭证名/绑定用户名含
 * root / admin / superuser），仍同分则按 credentialId 稳定排序，保证可复现。
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
const OWNER = 'u-tie-owner';
const ASSET = 'srv-tie';

let sqlite: Database.Database;
let credentials: CredentialService;
let key: Buffer;

function insertCred(id: string, name: string, values: Record<string, string>, privileges: string): void {
  sqlite
    .prepare(
      'INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,privileges,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(id, name, 'user_password', encryptCredential(key, id, JSON.stringify(values)), '****', OWNER, privileges, Date.now(), Date.now());
}

function bind(slot: string, credId: string, username: string | null): void {
  sqlite
    .prepare(
      'INSERT INTO server_credentials (server_id,slot_name,user_id,credential_id,scope,username,created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(ASSET, slot, OWNER, credId, 'personal', username, Date.now());
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opsgate-tie-'));
  sqlite = new Database(path.join(dir, 'test.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS });

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
      ASSET, 'srv-tie', 'native', 'native', 'mysql', null,
      '[]',
      JSON.stringify([{ target: 'env', name: 'password', label: '密码', file: false }]),
      OWNER, 'cfg', '[]', Date.now(), Date.now(),
    );

  // 两条同为 root 级（privileges=["root"]），业务账号先插入 → 旧实现会先取到它
  insertCred('c-biz', 'office-mysql-3-66-nacos', { username: 'nacos', password: 'biz-pw' }, '["root"]');
  insertCred('c-root', 'tke-mysql-root-16-79', { username: 'root', password: 'root-pw' }, '["root"]');
  bind('password', 'c-biz', 'nacos');
  bind('password', 'c-root', 'root');
});

afterAll(() => sqlite?.close());

describe('同权限等级时的确定性择优', () => {
  it('同分时取管理类账号（root），不依赖插入顺序', () => {
    const r = credentials.resolveSlotValues(ASSET, ['password'], OWNER);
    expect(r).toHaveLength(1);
    expect(r[0]!.value).toBe('root-pw');
    expect(r[0]!.credentialId).toBe('c-root');
  });

  it('slotCredentialKey 走同一口径', () => {
    const r = credentials.slotCredentialKey(ASSET, 'password', 'password', OWNER);
    expect(r?.value).toBe('root-pw');
  });

  it('结果不随查询返回顺序变化（重复调用一致）', () => {
    const a = credentials.resolveSlotValues(ASSET, ['password'], OWNER)[0]!.credentialId;
    const b = credentials.resolveSlotValues(ASSET, ['password'], OWNER)[0]!.credentialId;
    expect(a).toBe(b);
  });
});
