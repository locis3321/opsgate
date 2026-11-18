/**
 * 工具暴露契约的单元回归（ADR-032 附带的缺陷修复）。
 *
 * 三个缺陷各自独立、都会让 agent「拿到一个用不了的工具」：
 *  D1 schema 裁剪后 required 指向不存在的参数 → 严格客户端直接拒绝调用；
 *  P1 原生与派生工具同名并存 → 违反 MCP 工具名唯一性；
 *  D3 品类白名单硬编码 → 新品类只能从分组入口连，而分组入口先撞工具数上限。
 */
import { describe, expect, it } from 'vitest';
import { pruneDerivedSchema, dedupeToolName } from './services/toolAggregation.js';

describe('D1 pruneDerivedSchema：required 只保留仍然存在的参数', () => {
  it('连接参数被剔除后，required 里的同名项一并剔除', () => {
    const out = pruneDerivedSchema({
      type: 'object',
      properties: {
        endPoint: { type: 'string', description: 'MinIO服务器地址' },
        port: { type: 'number', description: '端口' },
        bucket: { type: 'string', description: '桶名' },
      },
      required: ['endPoint', 'port', 'bucket'],
    });
    expect(Object.keys(out.properties as object)).toEqual(['endPoint', 'bucket']);
    expect(out.required).toEqual(['endPoint', 'bucket']);
  });

  it('占位符参数（${VAR}）被剔除后，required 里也不留', () => {
    const out = pruneDerivedSchema({
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标地址 ${TARGET_URL}' },
        name: { type: 'string', description: '名称' },
      },
      required: ['url', 'name'],
    });
    expect(out.required).toEqual(['name']);
  });

  it('没有 required 时不凭空造一个', () => {
    const out = pruneDerivedSchema({ type: 'object', properties: { a: { type: 'string', description: 'x' } } });
    expect(out.required).toBeUndefined();
  });
});

describe('P1 dedupeToolName：原生与派生同名只留一份', () => {
  it('首次出现 → kept；同名再次出现 → dropped 并给出原因', () => {
    const seen = new Map<string, string>();
    expect(dedupeToolName(seen, 'host_execute_command', 'opsgate')).toEqual({ action: 'kept' });
    const dup = dedupeToolName(seen, 'host_execute_command', 'mcp_server_ssh');
    expect(dup.action).toBe('dropped');
    if (dup.action !== 'dropped') throw new Error('unreachable');
    expect(dup.reason).toContain('host_execute_command');
    expect(dup.reason).toContain('opsgate');
  });

  it('不同名互不影响', () => {
    const seen = new Map<string, string>();
    dedupeToolName(seen, 'a_tool', 'opsgate');
    expect(dedupeToolName(seen, 'b_tool', 'opsgate').action).toBe('kept');
  });
});
