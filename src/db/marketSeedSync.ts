/**
 * 内置 Market 目录的增量同步（ADR-029 补充，2026-11-23）。
 *
 * 为什么需要这层：原实现是「仅在 `market_entries` 表为空时导入」（见 src/server.ts 首启 seed），
 * 导致部署机一旦有了数据，**后续代码新增的目录条目永远不会出现**——`market-catalog.json`
 * 号称"种子源"，实际只在首次安装生效。cr7258 ES 条目就是这样"部署了但看不见"的。
 *
 * 三种状态要区分清楚，不能混：
 *
 * | 状态 | 判据 | 动作 |
 * |---|---|---|
 * | 代码新增（本次要补） | 在 catalog 里、不在 marker 里、也不在表里 | **插入** |
 * | 已在库（可能被后台改过） | 在 catalog 里、在 marker 里 | **不动**（保护管理员的编辑） |
 * | 管理员删除（不要复活） | 曾播种过、在 marker 里、当前不在表里 | **不动**（尊重人工决策） |
 *
 * marker 存 `<dataDir>/.market-seeded`，内容是"曾由代码播种过的 key 列表"。
 * 为什么不直接「按 key upsert 全量」：那会把管理员改过的 status/description 覆盖回默认值，
 * 与 ADR-029「后台条目管理」冲突。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { entryToRow } from './marketEntries.js';
import type { CatalogEntry } from '../services/marketCatalog.js';

export interface CatalogSyncResult {
  /** 本次新插入的 key */
  inserted: string[];
  /** 曾播种但当前不在表里（管理员删除过），本次跳过 */
  skippedDeleted: string[];
  /** 已在库且曾播种（可能被改过），本次不动 */
  skippedExisting: number;
}

function readMarker(markerPath: string): Set<string> {
  if (!existsSync(markerPath)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
    if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === 'string'));
    // 兼容 { keys: [...] } 形状
    if (raw && typeof raw === 'object' && Array.isArray((raw as { keys?: unknown }).keys)) {
      return new Set(((raw as { keys: unknown[] }).keys).filter((x): x is string => typeof x === 'string'));
    }
    return new Set();
  } catch {
    // marker 损坏时按"从未播种"处理：本次会全量补一遍 missing 的条目，不覆盖已有行
    return new Set();
  }
}

function writeMarker(markerPath: string, keys: Set<string>): void {
  writeFileSync(markerPath, JSON.stringify({ keys: [...keys].sort() }, null, 2) + '\n');
}

/**
 * 把 catalog 里"代码新增"的条目补进库。
 *
 * @param catalog 当前代码内置的目录（loadCatalog()）
 * @param markerPath 一次性标记路径（建议 `<dataDir>/.market-seeded`）
 */
export function syncCatalogEntries(
  db: BetterSQLite3Database<typeof schema>,
  catalog: CatalogEntry[],
  markerPath: string,
): CatalogSyncResult {
  const seen = readMarker(markerPath);
  const existing = new Set(
    db.select({ key: schema.marketEntries.key }).from(schema.marketEntries).all().map((r) => r.key),
  );

  const inserted: string[] = [];
  const skippedDeleted: string[] = [];

  for (const entry of catalog) {
    if (seen.has(entry.key)) {
      // 曾播种过：在库就跳过（保护编辑），不在库说明是管理员删的（不复活）
      if (!existing.has(entry.key)) skippedDeleted.push(entry.key);
      continue;
    }
    // 从未播种：若库中已有同名 key（历史导入但 marker 丢失），也按"已存在"处理，不覆盖
    if (existing.has(entry.key)) {
      seen.add(entry.key);
      continue;
    }
    const res = db
      .insert(schema.marketEntries)
      .values(entryToRow(entry, 'verified'))
      .onConflictDoNothing({ target: schema.marketEntries.key })
      .run();
    if (res.changes > 0) inserted.push(entry.key);
    seen.add(entry.key);
  }

  // 无论是否有新增都写回：让下次启动知道这些 key 已由代码播种过
  writeMarker(markerPath, seen);

  return {
    inserted,
    skippedDeleted,
    skippedExisting: catalog.length - inserted.length - skippedDeleted.length,
  };
}
