/**
 * market_entries 读取层（ADR-029）：行与 `CatalogEntry` 双向转换 + 目录查询。
 *
 * 为什么单列一层：`detectSlots` / `expandConfig` / `injectSlots` 与实例化链路都以
 * `CatalogEntry` 为输入。落库后必须还原成同一形状，否则这四处全部要改；
 * 转换只在此文件发生，路由与纯函数都不感知表结构。
 */
import { asc, eq, ne } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import type { CatalogEntry } from '../services/marketCatalog.js';

type Row = typeof schema.marketEntries.$inferSelect;
type Insert = typeof schema.marketEntries.$inferInsert;

export type MarketStatus = 'draft' | 'verified' | 'disabled';
export const MARKET_STATUSES: readonly MarketStatus[] = ['draft', 'verified', 'disabled'];

/** 行 → CatalogEntry（JSON 列已由 drizzle 的 mode:'json' 反序列化） */
export function rowToEntry(row: Row): CatalogEntry {
  return {
    key: row.key,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    repository: row.repository,
    categories: row.categories,
    tags: row.tags,
    runtime: row.runtime as CatalogEntry['runtime'],
    ...(row.executionMode === 'native' ? { executionMode: 'native' as const } : {}),
    ...(row.slotLabels ? { slotLabels: row.slotLabels } : {}),
    ...(row.defaultGroup ? { defaultGroup: row.defaultGroup } : {}),
    installations: row.installations as CatalogEntry['installations'],
  };
}

/** 从条目 installations 的 args 提取锁定版本（npx pkg@x.y.z / uvx --from pkg==x.y.z） */
export function extractPinnedVersion(installations: unknown, runtime: string): string | null {
  const branch = (installations as Record<string, { args?: string[] } | undefined> | null)?.[runtime];
  for (const a of branch?.args ?? []) {
    const at = /@(\d+\.\d+\.\d+)$/.exec(a);
    if (at) return at[1]!;
    const eq = /==(\d+\.\d+\.\d+)$/.exec(a);
    if (eq) return eq[1]!;
  }
  return null;
}

/** CatalogEntry → 可插入行（seed 与 T4 管理 API 共用） */
export function entryToRow(
  entry: CatalogEntry,
  status: MarketStatus,
): Insert {
  return {
    key: entry.key,
    name: entry.name,
    displayName: entry.displayName,
    description: entry.description,
    repository: entry.repository,
    categories: entry.categories,
    tags: entry.tags,
    runtime: entry.runtime,
    slotLabels: entry.slotLabels ?? null,
    defaultGroup: entry.defaultGroup ?? null,
    installations: entry.installations,
    status,
    executionMode: entry.executionMode ?? 'mcp',
    // 锁定版本从 args 解析，供版本比对（T6）；解析不到留空
    versionPinned: extractPinnedVersion(entry.installations, entry.runtime),
  };
}

/**
 * 目录列表：`includeStatuses` 决定可见范围。
 * 普通成员只看 verified；管理员额外看 draft；disabled 永不进入列表。
 */
export function listEntries(
  db: BetterSQLite3Database<typeof schema>,
  statuses: readonly MarketStatus[] = ['verified'],
): CatalogEntry[] {
  const rows = db
    .select()
    .from(schema.marketEntries)
    .where(ne(schema.marketEntries.status, 'disabled'))
    .orderBy(asc(schema.marketEntries.key))
    .all()
    .filter((r) => statuses.includes(r.status as MarketStatus));
  return rows.map(rowToEntry);
}

/** 取单条目：不存在或状态不在允许集合内均返回 null（调用方统一 404，不区分存在性） */
export function getEntry(
  db: BetterSQLite3Database<typeof schema>,
  key: string,
  statuses: readonly MarketStatus[] = ['verified'],
): CatalogEntry | null {
  const row = db.select().from(schema.marketEntries).where(eq(schema.marketEntries.key, key)).get();
  if (!row) return null;
  const status = row.status as MarketStatus;
  if (status === 'disabled' || !statuses.includes(status)) return null;
  return rowToEntry(row);
}

/** 取单条目（不加状态过滤，供管理端使用）：不存在返回 null */
export function getEntryRaw(
  db: BetterSQLite3Database<typeof schema>,
  key: string,
): Row | null {
  return db.select().from(schema.marketEntries).where(eq(schema.marketEntries.key, key)).get() ?? null;
}

/** 是否存在（含 disabled），用于新增时判重 */
export function entryExists(db: BetterSQLite3Database<typeof schema>, key: string): boolean {
  return !!getEntryRaw(db, key);
}

/** 新增条目：调用方负责先判重（409 由路由层给出业务化消息） */
export function insertEntry(
  db: BetterSQLite3Database<typeof schema>,
  entry: CatalogEntry,
  status: MarketStatus,
): void {
  db.insert(schema.marketEntries).values(entryToRow(entry, status)).run();
}

/**
 * 更新条目的可编辑字段。`patch` 只含调用方显式给出的字段——
 * 未给出的字段保持原值（部分更新语义，避免读-改-写时用旧值覆盖并发修改）。
 */
export function updateEntry(
  db: BetterSQLite3Database<typeof schema>,
  key: string,
  patch: {
    name?: string;
    displayName?: string;
    description?: string;
    repository?: string;
    categories?: string[];
    tags?: string[];
    runtime?: string;
    slotLabels?: Record<string, string> | null;
    defaultGroup?: string | null;
    installations?: CatalogEntry['installations'];
    executionMode?: 'mcp' | 'native';
    status?: MarketStatus;
    readmeUrl?: string | null;
    versionPinned?: string | null;
    versionLatest?: string | null;
  },
): void {
  const values: Partial<Insert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.displayName !== undefined) values.displayName = patch.displayName;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.repository !== undefined) values.repository = patch.repository;
  if (patch.categories !== undefined) values.categories = patch.categories;
  if (patch.tags !== undefined) values.tags = patch.tags;
  if (patch.runtime !== undefined) values.runtime = patch.runtime;
  if (patch.slotLabels !== undefined) values.slotLabels = patch.slotLabels;
  if (patch.defaultGroup !== undefined) values.defaultGroup = patch.defaultGroup;
  if (patch.installations !== undefined) values.installations = patch.installations;
  if (patch.executionMode !== undefined) values.executionMode = patch.executionMode;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.readmeUrl !== undefined) values.readmeUrl = patch.readmeUrl;
  if (patch.versionPinned !== undefined) values.versionPinned = patch.versionPinned;
  if (patch.versionLatest !== undefined) values.versionLatest = patch.versionLatest;
  db.update(schema.marketEntries).set(values).where(eq(schema.marketEntries.key, key)).run();
}

/** 删除条目：调用方须先确认无资产引用（路由层检查） */
export function deleteEntry(db: BetterSQLite3Database<typeof schema>, key: string): void {
  db.delete(schema.marketEntries).where(eq(schema.marketEntries.key, key)).run();
}

/** 写入 README 缓存；顺带记录上游版本（T6 检测结果复用）。 */
export function updateReadmeCache(
  db: BetterSQLite3Database<typeof schema>,
  key: string,
  markdown: string,
  version?: string,
): void {
  const values: Partial<Insert> = { readmeCache: markdown, readmeFetchedAt: new Date(), updatedAt: new Date() };
  if (version) values.versionLatest = version;
  db.update(schema.marketEntries).set(values).where(eq(schema.marketEntries.key, key)).run();
}

/** 写入版本检测结果（T6） */
export function updateVersionLatest(
  db: BetterSQLite3Database<typeof schema>,
  key: string,
  versionLatest: string | null,
): void {
  db.update(schema.marketEntries)
    .set({ versionLatest, updatedAt: new Date() })
    .where(eq(schema.marketEntries.key, key))
    .run();
}

/** 引用该条目的资产数量（删除前校验） */
export function countAssetsFromEntry(
  db: BetterSQLite3Database<typeof schema>,
  key: string,
): number {
  return db
    .select({ id: schema.servers.id })
    .from(schema.servers)
    .where(eq(schema.servers.marketKey, key))
    .all().length;
}

/**
 * 分类计数：`categories` 是 JSON 数组，需逐条展开后计数。
 * 排除 disabled；按条目数降序、同数按分类名升序（结果稳定，便于测试与 UI 顺序一致）。
 */
export function categoryCounts(
  db: BetterSQLite3Database<typeof schema>,
): Array<{ category: string; count: number }> {
  const rows = db
    .select({ categories: schema.marketEntries.categories })
    .from(schema.marketEntries)
    .where(ne(schema.marketEntries.status, 'disabled'))
    .all();
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const c of r.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}
