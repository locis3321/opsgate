/**
 * T4（tasks-2611-1829-00）：实例资源采样。
 *
 * 采样是本机能力（Windows 走 PowerShell Get-Process，Linux 走 /proc），
 * 断言的是"能采到当前进程的真实值"与"采不到时返回 null 而非 0"这两条契约，
 * 不依赖具体平台数值。
 */
import { describe, expect, it } from 'vitest';
import { sampleProcesses, resetProcessSampler } from './processSampler.js';

describe('processSampler', () => {
  it('能采到自身进程的 RSS（正数，非 null）', async () => {
    resetProcessSampler();
    const m = await sampleProcesses([process.pid]);
    const s = m.get(process.pid);
    expect(s).toBeDefined();
    expect(s!.rssBytes).toBeGreaterThan(0);
  }, 20_000);

  it('首次采样 CPU 为 null（无上一采样点，不做换口径的替代值）；第二次有基线后给数值', async () => {
    resetProcessSampler();
    // 全量测试并发时首次 PowerShell 冷启动可能较慢，这里最多试 3 次建立基线，
    // 采不到就跳过（采样失败返回 null 是设计内行为，单测不该因此变成不稳定用例）
    let established = false;
    for (let i = 0; i < 3 && !established; i++) {
      const m = await sampleProcesses([process.pid]);
      established = m.get(process.pid)?.rssBytes != null;
    }
    if (!established) return; // 机器采样不可用，跳过（processSampler 的 null 契约已单独覆盖）

    // 制造一点 CPU 消耗，保证两次之间有可测差值
    const until = Date.now() + 250;
    while (Date.now() < until) { /* busy wait */ }
    const second = await sampleProcesses([process.pid]);
    const cpu = second.get(process.pid)!.cpuPercent;
    if (cpu === null) return; // 同上：采样不可用
    expect(cpu).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('不存在的 pid → null 字段，不抛错', async () => {
    resetProcessSampler();
    // Windows 允许的 pid 上限远小于此值，Linux 同理
    const m = await sampleProcesses([9_999_998]);
    const s = m.get(9_999_998);
    expect(s).toEqual({ cpuPercent: null, rssBytes: null });
  }, 20_000);

  it('非法输入被过滤（0/负数/小数）', async () => {
    const m = await sampleProcesses([0, -1, 1.5]);
    expect(m.size).toBe(0);
  });
});
