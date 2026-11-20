/**
 * 资产标签归一（写入侧唯一入口）。
 *
 * 标签不是独立实体（没有全局标签表），但它不是纯展示：MCP `?tag=` 与
 * `opsgate_select_scope({tag})` 都按**精确值**匹配。因此写入侧必须：
 *  - 去首尾空白、丢空串、去重（保留首次出现顺序）
 *  - 限制单个长度与总数，防止一个脏标签撑爆列表列或让收窄失去意义
 *  - **保留原始大小写**：静默小写化会让存量标签（`TKE` / `K8S`）的筛选突然失效；
 *    近义重复（prod/Prod/生产）由前端「从已有标签选」的交互避免，读写层不做隐式合并。
 */

export const MAX_TAGS = 32;
export const MAX_TAG_LEN = 64;

export type NormalizeTagsResult = { tags: string[] } | { error: string };

export function normalizeTags(raw: unknown): NormalizeTagsResult {
  if (!Array.isArray(raw)) return { error: 'tags 必须为字符串数组' };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { error: 'tags 必须为字符串数组' };
    const t = item.trim();
    if (!t) continue;
    if (t.length > MAX_TAG_LEN) return { error: `单个标签不能超过 ${MAX_TAG_LEN} 字符` };
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  if (out.length > MAX_TAGS) return { error: `标签数量不能超过 ${MAX_TAGS} 个` };
  return { tags: out };
}
