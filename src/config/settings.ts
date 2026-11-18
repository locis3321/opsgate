/**
 * L1 系统设置读服务（ADR-024 / Spec §5.10.3-5.10.4）。
 * 读路径：内存缓存（写后 invalidate）→ DB（system_settings，仅偏离默认值的行）→ schema 默认值。
 * 启动期校验（fail-fast，AC-59）：孤儿 key → 告警；类型/范围非法 → 抛错（启动失败）。
 * DB 存取由 storage 注入（T2 落地 Drizzle 实现），本模块不感知存储细节。
 */
import {
  SETTINGS_BY_KEY,
  type SettingDef,
} from './settingsSchema.js';

/** 任意 settings.get 源（生产 = Settings 实例；测试可传 null 走配置快照） */
export interface SettingsLike {
  get<T = unknown>(key: string): T;
}

export interface SettingsRow {
  key: string;
  /** system_settings.value：统一 JSON 编码字符串 */
  value: string;
  value_type: string;
}

export interface SettingsStorage {
  getAll(): Promise<SettingsRow[]> | SettingsRow[];
}

export class InvalidSettingError extends Error {
  constructor(
    public readonly key: string,
    detail: string,
  ) {
    super(`system_settings 非法值 "${key}": ${detail}`);
    this.name = 'InvalidSettingError';
  }
}

export class Settings {
  private dbValues: Map<string, unknown> = new Map();
  private initialized = false;

  constructor(private readonly storage: SettingsStorage) {}

  /**
   * 启动期校验 + 预热缓存。
   * 返回孤儿 key 告警列表（由启动方打印）；类型/范围非法直接抛错（启动失败）。
   */
  async init(): Promise<{ warnings: string[] }> {
    const rows = await this.storage.getAll();
    const warnings: string[] = [];
    const values = new Map<string, unknown>();
    for (const row of rows) {
      const def = SETTINGS_BY_KEY.get(row.key);
      if (!def) {
        warnings.push(`孤儿配置 key: ${row.key}（SETTINGS_SCHEMA 未声明，需确认或删除）`);
        continue;
      }
      values.set(row.key, parseStoredValue(def, row.value));
    }
    this.dbValues = values;
    this.initialized = true;
    return { warnings };
  }

  /** 读取：DB 覆盖行 → schema 默认值（AC-56：无行 = 默认值，零 INSERT 可用） */
  get<T = unknown>(key: string): T {
    if (!this.initialized) {
      throw new Error(`settings 未初始化，先调用 init(): ${key}`);
    }
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) {
      throw new Error(`settings 未知 key: ${key}`);
    }
    if (this.dbValues.has(key)) {
      return this.dbValues.get(key) as T;
    }
    return def.default as T;
  }

  /** 写路径（T8 PATCH /settings 落库后）调用，清空缓存使新值下一次 get 即生效 */
  invalidate(): void {
    this.dbValues = new Map();
  }

  /** 热生效写通：PATCH 成功落库后同步更新缓存（AC-55：改后无需重启，下一次 get 即为新值） */
  setCache(key: string, value: unknown): void {
    this.dbValues.set(key, value);
  }
}

function parseStoredValue(def: SettingDef, stored: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new InvalidSettingError(def.key, `非法 JSON 字符串: ${stored.slice(0, 80)}`);
  }
  validateValue(def, parsed);
  return parsed;
}

function validateValue(def: SettingDef, value: unknown): void {
  const bad = (detail: string): never => {
    throw new InvalidSettingError(def.key, detail);
  };
  switch (def.type) {
    case 'int':
      if (!Number.isInteger(value)) bad(`期望 int，实际 ${JSON.stringify(value)}`);
      break;
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) bad(`期望 float，实际 ${JSON.stringify(value)}`);
      break;
    case 'bool':
      if (typeof value !== 'boolean') bad(`期望 bool，实际 ${JSON.stringify(value)}`);
      break;
    case 'string':
      if (typeof value !== 'string') bad(`期望 string，实际 ${JSON.stringify(value)}`);
      break;
    case 'json':
      // JSON.parse 已保证合法；任意合法值均接受
      break;
    case 'duration':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) bad(`期望非负秒数，实际 ${JSON.stringify(value)}`);
      break;
    case 'size':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) bad(`期望非负整数字节数，实际 ${JSON.stringify(value)}`);
      break;
  }
  if (typeof value === 'number') {
    if (def.min !== undefined && value < def.min) bad(`低于下限 ${def.min}`);
    if (def.max !== undefined && value > def.max) bad(`超出上限 ${def.max}`);
  }
  if (def.options && def.options.length > 0 && !def.options.includes(value as string | number)) {
    bad(`不在可选值 ${JSON.stringify(def.options)} 内`);
  }
}
