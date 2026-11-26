import { describe, expect, it, vi } from 'vitest';
import { runGuarded, type GuardedExecInput } from './dispatchCore.js';
import type { DispatchServices } from './dispatch.js';
import type { AssetView } from './types.js';

const asset: AssetView = {
  id: 'a1', name: 'n1', category: 'host', ownerId: 'u1', executionMode: 'native',
  credentialSlots: [], configHash: 'ch',
};

function svc(over: Partial<DispatchServices> = {}): DispatchServices {
  return {
    resolveAsset: async () => asset,
    canInvoke: async () => true,
    evaluateRules: async () => null,
    writeAuditIntent: async () => ({ intentId: 'i1' }),
    fillAudit: async () => {},
    resolveCredentials: async () => ({}),
    resolveSlotValues: () => [],
    resolveRefValue: () => null,
    redact: (v) => v,
    truncate: (s) => s,
    normalizeError: () => ({ code: -32002, message: 'err' }),
    outputTruncateBytes: 4096,
    getSetting: () => 0 as never,
    ...over,
  } as DispatchServices;
}

const base: GuardedExecInput = {
  assetRef: 'n1', toolName: 'native:x', args: {}, baseRisk: 'normal',
  audit: { fields: [] },
};

describe('runGuarded', () => {
  it('正常路径：exec 被调用一次并回填 success', async () => {
    const fillAudit = vi.fn(async () => {});
    const exec = vi.fn(async () => ({ content: { ok: 1 } }));
    const out = await runGuarded(base, { userId: 'u1' }, svc({ fillAudit }), exec);
    expect(out.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(fillAudit).toHaveBeenCalledWith('i1', expect.objectContaining({ status: 'success' }));
  });

  it('资产不存在 → -32006，exec 不被调用', async () => {
    const exec = vi.fn();
    const out = await runGuarded(base, { userId: 'u1' }, svc({ resolveAsset: async () => null }), exec);
    expect(out.code).toBe(-32006);
    expect(exec).not.toHaveBeenCalled();
  });

  it('无权 → -32006', async () => {
    const out = await runGuarded(base, { userId: 'u1' }, svc({ canInvoke: async () => false }), async () => ({ content: 1 }));
    expect(out.code).toBe(-32006);
  });

  it('规则 block → -32004，exec 不调用，intent 状态 blocked', async () => {
    const writeAuditIntent = vi.fn(async () => ({ intentId: 'i2' }));
    const exec = vi.fn();
    const out = await runGuarded(
      base,
      { userId: 'u1' },
      svc({ evaluateRules: async () => ({ kind: 'block', ruleId: 'r', ruleName: 'R' }), writeAuditIntent }),
      exec,
    );
    expect(out.code).toBe(-32004);
    expect(exec).not.toHaveBeenCalled();
    expect(writeAuditIntent).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }));
  });

  it('规则 mark → 审计 risk 升级 high', async () => {
    const writeAuditIntent = vi.fn(async () => ({ intentId: 'i3' }));
    await runGuarded(
      base,
      { userId: 'u1' },
      svc({ evaluateRules: async () => ({ kind: 'mark', ruleId: 'r', ruleName: 'R' }), writeAuditIntent }),
      async () => ({ content: 1 }),
    );
    expect(writeAuditIntent).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high' }));
  });

  it('审计不可用 → -32003，exec 不调用', async () => {
    const exec = vi.fn();
    const out = await runGuarded(
      base,
      { userId: 'u1' },
      svc({ writeAuditIntent: async () => { throw new Error('db down'); } }),
      exec,
    );
    expect(out.code).toBe(-32003);
    expect(exec).not.toHaveBeenCalled();
  });

  it('exec 抛错 → normalizeError 映射并回填 error', async () => {
    const fillAudit = vi.fn(async () => {});
    const out = await runGuarded(base, { userId: 'u1' }, svc({ fillAudit }), async () => { throw new Error('boom'); });
    expect(out.ok).toBe(false);
    expect(fillAudit).toHaveBeenCalledWith('i1', expect.objectContaining({ status: 'error' }));
  });

  it('rejectExecutionModes 命中 → -32006，且不写审计、不执行（越权闸门）', async () => {
    const writeAuditIntent = vi.fn(async () => ({ intentId: 'i9' }));
    const exec = vi.fn();
    const out = await runGuarded(
      { ...base, rejectExecutionModes: ['cli'] },
      { userId: 'u1' },
      svc({
        resolveAsset: async () => ({ ...asset, executionMode: 'cli' }),
        writeAuditIntent,
      }),
      exec,
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe(-32006);
    expect(exec).not.toHaveBeenCalled();
    expect(writeAuditIntent).not.toHaveBeenCalled();
  });

  it('rejectExecutionModes 未命中（资产是 native）→ 正常执行', async () => {
    const exec = vi.fn(async () => ({ content: 'ok' }));
    const out = await runGuarded({ ...base, rejectExecutionModes: ['cli'] }, { userId: 'u1' }, svc(), exec);
    expect(out.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
