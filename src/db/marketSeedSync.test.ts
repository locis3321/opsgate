/**
 * Market 目录增量同步（ADR-029 补充）：代码新增要补、后台编辑不覆盖、管理员删除不复活。
 *
 * 这三个行为是本次改动存在的理由——原实现"表为空才导入"会让部署机永远看不到新增条目，
 * 而简单改成"按 key upsert"又会覆盖管理员的编辑。测试把边界钉死。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from './schema.js';
import { entryToRow } from './marketEntries.js';
import { syncCatalogEntries } from './marketSeedSync.js';
import type { CatalogEntry } from '../services/marketCatalog.js';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

function mkEntry(key: string, displayName = key): CatalogEntry {
  return {
    key,
    name: key,
    displayName,
    description: '',
    repository: `https://example.invalid/${key}`,
    categories: ['other'],
    tags: [],
    runtime: 'npm',
    installations: { npm: { command: 'npx', args: ['-y', `${key}@1.0.0`] } },
  };
}

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let markerPath: string;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  markerPath = path.join(mkdtempSync(path.join(tmpdir(), 'mkt-sync-')), '.market-seeded');
});

afterEach(() => sqlite.close());

const keys = () => db.select({ key: schema.marketEntries.key }).from(schema.marketEntries).all().map((r) => r.key).sort();
const rowOf = (key: string) => db.select().from(schema.marketEntries).all().find((r) => r.key === key)!;

describe('Market 目录增量同步', () => {
  it('首次运行：补全所有条目并写 marker', () => {
    const r = syncCatalogEntries(db, [mkEntry('a'), mkEntry('b')], markerPath);
    expect(r.inserted.sort()).toEqual(['a', 'b']);
    expect(keys()).toEqual(['a', 'b']);
  });

  it('代码新增条目：第二次运行补上新增的，不影响已有的', () => {
    syncCatalogEntries(db, [mkEntry('a')], markerPath);
    const r = syncCatalogEntries(db, [mkEntry('a'), mkEntry('b')], markerPath);
    expect(r.inserted).toEqual(['b']);
    expect(keys()).toEqual(['a', 'b']);
  });

  it('后台编辑过的条目不被覆盖（这是原 upsert 方案会犯的错）', () => {
    syncCatalogEntries(db, [mkEntry('a', '默认名')], markerPath);
    // 模拟管理员改了 displayName
    sqlite.prepare(`UPDATE market_entries SET display_name = '管理员改过的名字' WHERE key = 'a'`).run();

    syncCatalogEntries(db, [mkEntry('a', '默认名')], markerPath);
    expect(rowOf('a').displayName).toBe('管理员改过的名字');
  });

  it('管理员删除的条目不被复活', () => {
    syncCatalogEntries(db, [mkEntry('a'), mkEntry('b')], markerPath);
    // 模拟管理员删掉 b
    sqlite.prepare(`DELETE FROM market_entries WHERE key = 'b'`).run();
    expect(keys()).toEqual(['a']);

    const r = syncCatalogEntries(db, [mkEntry('a'), mkEntry('b')], markerPath);
    expect(r.inserted).toEqual([]);
    expect(r.skippedDeleted).toEqual(['b']);
    expect(keys()).toEqual(['a']);
  });

  it('marker 丢失但库里有数据：不覆盖、不重复插入', () => {
    db.insert(schema.marketEntries).values(entryToRow(mkEntry('a', '已有名字'), 'verified')).run();
    // marker 不存在（模拟老部署机升级上来）
    const r = syncCatalogEntries(db, [mkEntry('a', '默认名'), mkEntry('b')], markerPath);
    expect(r.inserted).toEqual(['b']); // a 已在库，只补 b
    expect(rowOf('a').displayName).toBe('已有名字'); // 不覆盖
  });

  it('幂等：连续跑三次结果一致', () => {
    const catalog = [mkEntry('a'), mkEntry('b')];
    syncCatalogEntries(db, catalog, markerPath);
    const r2 = syncCatalogEntries(db, catalog, markerPath);
    const r3 = syncCatalogEntries(db, catalog, markerPath);
    expect(r2.inserted).toEqual([]);
    expect(r3.inserted).toEqual([]);
    expect(keys()).toEqual(['a', 'b']);
  });
});
