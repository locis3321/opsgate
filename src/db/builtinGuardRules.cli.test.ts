/**
 * 内置 CLI 危险命令规则（Task 5）。
 *
 * 关键前提：`guard_rules` 的 arg 维度是**逐元素**匹配——`stringValues()` 把每个字符串单独
 * 放进数组，再对每个元素跑正则（`src/services/guardRules.ts`）。所以 argv=["get","secret"]
 * 永远不会出现 "get secret" 这样的整串，规则只能锚定单个 token。
 * 本测试因此只覆盖单 token 命中场景，不写 "get secret" 组合用例。
 */
import safe from 'safe-regex2';
import { describe, expect, it } from 'vitest';
import { BUILTIN_GUARD_RULES } from './builtinGuardRules.js';

const argRules = () => BUILTIN_GUARD_RULES.filter((r) => r.target === 'arg');

/** 与生产同口径：每个 argv 元素单独匹配（不是整串拼接） */
function hits(argv: string[]): string[] {
  return argRules()
    .filter((r) => {
      const re = new RegExp(r.pattern, 'i');
      return argv.some((a) => re.test(a));
    })
    .map((r) => r.id);
}

const CLI_RULE_IDS = [
  'gr-mark-cli-flush',
  'gr-mark-cli-scale-zero',
  'gr-mark-cli-uninstall',
  'gr-mark-cli-recursive-rm',
  'gr-mark-cli-secret-dump',
];

describe('CLI 危险命令内置规则', () => {
  it('只读命令与近邻负例不命中', () => {
    expect(hits(['get', 'pods'])).toHaveLength(0);
    expect(hits(['info'])).toHaveLength(0);
    expect(hits(['scale', 'deploy', 'web', '--replicas=3'])).toHaveLength(0); // 正常扩容不误报
    expect(hits(['scale', 'deploy', 'web', '--replicas=10'])).toHaveLength(0);
    expect(hits(['grep', '-r', 'pattern', '.'])).toHaveLength(0); // 裸 -r 不误报（收窄后）
    expect(hits(['ls', '-R'])).toHaveLength(0); // 裸 -R 不误报
  });

  it('FLUSHALL / FLUSHDB 精确命中 gr-mark-cli-flush', () => {
    expect(hits(['FLUSHALL'])).toContain('gr-mark-cli-flush');
    expect(hits(['flushdb'])).toContain('gr-mark-cli-flush');
  });

  it('--replicas=0 精确命中 gr-mark-cli-scale-zero', () => {
    expect(hits(['scale', 'deploy', 'web', '--replicas=0'])).toContain('gr-mark-cli-scale-zero');
  });

  it('uninstall 精确命中 gr-mark-cli-uninstall', () => {
    expect(hits(['uninstall', 'rel'])).toContain('gr-mark-cli-uninstall');
  });

  it('--recursive / -rf 精确命中 gr-mark-cli-recursive-rm', () => {
    expect(hits(['rm', '--recursive', 'b'])).toContain('gr-mark-cli-recursive-rm');
    expect(hits(['rm', '-rf', '/tmp/x'])).toContain('gr-mark-cli-recursive-rm');
  });

  it('secret / secrets 单 token 精确命中 gr-mark-cli-secret-dump', () => {
    expect(hits(['get', 'secret'])).toContain('gr-mark-cli-secret-dump');
    expect(hits(['get', 'secrets', '-A'])).toContain('gr-mark-cli-secret-dump');
  });

  it('DROP TABLE 命中（SQL 串整体作为一个 token，由 gr-mark-sql-write 覆盖）', () => {
    expect(hits(['-e', 'DROP TABLE users'])).toContain('gr-mark-sql-write');
  });

  it('5 条 CLI 规则的 pattern 通过 safe-regex2（无 ReDoS 风险）', () => {
    for (const id of CLI_RULE_IDS) {
      const rule = BUILTIN_GUARD_RULES.find((r) => r.id === id);
      expect(rule, `缺少内置规则 ${id}`).toBeDefined();
      expect(rule!.kind).toBe('mark');
      expect(rule!.target).toBe('arg');
      expect(safe(rule!.pattern)).toBe(true);
    }
  });
});
