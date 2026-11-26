/**
 * 内置安全策略播种的回归测试。
 *
 * 背景：生产部署只执行 migrate，不执行 `pnpm run seed`，导致部署机 guard_rules
 * 长期为 0 行、页面显示「暂无安全策略」。修复后由首启 bootstrap 一次性补种，
 * 并用数据目录下的标记文件保证：**管理员删光规则后重启不会被重新加回来**。
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_GUARD_RULES } from './db/builtinGuardRules.js';

describe('内置安全策略定义', () => {
  it('覆盖 4 条 block + 9 条 mark（§4.7 / §5.5.7 + ADR-037 CLI 危险命令）', () => {
    const blocks = BUILTIN_GUARD_RULES.filter((r) => r.kind === 'block');
    const marks = BUILTIN_GUARD_RULES.filter((r) => r.kind === 'mark');
    expect(blocks).toHaveLength(4); // §4.7 三条 + 敏感路径上传
    expect(marks).toHaveLength(9); // §4.7 三条 mark 中两条 + 落脚本 + 5 条 CLI 危险命令
    expect(BUILTIN_GUARD_RULES).toHaveLength(13);
  });

  it('id 唯一、priority 唯一且为正、正则可编译', () => {
    const ids = BUILTIN_GUARD_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prios = BUILTIN_GUARD_RULES.map((r) => r.priority);
    expect(new Set(prios).size).toBe(prios.length);
    for (const r of BUILTIN_GUARD_RULES) {
      expect(r.priority).toBeGreaterThan(0);
      expect(() => new RegExp(r.pattern)).not.toThrow();
    }
  });

  it('SSRF 元数据规则能命中 169.254.169.254、不误伤普通 IP', () => {
    const rule = BUILTIN_GUARD_RULES.find((r) => r.id === 'gr-block-ssrf-metadata')!;
    const re = new RegExp(rule.pattern);
    expect(re.test('http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(re.test('http://10.0.0.5:8080/api')).toBe(false);
  });
});
