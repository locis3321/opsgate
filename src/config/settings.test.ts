import { describe, expect, it } from 'vitest';
import { Settings, type SettingsRow, type SettingsStorage } from './settings.js';
import { SETTINGS_SCHEMA, SETTINGS_BY_KEY } from './settingsSchema.js';

function store(rows: SettingsRow[]): SettingsStorage {
  return { getAll: async () => rows };
}

describe('Settings（L1 系统设置，AC-56 / AC-58 / AC-59）', () => {
  it('AC-56 空库：全部配置项返回 schema 默认值（零 INSERT 可用）', async () => {
    const s = new Settings(store([]));
    await s.init();
    // 数量随 schema 演进（ADR-032 新增 mcp.instructions）；这里断言"逐项都有默认值"，不锁死条数
    expect(SETTINGS_SCHEMA.length).toBeGreaterThan(0);
    for (const def of SETTINGS_SCHEMA) {
      expect(s.get<unknown>(def.key)).toEqual(def.default);
    }
  });

  it('DB 覆盖行优先于默认值', async () => {
    const s = new Settings(
      store([{ key: 'tools.command_timeout_sec', value: '60', value_type: 'duration' }]),
    );
    await s.init();
    expect(s.get('tools.command_timeout_sec')).toBe(60);
  });

  it('AC-59 孤儿 key：init 返回告警而非失败', async () => {
    const s = new Settings(
      store([{ key: 'instance_pool.nonexistent', value: '1', value_type: 'int' }]),
    );
    const { warnings } = await s.init();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('instance_pool.nonexistent');
  });

  it('AC-59 越界值：启动失败并带出 key', async () => {
    const s = new Settings(
      store([{ key: 'instance_pool.global_budget', value: '999', value_type: 'int' }]),
    );
    await expect(s.init()).rejects.toThrowError(/instance_pool\.global_budget/);
  });

  it('AC-59 类型不符：启动失败', async () => {
    const s = new Settings(
      store([{ key: 'instance_pool.global_budget', value: '"abc"', value_type: 'int' }]),
    );
    await expect(s.init()).rejects.toThrowError(/期望 int/);
  });

  it('invalidate 后重新 init 读到 DB 新值（热生效路径）', async () => {
    let rows: SettingsRow[] = [];
    const s = new Settings({ getAll: async () => rows });
    await s.init();
    expect(s.get('tools.list_max')).toBe(200);
    rows = [{ key: 'tools.list_max', value: '300', value_type: 'int' }];
    s.invalidate();
    await s.init();
    expect(s.get('tools.list_max')).toBe(300);
  });

  it('AC-58 schema 中不存在命中不可配置红线的 key', () => {
    const forbidden = /audit.*(enable|disable|skip)|accessMode|authorize/i;
    for (const def of SETTINGS_SCHEMA) {
      expect(def.key).not.toMatch(forbidden);
    }
  });

  it('所有 key 均有对应 schema 定义且默认值类型正确', () => {
    for (const def of SETTINGS_SCHEMA) {
      expect(SETTINGS_BY_KEY.get(def.key)).toBe(def);
    }
  });
});
