/**
 * 版本检测（ADR-029 / T6）：从上游 registry 取最新版本，与锁定版本比对给出升级提示。
 *
 * 版本比较不引 semver 依赖：目录版本都由本项固定为 `x.y.z`（AC-62 强制 @x.y.z / ==x.y.z），
 * 只需按数字段比较；带前缀 v / 后缀 -beta 的按 T6 决策忽略 pre-release。
 */
import { parseReadmeSource, type FetchImpl, type ReadmeSource } from './readmeFetcher.js';
import { isNewerVersion } from './versionCompare.js';

const FETCH_TIMEOUT_MS = 10_000;

export type VersionSource = ReadmeSource;

/** 与 README 同源推断（同一 repository 字段），避免维护第二套映射 */
export function parseVersionSource(repository: string | null): VersionSource | null {
  return parseReadmeSource(repository);
}

/** 查询上游最新版本；失败抛错（调用方决定是否静默） */
export async function fetchLatestVersion(
  source: VersionSource,
  fetchImpl: FetchImpl,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    if (source.kind === 'pypi') {
      const res = await fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(source.pkg)}/json`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`PyPI 返回 ${res.status}`);
      const body = (await res.json()) as { info?: { version?: string } };
      if (!body.info?.version) throw new Error('PyPI 响应缺少 version');
      return body.info.version;
    }
    if (source.kind === 'npm') {
      const enc = source.pkg.startsWith('@') ? source.pkg.replace('/', '%2F') : source.pkg;
      const res = await fetchImpl(`https://registry.npmjs.org/${enc}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`npm registry 返回 ${res.status}`);
      const body = (await res.json()) as { 'dist-tags'?: { latest?: string } };
      const latest = body['dist-tags']?.latest;
      if (!latest) throw new Error('npm 响应缺少 dist-tags.latest');
      return latest;
    }
    // GitHub：取最新 release tag；无 release 时回退 tags 列表
    const rel = await fetchImpl(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`, {
      signal: ctrl.signal,
    });
    if (rel.ok) {
      const body = (await rel.json()) as { tag_name?: string };
      if (body.tag_name) return body.tag_name.replace(/^v/, '');
    }
    const tags = await fetchImpl(`https://api.github.com/repos/${source.owner}/${source.repo}/tags`, { signal: ctrl.signal });
    if (tags.ok) {
      const list = (await tags.json()) as Array<{ name?: string }>;
      const name = list[0]?.name;
      if (name) return name.replace(/^v/, '');
    }
    throw new Error(`GitHub 版本查询失败（releases ${rel.status}）`);
  } finally {
    clearTimeout(timer);
  }
}

export interface UpgradeInfo {
  pinned: string | null;
  latest: string | null;
  upgradeAvailable: boolean;
}

/**
 * 计算升级提示。任一版本无法解析时不提示（T6 决策：避免错误信息干扰）。
 */
export function computeUpgrade(pinned: string | null, latest: string | null): UpgradeInfo {
  if (!pinned || !latest) return { pinned, latest, upgradeAvailable: false };
  return { pinned, latest, upgradeAvailable: isNewerVersion(latest, pinned) };
}
