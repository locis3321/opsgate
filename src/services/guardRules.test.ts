import { describe, expect, it } from 'vitest';
import { evaluateRules, type ActiveRule } from './guardRules.js';

const base: ActiveRule = {
  id: 'r1',
  name: 'mysql-only',
  kind: 'block',
  target: 'asset_type',
  pattern: '^mysql$',
  priority: 10,
};

describe('guard_rules 作用范围（asset_type / group）', () => {
  it('asset_type 只命中所选资产类型', () => {
    const rules: ActiveRule[] = [base];
    expect(evaluateRules(rules, { tool: 'x', args: {}, assetType: 'mysql' })?.ruleId).toBe('r1');
    expect(evaluateRules(rules, { tool: 'x', args: {}, assetType: 'host' })).toBeNull();
  });

  it('group 只命中资产所属分组', () => {
    const rules: ActiveRule[] = [{ ...base, target: 'group', pattern: '^prod$' }];
    expect(evaluateRules(rules, { tool: 'x', args: {}, assetType: 'mysql', groups: ['prod'] })?.kind).toBe('block');
    expect(evaluateRules(rules, { tool: 'x', args: {}, assetType: 'mysql', groups: ['dev'] })).toBeNull();
  });

  it('先 block 后 mark；多条命中取 priority 最高', () => {
    const rules: ActiveRule[] = [
      { ...base, id: 'mark1', kind: 'mark', target: 'arg', pattern: 'DROP', priority: 1 },
      { ...base, id: 'block1', kind: 'block', target: 'arg', pattern: 'DROP', priority: 2 },
    ];
    expect(evaluateRules(rules, { tool: 'x', args: { sql: 'DROP TABLE t' }, assetType: 'mysql' })?.ruleId).toBe('block1');
  });
});

describe('guard_rules 匹配维度：arg 覆盖嵌套值、body 覆盖完整请求体', () => {
  it('arg 递归匹配嵌套对象与数组里的字符串值', () => {
    const rules: ActiveRule[] = [{ ...base, target: 'arg', pattern: '^DROP TABLE users$' }];
    const args = { query: { statements: [{ sql: 'DROP TABLE users' }] } };
    expect(evaluateRules(rules, { tool: 'x', args, assetType: 'mysql' })?.ruleId).toBe('r1');
  });

  it('body 匹配完整请求体文本（含键名，arg 看不到的部分）', () => {
    const rules: ActiveRule[] = [{ ...base, target: 'body', pattern: '"queryBody"' }];
    const args = { queryBody: { size: 5 } };
    expect(evaluateRules(rules, { tool: 'x', args, assetType: 'other' })?.ruleId).toBe('r1');
  });

  it('body 同时覆盖 key 与 value，嵌套层级不影响命中', () => {
    const rules: ActiveRule[] = [{ ...base, target: 'body', pattern: '169\\.254\\.169\\.254' }];
    const args = { body: { nested: { url: 'http://169.254.169.254/latest' } } };
    expect(evaluateRules(rules, { tool: 'x', args, assetType: 'other' })?.ruleId).toBe('r1');
  });

  it('arg 不命中键名（与 body 的边界必须可区分）', () => {
    const rules: ActiveRule[] = [{ ...base, target: 'arg', pattern: '"queryBody"' }];
    const args = { queryBody: { size: 5 } };
    expect(evaluateRules(rules, { tool: 'x', args, assetType: 'other' })).toBeNull();
  });
});
