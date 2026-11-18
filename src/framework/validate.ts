/**
 * R1–R8 描述规范静态校验器（任务 L，Spec §5.5.3）。
 * 工具名 {category}_ 前缀 / description 含 asset 取值指引（R3）/ 四段式（R4 Use when）/
 * 长度上限（R6：工具 200 字、参数 80 字）/ 参数 description 必填（R7）/ 危险工具标注（R8）。
 * 返回违规清单（空数组 = 通过）。
 */
import type { NativeToolDefinition } from './types.js';

const DESC_MAX = 200;
const PARAM_DESC_MAX = 80;

/** 资产取值指引出现任一即视为 R3 通过 */
const ASSET_GUIDE_RE = /opsgate_list_assets|不要编造|不要凭记忆|取值来自/;

export function validateDescription(def: NativeToolDefinition): string[] {
  const errors: string[] = [];
  const where = `工具 ${def.name} (${def.id})`;

  // R1：品类前缀（名称须 {category}_ 开头，且不裸用单段名）
  if (!def.name.startsWith(`${def.category}_`)) {
    errors.push(`${where}: R1 工具名须以 "${def.category}_" 前缀开头`);
  }

  // R3：asset 取值指引
  if (!ASSET_GUIDE_RE.test(def.description)) {
    errors.push(`${where}: R3 description 须含 asset 取值指引（opsgate_list_assets / "不要编造" 等）`);
  }

  // R4：四段式（Use when 自然语句，何段）
  if (!/Use when:/i.test(def.description)) {
    errors.push(`${where}: R4 description 须含 "Use when:" 段`);
  }
  if (!/Required:/i.test(def.description)) {
    errors.push(`${where}: R4 description 须含 "Required:" 段（asset 指引所在）`);
  }

  // R6：长度上限
  if (def.description.length > DESC_MAX) {
    errors.push(`${where}: R6 description ${def.description.length} 字 > ${DESC_MAX}`);
  }

  // R7 + R6：参数描述必填且 ≤80 字
  const schema = def.inputSchema as { properties?: Record<string, { description?: unknown; enum?: unknown[] }> };
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const desc = prop.description;
    if (typeof desc !== 'string' || desc.trim() === '') {
      errors.push(`${where}: R7 参数 "${name}" 的 description 必填`);
    } else if (desc.length > PARAM_DESC_MAX) {
      errors.push(`${where}: R6 参数 "${name}" 描述 ${desc.length} 字 > ${PARAM_DESC_MAX}`);
    }
    if (typeof desc === 'string' && Array.isArray(prop.enum) && !/含义|[是指]/.test(desc)) {
      errors.push(`${where}: R7 枚举参数 "${name}" 描述须说明各取值含义`);
    }
  }

  // R8：破坏性工具须标注 destructive + 确认要求
  if (def.risk === 'destructive') {
    if (!/destructive/i.test(def.description)) {
      errors.push(`${where}: R8 破坏性工具描述须显式标注 "destructive"`);
    }
    if (!/确认/i.test(def.description)) {
      errors.push(`${where}: R8 破坏性工具描述须声明需用户确认`);
    }
  }
  return errors;
}

export function validateAll(defs: NativeToolDefinition[]): string[] {
  return defs.flatMap(validateDescription);
}
