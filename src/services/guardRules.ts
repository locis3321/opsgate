/**
 * guard_rules 规则引擎（§4.7 / §5.8）：启动加载 enabled 规则（priority 降序），
 * 每次调用对工具名 + 参数（脱敏前）匹配，**先 block 后 mark**，block 命中即中断；
 * 命中多条取 priority 最高。规则热重载与 CRUD（T8 /settings 安全策略页）。
 */
import type { Database } from 'better-sqlite3';

export interface ActiveRule {
  id: string;
  name: string;
  kind: 'mark' | 'block';
  /**
   * 匹配维度（拿什么去匹配），与 scope 正交：
   * - tool：工具名
   * - arg：参数**值**（递归展开嵌套对象/数组，只看值不看键名）
   * - body：完整请求体文本（键名 + 值，JSON 序列化后再匹配）——用于"参数里没有明确字段、
   *   但请求体本身带攻击特征"的场景（如引擎把用户输入嵌进 queryBody）
   * - asset_type：资产类型
   * - group：资产所属分组名
   */
  target: 'tool' | 'arg' | 'body' | 'asset_type' | 'group';
  pattern: string;
  priority: number;
  /** 作用域：对哪些资产生效（与 target 的匹配维度正交）。缺省按 global（兼容旧调用方） */
  scope?: 'global' | 'asset_type' | 'asset';
  /** scope=asset_type → 品类名；scope=asset → 资产 id；global/缺省 → null */
  scopeValue?: string[] | null;
  source?: 'builtin' | 'admin' | 'owner';
}

export interface RuleInput {
  tool: string;
  args: Record<string, unknown>;
  assetType: string;
  /** 作用域判定用：asset 级规则只对该资产生效 */
  assetId?: string;
  groups?: string[];
}

export interface RuleHit {
  kind: 'block' | 'mark';
  ruleId: string;
  ruleName: string;
}

export function loadActiveRules(sqlite: Database): ActiveRule[] {
  const rows = sqlite
    .prepare('SELECT id, name, kind, target, pattern, priority, scope, scope_value, source FROM guard_rules WHERE enabled = 1 ORDER BY priority DESC')
    .all() as Array<{
      id: string; name: string; kind: string; target: string; pattern: string; priority: number;
      scope: string | null; scope_value: string | null; source: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind as 'mark' | 'block',
    target: r.target as ActiveRule['target'],
    pattern: r.pattern,
    priority: r.priority,
    scope: (r.scope === 'asset_type' || r.scope === 'asset' ? r.scope : 'global') as ActiveRule['scope'],
    scopeValue: parseScopeValue(r.scope_value),
    source: (r.source === 'admin' || r.source === 'owner' ? r.source : 'builtin') as ActiveRule['source'],
  }));
}

/** scope_value 存的是 JSON 数组文本；解析失败按"无作用目标"处理（不会命中任何资产） */
function parseScopeValue(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/** 作用域判定：这条规则是否对这一资产生效 */
function inScope(rule: ActiveRule, input: RuleInput): boolean {
  const scope = rule.scope ?? 'global';
  if (scope === 'global') return true;
  const targets = rule.scopeValue ?? [];
  if (scope === 'asset_type') return targets.includes(input.assetType);
  // scope === 'asset'：需要知道具体资产；调用方未提供 assetId 时一律不命中（宁可漏拦也不误拦）
  return input.assetId !== undefined && targets.includes(input.assetId);
}

/** 返回 block 或 mark（若两者都命中，block 优先-§5.8 先 block 后 mark） */
export function evaluateRules(rules: ActiveRule[], input: RuleInput): RuleHit | null {
  let bestBlock: activeHits = null;
  let bestMark: activeHits = null;
  for (const rule of rules) {
    if (!inScope(rule, input)) continue;
    if (!matches(rule, input)) continue;
    if (rule.kind === 'block' && (bestBlock === null || rule.priority > bestBlock.priority)) {
      bestBlock = rule;
    } else if (rule.kind === 'mark' && (bestMark === null || rule.priority > bestMark.priority)) {
      bestMark = rule;
    }
  }
  if (bestBlock) return { kind: 'block', ruleId: bestBlock.id, ruleName: bestBlock.name };
  if (bestMark) return { kind: 'mark', ruleId: bestMark.id, ruleName: bestMark.name };
  return null;
}

type activeHits = ActiveRule | null;

function patternOf(rule: ActiveRule): RegExp {
  // pattern 为 DB 文本；编译失败按不匹配处理（无回溯校验由写入侧 safe-regex2 把关——T8）
  try {
    return new RegExp(rule.pattern, 'i');
  } catch {
    return /$^/; // 永不匹配
  }
}

function matches(rule: ActiveRule, input: RuleInput): boolean {
  const re = patternOf(rule);
  switch (rule.target) {
    case 'tool':
      return re.test(input.tool);
    case 'asset_type':
      return re.test(input.assetType);
    case 'group':
      return (input.groups ?? []).some((g) => re.test(g));
    case 'arg': {
      const values = stringValues(input.args);
      return values.some((v) => re.test(v));
    }
    case 'body':
      // 只匹配参数值的老规则会漏掉"键名就是攻击面"的情况（queryBody / url / header 名）。
      // body 看整份序列化文本：范围更大，但也更吵——所以它是一条**独立维度**而不是把 arg 放宽，
      // 管理员能明确选择"只匹配值"还是"连键名一起匹配"。
      return re.test(bodyText(input.args));
  }
  return false;
}

/** 请求体文本：JSON 序列化（失败时退化为 String），供 body 维度匹配 */
function bodyText(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

/** 递归取所有字符串值（嵌套对象与数组展开；只取值，不含键名——这是 arg 与 body 的边界） */
function stringValues(value: unknown, out: string[] = [], depth = 0): string[] {
  // 深度上限防环/防超深（参数本就来自 JSON，正常不会成环；保险起见不无限递归）
  if (depth > 12) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) stringValues(item, out, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) stringValues(v, out, depth + 1);
  }
  return out;
}
