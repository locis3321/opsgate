/**
 * 版本比较（T6）：目录版本固定为 x.y.z，按数字段比较。
 * 忽略 pre-release 与 build 元数据（`1.0.0-beta` 视作 `1.0.0`）；
 * 无法解析（含非数字段）一律判为"不更新"，避免误报。
 */
export function parseVersion(v: string): [number, number, number] | null {
  const core = v.trim().replace(/^v/i, '').split(/[-+]/)[0]!;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** latest 是否严格大于 pinned；任一方无法解析返回 false */
export function isNewerVersion(latest: string, pinned: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(pinned);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}
