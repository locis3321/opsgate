import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { syncBuiltinGuardRules } from './guardRulesSeedSync.js';
import type { BuiltinGuardRule } from './builtinGuardRules.js';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

async function setup() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const marker = path.join(mkdtempSync(path.join(tmpdir(), 'grm-')), '.seeded');
  return { sqlite, db, marker };
}

const R = (id: string): BuiltinGuardRule => ({
  id, name: id, kind: 'mark', target: 'arg', pattern: 'x', priority: 100, description: 'd',
});

function count(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT COUNT(*) c FROM guard_rules').get() as { c: number }).c;
}

describe('syncBuiltinGuardRules 增量同步', () => {
  it('首启全量播种', async () => {
    const { sqlite, db, marker } = await setup();
    const r = syncBuiltinGuardRules(db, [R('a'), R('b')], marker);
    expect(r.inserted.sort()).toEqual(['a', 'b']);
    expect(count(sqlite)).toBe(2);
  });

  it('代码新增规则补进存量库（核心修复）', async () => {
    const { sqlite, db, marker } = await setup();
    syncBuiltinGuardRules(db, [R('a'), R('b')], marker);
    const r2 = syncBuiltinGuardRules(db, [R('a'), R('b'), R('c')], marker);
    expect(r2.inserted).toEqual(['c']);
    expect(count(sqlite)).toBe(3);
  });

  it('管理员删除的规则不复活', async () => {
    const { sqlite, db, marker } = await setup();
    syncBuiltinGuardRules(db, [R('a'), R('b')], marker);
    sqlite.prepare("DELETE FROM guard_rules WHERE id = 'a'").run();
    const r = syncBuiltinGuardRules(db, [R('a'), R('b')], marker);
    expect(r.inserted).toEqual([]);
    expect(r.skippedDeleted).toEqual(['a']);
    expect(count(sqlite)).toBe(1);
  });

  it('幂等：重复跑不重复插入', async () => {
    const { sqlite, db, marker } = await setup();
    syncBuiltinGuardRules(db, [R('a')], marker);
    const r = syncBuiltinGuardRules(db, [R('a')], marker);
    expect(r.inserted).toEqual([]);
    expect(count(sqlite)).toBe(1);
  });

  it('marker 缺失但库已有（首次迁移遗留）：登记不重插、保留管理员改动', async () => {
    const { sqlite, db, marker } = await setup();
    sqlite.prepare("INSERT INTO guard_rules (id,name,kind,target,pattern,priority,description,enabled) VALUES ('a','a','mark','arg','ADMIN_CUSTOM',100,'d',0)").run();
    const r = syncBuiltinGuardRules(db, [R('a')], marker);
    expect(r.inserted).toEqual([]);
    const row = sqlite.prepare("SELECT pattern, enabled FROM guard_rules WHERE id='a'").get() as { pattern: string; enabled: number };
    expect(row.pattern).toBe('ADMIN_CUSTOM');
    expect(row.enabled).toBe(0);
    expect(count(sqlite)).toBe(1);
  });
});
