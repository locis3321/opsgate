/**
 * 镜像源注入回归（general.npm_registry / general.pypi_index_url）：
 *  - 默认华为云源，L1 热生效（无需重启）
 *  - 可覆盖、留空即不注入
 *  - 子进程 env 合并顺序：{ ...buildRegistryEnv(), ...plan.env } —— 资产自身配置优先
 */
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA } from '../config/settingsSchema.js';
import { buildRegistryEnv } from './instancePool.js';

const def = (key: string) => SETTINGS_SCHEMA.find((d) => d.key === key)!;

describe('镜像源设置项', () => {
  it('默认指向华为云，属 general 分类且热生效', () => {
    const npm = def('general.npm_registry');
    const pypi = def('general.pypi_index_url');

    expect(String(npm.default)).toBe('https://repo.huaweicloud.com/repository/npm/');
    expect(String(pypi.default)).toBe('https://repo.huaweicloud.com/repository/pypi/simple');
    for (const d of [npm, pypi]) {
      expect(d.type).toBe('string');
      expect(d.category).toBe('general');
      expect(d.requiresRestart).toBe(false);
      expect(d.secret).toBe(false);
    }
  });

  it('默认值注入 npm / uv / pip 三条拉包路径', () => {
    const env = buildRegistryEnv(
      String(def('general.npm_registry').default),
      String(def('general.pypi_index_url').default),
    );
    expect(env.npm_config_registry).toContain('huaweicloud');
    expect(env.UV_INDEX_URL).toContain('huaweicloud');
    expect(env.PIP_INDEX_URL).toContain('huaweicloud');
  });

  it('留空 → 不注入（允许关闭镜像走官方源）', () => {
    expect(buildRegistryEnv('  ', '')).toEqual({});
    expect(buildRegistryEnv(undefined, undefined)).toEqual({});
  });

  it('可改为其它国内源', () => {
    const env = buildRegistryEnv('https://registry.npmmirror.com', 'https://pypi.tuna.tsinghua.edu.cn/simple');
    expect(env.npm_config_registry).toBe('https://registry.npmmirror.com');
    expect(env.UV_INDEX_URL).toBe('https://pypi.tuna.tsinghua.edu.cn/simple');
  });

  it('资产自身 env 优先于全局镜像（合并顺序）', () => {
    const merged: Record<string, string> = {
      ...buildRegistryEnv('https://repo.huaweicloud.com/repository/npm/', 'https://repo.huaweicloud.com/repository/pypi/simple'),
      ...{ npm_config_registry: 'https://custom.example/registry', MY_TOKEN: 'x' },
    };
    expect(merged.npm_config_registry).toBe('https://custom.example/registry');
    expect(merged.MY_TOKEN).toBe('x');
    expect(merged.UV_INDEX_URL).toContain('huaweicloud');
  });
});
