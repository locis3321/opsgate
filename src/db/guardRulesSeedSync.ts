/**
 * 内置 guard_rules 增量同步（与 marketSeedSync 同思路，修复"一次性标记导致新增内置规则永远进不了存量库"）：
 * - marker 记录"代码已播种过哪些 rule id"；
 * - 只补**代码新增**的规则，不覆盖管理员对已有规则的修改（enabled/pattern 等），不复活管理员删掉的。
 * 三态：代码新增（marker 无 id 且库里无）→ 插入；已播种过（marker 有 id）→ 跳过（即便库里被删）；
 *       库里已有但 marker 无（升级前的首次迁移）→ 记入 marker 不重复插入。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import type { BuiltinGuardRule } from './builtinGuardRules.js';

export interface GuardRuleSyncResult {
  inserted: string[];
  skippedDeleted: string[];
}

export function syncBuiltinGuardRules(
  db: BetterSQLite3Database<typeof schema>,
  rules: BuiltinGuardRule[],
  markerPath: string,
): GuardRuleSyncResult {
  const seen = new Set<string>();
  if (existsSync(markerPath)) {
    try {
      const raw = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
      if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') seen.add(id);
    } catch {
      // marker 损坏 → 当作空，全部按"未播种"处理；但 onConflictDoNothing 保证不重复插
    }
  }

  const existing = new Set(
    db.select({ id: schema.guardRules.id }).from(schema.guardRules).all().map((r) => r.id),
  );

  const inserted: string[] = [];
  const skippedDeleted: string[] = [];
  for (const r of rules) {
    if (seen.has(r.id)) {
      // 代码播种过：若库里没了 = 管理员删的，不复活
      if (!existing.has(r.id)) skippedDeleted.push(r.id);
      continue;
    }
    if (existing.has(r.id)) {
      // 升级前就存在（首启全量播种时代的遗留）：仅登记，不重插（保留管理员改动）
      seen.add(r.id);
      continue;
    }
    const res = db
      .insert(schema.guardRules)
      .values({ ...r, enabled: true, locked: true, builtin: true, hitCount: 0 })
      .onConflictDoNothing({ target: schema.guardRules.id })
      .run();
    if (res.changes > 0) inserted.push(r.id);
    seen.add(r.id);
  }

  writeFileSync(markerPath, JSON.stringify([...seen].sort()));
  return { inserted, skippedDeleted };
}
