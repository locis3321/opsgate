/**
 * system_settings 的 Drizzle 存储实现（T1 SettingsStorage 接口落地）。
 * DB 只存偏离默认值的行（ADR-024 / AC-56）。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import type { SettingsRow, SettingsStorage } from '../config/settings.js';

export function createSettingsStorage(
  db: BetterSQLite3Database<typeof schema>,
): SettingsStorage {
  return {
    async getAll(): Promise<SettingsRow[]> {
      const rows = await db
        .select({
          key: schema.systemSettings.key,
          value: schema.systemSettings.value,
          value_type: schema.systemSettings.valueType,
        })
        .from(schema.systemSettings);
      return rows;
    },
  };
}
