/**
 * 守门测试：mcpEndpoint 的每个执行分支都必须经过 evaluateRules。
 * 新增执行分支若忘了接规则，这里失败（ADR-037：derived 路径保留自身实现，用测试守全覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('callTool 执行分支规则覆盖', () => {
  const src = readFileSync(fileURLToPath(new URL('../services/mcpEndpoint.ts', import.meta.url)), 'utf8');
  const dispatchSrc = readFileSync(fileURLToPath(new URL('./dispatch.ts', import.meta.url)), 'utf8');

  it('invokeOnAsset 内 native 分支走 dispatchNativeTool，且 native 委托 runGuarded（门禁唯一实现）', () => {
    expect(src).toContain('dispatchNativeTool(');
    expect(dispatchSrc).toContain('runGuarded(');
    // 原生工具不得自行拼规则/审计：dispatch.ts 内不应再出现对 services.evaluateRules 的调用
    //（DispatchServices 上的类型声明不算调用，故匹配点号调用形式）
    expect(dispatchSrc).not.toContain('services.evaluateRules(');
  });

  it('dispatchDerived 内调用 evaluateRules，且早于实例池 acquire / callTool', () => {
    const idx = src.indexOf('private async dispatchDerived');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx);
    const ruleAt = body.indexOf('evaluateRules(');
    expect(ruleAt).toBeGreaterThan(-1);
    // 规则必须在执行前：否则等于放行后再拦
    expect(ruleAt).toBeLessThan(body.indexOf('pool.acquire('));
    expect(ruleAt).toBeLessThan(body.indexOf('callTool('));
  });
});
