/**
 * T6 单元测试：版本比较 / 锁定版本提取 / 上游最新版本查询（离线假 fetch）。
 */
import { describe, expect, it, vi } from 'vitest';
import { computeUpgrade, fetchLatestVersion } from './versionChecker.js';
import { isNewerVersion, parseVersion } from './versionCompare.js';
import { extractPinnedVersion } from '../db/marketEntries.js';
import type { FetchImpl } from './readmeFetcher.js';

describe('T6：版本比较', () => {
  it('按数字段比较，非字典序', () => {
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
  });

  it('忽略 v 前缀 / pre-release / build 元数据', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3+build5')).toEqual([1, 2, 3]);
    expect(isNewerVersion('v1.2.3-beta', '1.2.2')).toBe(true);
  });

  it('无法解析 → 不判为更新（避免误报）', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(isNewerVersion('abc', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', 'abc')).toBe(false);
  });
});

describe('T6：锁定版本提取', () => {
  it('npm 形态 pkg@x.y.z', () => {
    expect(
      extractPinnedVersion({ npm: { command: 'npx', args: ['-y', 'kubernetes-mcp-server@1.2.3'] } }, 'npm'),
    ).toBe('1.2.3');
  });

  it('pypi 形态 --from pkg==x.y.z', () => {
    expect(
      extractPinnedVersion({ pypi: { command: 'uvx', args: ['--from', 'mysql-mcp-server==0.4.5', 'mysql_mcp_server'] } }, 'pypi'),
    ).toBe('0.4.5');
  });

  it('无版本 / 缺少运行时分支 → null', () => {
    expect(extractPinnedVersion({ npm: { command: 'npx', args: ['-y', 'pkg'] } }, 'npm')).toBeNull();
    expect(extractPinnedVersion({ npm: {} }, 'pypi')).toBeNull();
    expect(extractPinnedVersion(null, 'npm')).toBeNull();
  });

  it('现有目录条目全部能解析出锁定版本（AC-62 一致性）', async () => {
    const { loadCatalog } = await import('./marketCatalog.js');
    for (const e of loadCatalog()) {
      // 原生条目（网关内建 HTTP 工具）、CLI 条目（二进制由主机预装，无本地包）与 HTTP/SSE 型条目
      // 都没有本地包版本，不参与版本检测
      if (e.executionMode === 'native' || e.executionMode === 'cli' || e.installations[e.runtime]?.url) continue;
      expect(extractPinnedVersion(e.installations, e.runtime), e.key).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('T6：升级提示计算', () => {
  it('latest > pinned → upgradeAvailable', () => {
    expect(computeUpgrade('1.0.0', '1.2.0')).toEqual({ pinned: '1.0.0', latest: '1.2.0', upgradeAvailable: true });
  });
  it('相等或更旧 → 不提示', () => {
    expect(computeUpgrade('1.2.0', '1.2.0').upgradeAvailable).toBe(false);
    expect(computeUpgrade('2.0.0', '1.0.0').upgradeAvailable).toBe(false);
  });
  it('任一缺失 / 无法解析 → 不提示', () => {
    expect(computeUpgrade(null, '1.0.0').upgradeAvailable).toBe(false);
    expect(computeUpgrade('1.0.0', null).upgradeAvailable).toBe(false);
    expect(computeUpgrade('abc', 'x.y.z').upgradeAvailable).toBe(false);
  });
});

function fakeFetch(routes: Record<string, { status?: number; json?: unknown }>): FetchImpl {
  return vi.fn(async (url: string) => {
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`unexpected url: ${url}`);
    const status = hit[1].status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => hit[1].json, text: async () => '' };
  });
}

describe('T6：上游最新版本查询（离线）', () => {
  it('PyPI → info.version', async () => {
    const f = fakeFetch({ 'https://pypi.org/pypi/x/json': { json: { info: { version: '9.9.9' } } } });
    expect(await fetchLatestVersion({ kind: 'pypi', pkg: 'x' }, f)).toBe('9.9.9');
  });

  it('npm → dist-tags.latest', async () => {
    const f = fakeFetch({ 'https://registry.npmjs.org/y': { json: { 'dist-tags': { latest: '3.2.1' } } } });
    expect(await fetchLatestVersion({ kind: 'npm', pkg: 'y' }, f)).toBe('3.2.1');
  });

  it('GitHub → releases/latest tag（去 v 前缀）', async () => {
    const f = fakeFetch({ 'https://api.github.com/repos/o/r/releases/latest': { json: { tag_name: 'v4.0.0' } } });
    expect(await fetchLatestVersion({ kind: 'github', owner: 'o', repo: 'r' }, f)).toBe('4.0.0');
  });

  it('GitHub：无 release 回退 tags[0]', async () => {
    const f = fakeFetch({
      'https://api.github.com/repos/o/r/releases/latest': { status: 404 },
      'https://api.github.com/repos/o/r/tags': { json: [{ name: 'v2.5.0' }] },
    });
    expect(await fetchLatestVersion({ kind: 'github', owner: 'o', repo: 'r' }, f)).toBe('2.5.0');
  });

  it('全部失败 → 抛错', async () => {
    const f = fakeFetch({
      'https://api.github.com/repos/o/r/releases/latest': { status: 500 },
      'https://api.github.com/repos/o/r/tags': { status: 500 },
    });
    await expect(fetchLatestVersion({ kind: 'github', owner: 'o', repo: 'r' }, f)).rejects.toThrow('GitHub 版本查询失败');
  });

  it('PyPI 缺 version → 抛错（不返回 undefined 冒充成功）', async () => {
    const f = fakeFetch({ 'https://pypi.org/pypi/x/json': { json: { info: {} } } });
    await expect(fetchLatestVersion({ kind: 'pypi', pkg: 'x' }, f)).rejects.toThrow('缺少 version');
  });
});
