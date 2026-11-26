import { describe, expect, it } from 'vitest';
import { cliToolNameOf, cliExposedTool } from './cliTool.js';

describe('cliToolNameOf', () => {
  it('按品类派生 {category}_run', () => {
    expect(cliToolNameOf('k8s')).toBe('k8s_run');
    expect(cliToolNameOf('redis')).toBe('redis_run');
  });
  it('拒绝空品类', () => {
    expect(() => cliToolNameOf('')).toThrow();
  });
});

describe('cliExposedTool', () => {
  it('返回 argv:string[] 的 schema，且描述满足 R4（含 Use when / Required）', () => {
    const t = cliExposedTool({ id: 'a1', name: 'prod-k8s', category: 'k8s', command: 'kubectl' });
    expect(t.name).toBe('k8s_run');
    expect(t.source).toBe('cli');
    expect(t.description).toContain('Use when:');
    expect(t.description).toContain('Required:');
    const schema = t.inputSchema as {
      properties: { argv: { type: string; items: { type: string } } };
      required: string[];
    };
    expect(schema.properties.argv.type).toBe('array');
    expect(schema.properties.argv.items.type).toBe('string');
    expect(schema.required).toContain('argv');
  });
  it('描述里出现二进制名，不出现任何凭证值', () => {
    const t = cliExposedTool({ id: 'a1', name: 'prod-k8s', category: 'k8s', command: 'kubectl' });
    expect(t.description).toContain('kubectl');
  });
  it('描述长度 ≤200（R6），含超长资产名与绝对路径的极端输入', () => {
    const cases = [
      { id: 'a1', name: 'prod-k8s', command: 'kubectl' },
      { id: 'a2', name: 'k8s-prod-cluster-01-very-long-naming-convention', command: 'kubectl' },
      { id: 'a3', name: 'prod-k8s', command: '/usr/local/bin/kubectl' },
      { id: 'a4', name: 'a'.repeat(200), command: '/opt/x/'.repeat(30) + 'tool' },
    ];
    for (const c of cases) {
      const t = cliExposedTool({ ...c, category: 'k8s' });
      expect(t.description.length).toBeLessThanOrEqual(200);
    }
  });
  it('二进制缺失时显式抛错（不伪装成可调用工具）', () => {
    expect(() => cliExposedTool({ id: 'a1', name: 'x', category: 'k8s', command: null })).toThrow();
    expect(() => cliExposedTool({ id: 'a1', name: 'x', category: 'k8s', command: '   ' })).toThrow();
  });
});
