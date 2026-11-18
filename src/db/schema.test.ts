import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { guardRules, groups, servers, users } from './schema.js';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

const openDbs: Database.Database[] = [];

async function freshDb() {
  const s = new Database(':memory:');
  s.pragma('foreign_keys = ON');
  openDbs.push(s);
  const d = drizzle(s);
  await migrate(d, { migrationsFolder: MIGRATIONS });
  return d;
}

afterEach(() => {
  for (const s of openDbs.splice(0)) s.close();
});

describe('数据层（T2）', () => {
  it('迁移建齐 16 张表（14 静态 + 审计当月 + 预聚合）', async () => {
    const d = await freshDb();
    const rows = d.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        'api_keys',
        'audit_log_2026_10',
        'audit_stats_hourly',
        'credential_group_shares',
        'credentials',
        'group_metadata',
        'group_servers',
        'group_users',
        'groups',
        'guard_rules',
        'market_entries',
        'server_credentials',
        'server_slot_values',
        'servers',
        'system_settings',
        'users',
      ].sort(),
    );
  });

  it('AC-26 credentials 不含 visibility / shared_with_user_ids', async () => {
    const d = await freshDb();
    const cols = (d.$client.prepare('PRAGMA table_info(credentials)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('visibility');
    expect(cols).not.toContain('shared_with_user_ids');
  });

  it('AC-20 allow_private_network 默认 0（fail-closed）', async () => {
    const d = await freshDb();
    const userId = d
      .insert(users)
      .values({ username: 't2-probe' })
      .returning({ id: users.id })
      .get()!.id;
    const row = d
      .insert(servers)
      .values({
        name: 't2-probe-host',
        type: 'native',
        executionMode: 'native',
        category: 'host',
        ownerId: userId,
        configHash: 'probe',
      })
      .returning({ id: servers.id, allowPrivateNetwork: servers.allowPrivateNetwork })
      .get()!;
    expect(row.allowPrivateNetwork).toBe(false);
    const raw = d.$client
      .prepare('SELECT allow_private_network FROM servers WHERE id = ?')
      .get(row.id) as { allow_private_network: number };
    expect(raw.allow_private_network).toBe(0);
  });

  it('分组/规则表结构就绪且 locked/builtin 字段可写', async () => {
    const d = await freshDb();
    d.insert(groups).values({ id: 'grp-test', name: 'test-group', description: 'x' }).run();
    d.insert(guardRules)
      .values({
        id: 'gr-test',
        name: '测试规则',
        kind: 'block',
        target: 'arg',
        pattern: '^blocked$',
        enabled: true,
        locked: true,
        builtin: true,
        priority: 1,
        hitCount: 0,
      })
      .run();
    const got = d.select().from(guardRules).where(eq(guardRules.id, 'gr-test')).get();
    expect(got?.locked).toBe(true);
    expect(got?.builtin).toBe(true);
  });
});

describe('ADR-028 数据模型（T8）', () => {
  it('credentials.privileges 默认 []（文本 JSON）', async () => {
    const d = await freshDb();
    const cols = (d.$client.prepare('PRAGMA table_info(credentials)').all() as { name: string; dflt_value: string | null }[]);
    const p = cols.find((c) => c.name === 'privileges');
    expect(p).toBeTruthy();
    expect(p!.dflt_value).toBe("'[]'");
  });

  it('server_credentials 主键 = (server_id, slot_name, user_id, credential_id)，含 scope/label', async () => {
    const d = await freshDb();
    const info = d.$client.prepare('PRAGMA table_info(server_credentials)').all() as { name: string; pk: number }[];
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    // credential_id 进主键：同一人同槽位可同时持有 root(personal) 与 dev(asset)
    expect(pk).toEqual(['server_id', 'slot_name', 'user_id', 'credential_id']);
    const names = info.map((c) => c.name);
    expect(names).toContain('scope');
    expect(names).toContain('label');
  });

  it('同一槽位允许多个用户各绑一个凭证（一槽多凭证）', async () => {
    const d = await freshDb();
    const c = d.$client;
    const now = Date.now();
    for (const [id, u] of [['u1', 'alice'], ['u2', 'bob']] as const) {
      c.prepare('INSERT INTO users (id,username,is_admin,created_at,updated_at) VALUES (?,?,0,?,?)').run(id, u, now, now);
    }
    await d.insert(servers).values({ id: 's1', name: 's1', type: 'stdio', executionMode: 'mcp', category: 'other', ownerId: 'u1', configHash: 'ch', credentialSlots: [] }).run();
    for (const [id, owner] of [['c1', 'u1'], ['c2', 'u2']] as const) {
      c.prepare(
        'INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(id, `cred-${id}`, 'env-values', 'v1.x', '****1', owner, now, now);
    }
    c.prepare('INSERT INTO server_credentials (server_id,slot_name,user_id,credential_id,scope,created_at) VALUES (?,?,?,?,?,?)')
      .run('s1', 'AUTH', 'u1', 'c1', 'asset', now);
    c.prepare('INSERT INTO server_credentials (server_id,slot_name,user_id,credential_id,scope,created_at) VALUES (?,?,?,?,?,?)')
      .run('s1', 'AUTH', 'u2', 'c2', 'personal', now);

    const rows = c.prepare('SELECT user_id, credential_id, scope FROM server_credentials WHERE server_id=? AND slot_name=?').all('s1', 'AUTH') as { user_id: string; credential_id: string; scope: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.user_id}:${r.credential_id}:${r.scope}`).sort()).toEqual(['u1:c1:asset', 'u2:c2:personal']);
  });

  it('同一 (server, slot, user, credential) 重复绑定触发主键冲突；换凭证是追加一行', async () => {
    const d = await freshDb();
    const c = d.$client;
    const now = Date.now();
    c.prepare('INSERT INTO users (id,username,is_admin,created_at,updated_at) VALUES (?,?,0,?,?)').run('u1', 'alice', now, now);
    await d.insert(servers).values({ id: 's1', name: 's1', type: 'stdio', executionMode: 'mcp', category: 'other', ownerId: 'u1', configHash: 'ch', credentialSlots: [] }).run();
    for (const id of ['c1', 'c2']) {
      c.prepare('INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, `cred-${id}`, 'env-values', 'v1.x', '****1', 'u1', now, now);
    }
    const ins = c.prepare('INSERT INTO server_credentials (server_id,slot_name,user_id,credential_id,scope,created_at) VALUES (?,?,?,?,?,?)');
    ins.run('s1', 'AUTH', 'u1', 'c1', 'personal', now);
    // 同一条重复插入 → 主键冲突
    expect(() => ins.run('s1', 'AUTH', 'u1', 'c1', 'asset', now)).toThrow(/UNIQUE|PRIMARY/);
    // 同槽同人绑不同凭证 → 允许（root 自用 + dev 共享）
    ins.run('s1', 'AUTH', 'u1', 'c2', 'asset', now);
    const rows = c.prepare('SELECT credential_id, scope FROM server_credentials WHERE server_id=? AND slot_name=? AND user_id=?').all('s1', 'AUTH', 'u1') as { credential_id: string; scope: string }[];
    expect(rows.map((r) => `${r.credential_id}:${r.scope}`).sort()).toEqual(['c1:personal', 'c2:asset']);
  });

  it('credential_group_shares 联合主键去重（同一凭证同一分组只一行）', async () => {
    const d = await freshDb();
    const c = d.$client;
    const now = Date.now();
    c.prepare('INSERT INTO users (id,username,is_admin,created_at,updated_at) VALUES (?,?,0,?,?)').run('u1', 'alice', now, now);
    c.prepare('INSERT INTO groups (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('g1', 'grp-1', now, now);
    c.prepare('INSERT INTO credentials (id,name,kind,encrypted_values,value_hint,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('c1', 'cred-c1', 'env-values', 'v1.x', '****1', 'u1', now, now);
    const ins = c.prepare('INSERT INTO credential_group_shares (credential_id,group_id,created_at) VALUES (?,?,?)');
    ins.run('c1', 'g1', now);
    expect(() => ins.run('c1', 'g1', now)).toThrow(/UNIQUE|PRIMARY/);
  });
});
