/**
 * T5 单元测试：README 源解析 / 抓取映射 / 截断 / 缓存新旧判定。
 * 全部离线：注入假 fetch，不发真实网络请求。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchReadmeFrom,
  getReadme,
  isStale,
  parseReadmeSource,
  README_MAX_BYTES,
  README_TTL_MS,
  truncate,
  type FetchImpl,
} from './readmeFetcher.js';

describe('T5：README 源解析（三种仓库形态）', () => {
  it('PyPI 项目页 → pypi 源', () => {
    expect(parseReadmeSource('https://pypi.org/project/mysql-mcp-server/')).toEqual({
      kind: 'pypi',
      pkg: 'mysql-mcp-server',
    });
  });

  it('npm 包页 → npm 源；scoped 包保留 scope', () => {
    expect(parseReadmeSource('https://www.npmjs.com/package/kubernetes-mcp-server')).toEqual({
      kind: 'npm',
      pkg: 'kubernetes-mcp-server',
    });
    expect(parseReadmeSource('https://www.npmjs.com/package/@executeautomation/playwright-mcp-server')).toEqual({
      kind: 'npm',
      pkg: '@executeautomation/playwright-mcp-server',
    });
  });

  it('GitHub 仓库页 → github 源（去 .git 后缀）', () => {
    expect(parseReadmeSource('https://github.com/modelcontextprotocol/servers')).toEqual({
      kind: 'github',
      owner: 'modelcontextprotocol',
      repo: 'servers',
    });
    expect(parseReadmeSource('https://github.com/o/r.git')).toEqual({ kind: 'github', owner: 'o', repo: 'r' });
  });

  it('非白名单域名 → null（防 SSRF：管理员填内网地址不会发请求）', () => {
    expect(parseReadmeSource('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(parseReadmeSource('http://127.0.0.1:8080/admin')).toBeNull();
    expect(parseReadmeSource('https://evil.example.com/pypi.org/project/x')).toBeNull();
    expect(parseReadmeSource('file:///etc/passwd')).toBeNull();
  });

  it('不可识别路径 / 空值 → null', () => {
    expect(parseReadmeSource(null)).toBeNull();
    expect(parseReadmeSource('')).toBeNull();
    expect(parseReadmeSource('not a url')).toBeNull();
    expect(parseReadmeSource('https://pypi.org/help/')).toBeNull();
    expect(parseReadmeSource('https://github.com/onlyowner')).toBeNull();
  });
});

/** 构造假 fetch：按 URL 路由返回给定响应 */
function fakeFetch(routes: Record<string, { status?: number; json?: unknown; text?: string }>): FetchImpl {
  return vi.fn(async (url: string) => {
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`unexpected url: ${url}`);
    const r = hit[1];
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json,
      text: async () => r.text ?? '',
    };
  });
}

describe('T5：抓取映射（离线假 fetch）', () => {
  it('PyPI：取 info.description 与 info.version', async () => {
    const f = fakeFetch({
      'https://pypi.org/pypi/mysql-mcp-server/json': {
        json: { info: { description: '# MySQL MCP\n正文', version: '0.4.5' } },
      },
    });
    const r = await fetchReadmeFrom({ kind: 'pypi', pkg: 'mysql-mcp-server' }, f);
    expect(r.markdown).toContain('MySQL MCP');
    expect(r.version).toBe('0.4.5');
  });

  it('PyPI 无 description → 抛错（不返回空串冒充成功）', async () => {
    const f = fakeFetch({ 'https://pypi.org/pypi/x/json': { json: { info: {} } } });
    await expect(fetchReadmeFrom({ kind: 'pypi', pkg: 'x' }, f)).rejects.toThrow('无 description');
  });

  it('npm：取 readme 与 dist-tags.latest；scoped 包 URL 编码 %2F', async () => {
    const f = fakeFetch({
      'https://registry.npmjs.org/@scope%2Fname': {
        json: { readme: '# Scoped\n内容', 'dist-tags': { latest: '2.1.0' } },
      },
    });
    const r = await fetchReadmeFrom({ kind: 'npm', pkg: '@scope/name' }, f);
    expect(r.markdown).toContain('Scoped');
    expect(r.version).toBe('2.1.0');
    expect(f).toHaveBeenCalledWith('https://registry.npmjs.org/@scope%2Fname', expect.anything());
  });

  it('npm 404 → 抛错', async () => {
    const f = fakeFetch({ 'https://registry.npmjs.org/missing': { status: 404 } });
    await expect(fetchReadmeFrom({ kind: 'npm', pkg: 'missing' }, f)).rejects.toThrow('404');
  });

  it('GitHub：api/readme 成功优先', async () => {
    const f = fakeFetch({
      'https://api.github.com/repos/o/r/readme': { text: '# GitHub README' },
    });
    const r = await fetchReadmeFrom({ kind: 'github', owner: 'o', repo: 'r' }, f);
    expect(r.markdown).toBe('# GitHub README');
  });

  it('GitHub：api 失败回退 raw main', async () => {
    const f = fakeFetch({
      'https://api.github.com/repos/o/r/readme': { status: 404 },
      'https://raw.githubusercontent.com/o/r/main/README.md': { text: '# from main' },
    });
    const r = await fetchReadmeFrom({ kind: 'github', owner: 'o', repo: 'r' }, f);
    expect(r.markdown).toBe('# from main');
  });

  it('GitHub：api 与 main 均失败 → 回退 master', async () => {
    const f = fakeFetch({
      'https://api.github.com/repos/o/r/readme': { status: 404 },
      'https://raw.githubusercontent.com/o/r/main/README.md': { status: 404 },
      'https://raw.githubusercontent.com/o/r/master/README.md': { text: '# from master' },
    });
    const r = await fetchReadmeFrom({ kind: 'github', owner: 'o', repo: 'r' }, f);
    expect(r.markdown).toBe('# from master');
  });

  it('GitHub：全部失败 → 抛错带状态', async () => {
    const f = fakeFetch({
      'https://api.github.com/repos/o/r/readme': { status: 403 },
      'https://raw.githubusercontent.com/o/r/main/README.md': { status: 404 },
      'https://raw.githubusercontent.com/o/r/master/README.md': { status: 404 },
    });
    await expect(fetchReadmeFrom({ kind: 'github', owner: 'o', repo: 'r' }, f)).rejects.toThrow('GitHub README 抓取失败');
  });
});

describe('T5：截断（100KB，不切坏多字节）', () => {
  it('未超限原样返回', () => {
    expect(truncate('short')).toBe('short');
  });

  it('超限按字节截断并附提示，解码无乱码', () => {
    const big = '中'.repeat(README_MAX_BYTES); // 每字 3 字节，远超上限
    const out = truncate(big);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(README_MAX_BYTES + 100);
    expect(out).toContain('内容超长已截断');
    expect(out.includes('\uFFFD')).toBe(false);
  });
});

describe('T5：缓存新旧判定与 getReadme 策略', () => {
  it('isStale：无 fetchedAt → true；24h 内 → false；超过 → true', () => {
    expect(isStale(null)).toBe(true);
    const now = 1_700_000_000_000;
    expect(isStale(new Date(now - 1000), now)).toBe(false);
    expect(isStale(new Date(now - README_TTL_MS - 1), now)).toBe(true);
  });

  it('缓存新鲜：不发请求，直接返回缓存', async () => {
    const f = fakeFetch({});
    const res = await getReadme(
      { db: fakeDb(), fetchImpl: f },
      'k',
      'https://pypi.org/project/x/',
      { cache: 'cached md', fetchedAt: new Date(Date.now() - 1000) },
    );
    expect(res.markdown).toBe('cached md');
    expect(res.stale).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('无缓存：同步抓取并写库', async () => {
    const updates: unknown[] = [];
    const f = fakeFetch({ 'https://pypi.org/pypi/x/json': { json: { info: { description: 'fresh', version: '1.0.0' } } } });
    const res = await getReadme(
      { db: fakeDb(updates), fetchImpl: f },
      'k',
      'https://pypi.org/project/x/',
      { cache: null, fetchedAt: null },
    );
    expect(res.markdown).toBe('fresh');
    expect(updates.length).toBe(1);
  });

  it('缓存过期：返回旧值 + stale=true，并触发后台刷新', async () => {
    const updates: unknown[] = [];
    let called = false;
    const f: FetchImpl = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ info: { description: 'new', version: '2' } }), text: async () => '' };
    };
    const res = await getReadme(
      { db: fakeDb(updates), fetchImpl: f },
      'k',
      'https://pypi.org/project/x/',
      { cache: 'old', fetchedAt: new Date(Date.now() - README_TTL_MS - 1000) },
    );
    expect(res.markdown).toBe('old');
    expect(res.stale).toBe(true);
    await vi.waitFor(() => expect(called).toBe(true));
  });

  it('抓取失败且无旧缓存 → markdown null + error；有旧缓存时不清空', async () => {
    const bad: FetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
    const noCache = await getReadme(
      { db: fakeDb(), fetchImpl: bad },
      'k',
      'https://pypi.org/project/x/',
      { cache: null, fetchedAt: null },
    );
    expect(noCache.markdown).toBeNull();
    expect(noCache.error).toBeTruthy();

    const withCache = await getReadme(
      { db: fakeDb(), fetchImpl: bad },
      'k',
      'https://pypi.org/project/x/',
      { cache: 'keep me', fetchedAt: new Date(Date.now() - README_TTL_MS - 1000) },
    );
    expect(withCache.markdown).toBe('keep me');
  });

  it('无可抓取来源：无缓存返回 error 说明，不抛错', async () => {
    const res = await getReadme(
      { db: fakeDb(), fetchImpl: fakeFetch({}) },
      'k',
      'https://internal.example.invalid/x',
      { cache: null, fetchedAt: null },
    );
    expect(res.markdown).toBeNull();
    expect(res.error).toContain('没有可抓取');
  });
});

/** 极简假 db：只记录 updateReadmeCache 的写库调用 */
function fakeDb(sink: unknown[] = []) {
  return {
    update: () => ({
      set: (v: unknown) => ({
        where: () => ({
          run: () => {
            sink.push(v);
            return { changes: 1 };
          },
        }),
      }),
    }),
  } as never;
}
