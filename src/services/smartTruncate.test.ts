/**
 * 描述智能截断（按句子边界）回归。
 * 为什么要有：社区工具描述硬切字符会切出半个单词（"…可传 creden…"），降低 LLM 理解质量。
 */
import { describe, expect, it } from 'vitest';
import { smartTruncate } from './toolAggregation.js';

describe('smartTruncate', () => {
  it('未超限时原样返回', () => {
    expect(smartTruncate('short text', 200)).toBe('short text');
  });

  it('英文优先在句末标点处断开', () => {
    const t = 'List all the Kubernetes pods in the current cluster. Use when you need to inspect workload health across namespaces quickly and reliably.';
    const r = smartTruncate(t, 60);
    expect(r.length).toBeLessThanOrEqual(60);
    expect(r.endsWith('…')).toBe(true);
    expect(r).toContain('cluster');
    expect(r).not.toContain('quickly');
  });

  it('中文优先在句号处断开', () => {
    const t = '列出当前集群的全部 Pod。当需要排查工作负载健康状态时使用。不要编造资产名称。';
    const r = smartTruncate(t, 20);
    expect(r.length).toBeLessThanOrEqual(20);
    expect(r.endsWith('…')).toBe(true);
    expect(r).toContain('Pod');
  });

  it('无句末标点时退化为词边界，避免半个单词', () => {
    const t = 'kubernetes configuration_contexts_list retrieves all available context names and associated server urls from the kubeconfig file';
    const r = smartTruncate(t, 50);
    expect(r.length).toBeLessThanOrEqual(50);
    const body = r.replace(/…$/, '');
    // 省略号前应是完整单词（不以单词中段收尾）
    expect(/\s\S+$/.test(body)).toBe(true);
  });

  it('任意上限下结果都不超长（含极小上限）', () => {
    const long = 'x'.repeat(500);
    for (const max of [5, 10, 20, 80, 200]) {
      expect(smartTruncate(long, max).length).toBeLessThanOrEqual(max);
    }
  });
});
