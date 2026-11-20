/**
 * 种子数据（T2 / §4.7 + §5.5.7）：内置 guard_rules（locked=1）。
 * 幂等（onConflictDoNothing），可重复执行；先跑迁移（fresh 环境一条命令建库+播种）。
 * 不播种任何分组：分组是自由组织单元，由管理员按需创建（ADR-026，取代 ADR-015 前半「默认分组按资产类型」）。
 * 注意：system_settings **不播种任何行**（ADR-024：DB 只存偏离默认值的行，默认值在 SETTINGS_SCHEMA，AC-56）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readBootstrap } from '../config/bootstrap.js';
import { guardRules, marketEntries } from './schema.js';
import { BUILTIN_GUARD_RULES } from './builtinGuardRules.js';
import { entryToRow } from './marketEntries.js';
import { loadCatalog } from '../services/marketCatalog.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));


async function main(): Promise<void> {
  const cfg = readBootstrap();
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const sqlite = new Database(cfg.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);

  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  for (const r of BUILTIN_GUARD_RULES) {
    db.insert(guardRules)
      .values({ ...r, enabled: true, locked: true, builtin: true, hitCount: 0 })
      .onConflictDoNothing({ target: guardRules.id })
      .run();
  }

  const ruleCount = db.select().from(guardRules).all().length;

  // Market 目录条目（ADR-029）：JSON 仅作种子源，运行时读 market_entries 表。
  // onConflictDoNothing —— 后台改过的条目不能被重跑 seed 覆盖。
  let marketSeeded = 0;
  for (const entry of loadCatalog()) {
    const res = db
      .insert(marketEntries)
      .values(entryToRow(entry, 'verified'))
      .onConflictDoNothing({ target: marketEntries.key })
      .run();
    if (res.changes > 0) marketSeeded++;
  }
  const marketTotal = db.select().from(marketEntries).all().length;

  console.log(
    `seed 完成：内置规则 ${ruleCount}（locked=1）；Market 目录 ${marketTotal} 条` +
      (marketSeeded > 0 ? `（本次新增 ${marketSeeded}）` : '（均为已有，跳过）') +
      '；分组由管理员按需创建（ADR-026）',
  );
  sqlite.close();
}

main().catch((err) => {
  console.error('seed 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
