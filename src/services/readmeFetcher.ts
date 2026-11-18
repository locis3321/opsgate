/**
 * README 抓取（ADR-029 / T5）：从条目 `repository` 推断源类型，抓取正文并缓存到 market_entries。
 *
 * 域名白名单而非跑 SSRF 探测器：readme_url 是管理员可编辑字段，若不限制就等于给了一个
 * 可对内网发请求的入口。这里只允许三个公开 registry/托管站，既消除 SSRF 面，
 * 又让行为可预测（不依赖 DNS 解析结果）。
 */
import { updateReadmeCache } from '../db/marketEntries.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema.js';

/** README 内容上限：防止超长 README 把库撑大（T5 决策） */
export const README_MAX_BYTES = 100 * 1024;
/** 缓存有效期：24h（T5 决策） */
export const README_TTL_MS = 24 * 60 * 60 * 1000;
/** 单次抓取超时 */
const FETCH_TIMEOUT_MS = 10_000;

export type ReadmeSource =
  | { kind: 'pypi'; pkg: string }
  | { kind: 'npm'; pkg: string }
  | { kind: 'github'; owner: string; repo: string };

/** 允许抓取的域名（精确匹配 host） */
const ALLOWED_HOSTS = new Set([
  'pypi.org',
  'www.pypi.org',
  'registry.npmjs.org',
  'www.npmjs.com',
  'npmjs.com',
  'github.com',
  'www.github.com',
  'api.github.com',
  'raw.githubusercontent.com',
]);

/**
 * 从仓库/项目页 URL 推断 README 来源。
 * 只认白名单域名的公开页面形态；无法识别返回 null（调用方展示"无可抓取来源"，不猜）。
 */
export function parseReadmeSource(url: string | null | undefined): ReadmeSource | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!ALLOWED_HOSTS.has(u.hostname)) return null;

  const segs = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.replace(/^www\./, '');

  if (host === 'pypi.org') {
    // /project/<pkg>/ 或 /project/<pkg>
    if (segs[0] === 'project' && segs[1]) return { kind: 'pypi', pkg: decodePkg(segs[1]) };
    return null;
  }
  if (host === 'npmjs.com' || host === 'registry.npmjs.org') {
    // /package/<name>（scoped 包为 /package/@scope/name）
    if (segs[0] === 'package' && segs[1]) {
      const pkg = segs[1].startsWith('@') && segs[2] ? `${segs[1]}/${segs[2]}` : segs[1];
      return { kind: 'npm', pkg: decodePkg(pkg) };
    }
    // registry.npmjs.org/<name>（scoped 为 /@scope%2Fname 或 /@scope/name）
    if (host === 'registry.npmjs.org' && segs[0]) {
      const pkg = segs[0].startsWith('@') && segs[1] ? `${segs[0]}/${segs[1]}` : segs[0];
      return { kind: 'npm', pkg: decodePkg(pkg) };
    }
    return null;
  }
  if (host === 'github.com') {
    // /<owner>/<repo>
    if (segs.length >= 2) return { kind: 'github', owner: segs[0]!, repo: segs[1]!.replace(/\.git$/, '') };
    return null;
  }
  return null;
}

function decodePkg(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export interface ReadmeResult {
  markdown: string;
  /** 上游声明的版本（PyPI `info.version` / npm `dist-tags.latest`）；用于 T6 */
  version?: string;
}

export type FetchImpl = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/** 默认实现：Node 内置 fetch。测试注入假实现以离线覆盖映射逻辑。 */
const defaultFetch: FetchImpl = (url, init) => fetch(url, init) as unknown as ReturnType<FetchImpl>;

/**
 * 按来源抓取 README 正文。
 * 失败抛错（调用方决定是否降级）；不做重试（T5 决策：避免阻塞）。
 */
export async function fetchReadmeFrom(
  source: ReadmeSource,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<ReadmeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    if (source.kind === 'pypi') {
      const res = await fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(source.pkg)}/json`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`PyPI 返回 ${res.status}`);
      const body = (await res.json()) as { info?: { description?: string; version?: string } };
      const md = body.info?.description;
      if (!md) throw new Error('PyPI 条目无 description');
      return { markdown: truncate(md), ...(body.info?.version ? { version: body.info.version } : {}) };
    }
    if (source.kind === 'npm') {
      // scoped 包在 registry API 中需编码为 @scope%2Fname
      const enc = source.pkg.startsWith('@') ? source.pkg.replace('/', '%2F') : source.pkg;
      const res = await fetchImpl(`https://registry.npmjs.org/${enc}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`npm registry 返回 ${res.status}`);
      const body = (await res.json()) as {
        readme?: string;
        'dist-tags'?: { latest?: string };
      };
      const md = body.readme;
      if (!md) throw new Error('npm 条目无 readme 字段');
      const latest = body['dist-tags']?.latest;
      return { markdown: truncate(md), ...(latest ? { version: latest } : {}) };
    }
    // GitHub：优先 api.github.com/repos/…/readme（返回 base64），回退 raw main/master
    const apiRes = await fetchImpl(`https://api.github.com/repos/${source.owner}/${source.repo}/readme`, {
      headers: { accept: 'application/vnd.github.raw' },
      signal: ctrl.signal,
    });
    if (apiRes.ok) {
      const text = await apiRes.text();
      if (text) return { markdown: truncate(text) };
    }
    for (const branch of ['main', 'master']) {
      const raw = await fetchImpl(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${branch}/README.md`, {
        signal: ctrl.signal,
      });
      if (raw.ok) {
        const text = await raw.text();
        if (text) return { markdown: truncate(text) };
      }
    }
    throw new Error(`GitHub README 抓取失败（api ${apiRes.status}，main/master 均不可用）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 按字节截断（不切坏多字节字符） */
export function truncate(md: string): string {
  const buf = Buffer.from(md, 'utf8');
  if (buf.byteLength <= README_MAX_BYTES) return md;
  const end = README_MAX_BYTES;
  // 回退到合法 UTF-8 边界（最多回退 3 字节）
  for (let i = 0; i < 4; i++) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, end - i)) + '\n\n…（内容超长已截断）';
    } catch {
      /* 继续回退 */
    }
  }
  return md.slice(0, README_MAX_BYTES) + '\n\n…（内容超长已截断）';
}

export interface ReadmeCacheState {
  cache: string | null;
  fetchedAt: Date | null;
}

export function isStale(fetchedAt: Date | null, nowMs = Date.now()): boolean {
  if (!fetchedAt) return true;
  return nowMs - fetchedAt.getTime() > README_TTL_MS;
}

export interface GetReadmeDeps {
  db: BetterSQLite3Database<typeof schema>;
  fetchImpl?: FetchImpl;
  now?: () => number;
}

/**
 * 取 README：缓存新鲜直接用；过期返回旧值并后台刷新；无缓存同步抓取（失败返回错误）。
 * 失败时**不清空旧缓存**（T5 决策：宁可旧内容也不要空白）。
 */
export async function getReadme(
  deps: GetReadmeDeps,
  key: string,
  repository: string | null,
  state: ReadmeCacheState,
): Promise<{ markdown: string | null; stale: boolean; error?: string }> {
  const now = deps.now ?? Date.now;
  const stale = isStale(state.fetchedAt, now());
  const source = parseReadmeSource(repository);

  if (!stale) return { markdown: state.cache, stale: false };
  if (!source) {
    return { markdown: state.cache, stale, ...(state.cache ? {} : { error: '该条目没有可抓取的 README 来源' }) };
  }

  const refresh = async (): Promise<ReadmeResult> => {
    const r = await fetchReadmeFrom(source, deps.fetchImpl ?? defaultFetch);
    updateReadmeCache(deps.db, key, r.markdown, r.version);
    return r;
  };

  if (state.cache) {
    // 有旧缓存：返回旧值，后台刷新（不阻塞请求）
    void refresh().catch((e: unknown) => {
      process.stderr.write(`[readme] 后台刷新失败 ${key}: ${e instanceof Error ? e.message : String(e)}\n`);
    });
    return { markdown: state.cache, stale: true };
  }

  try {
    const r = await refresh();
    return { markdown: r.markdown, stale: false };
  } catch (e) {
    return { markdown: null, stale, error: e instanceof Error ? e.message : String(e) };
  }
}
