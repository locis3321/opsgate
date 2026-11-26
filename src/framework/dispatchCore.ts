/**
 * 执行门禁核心（native 与 cli 共用）：
 * resolveAsset → canInvoke → evaluateRules → writeAuditIntent → exec → fillAudit。
 * derived 路径暂保留自身实现（会话快照 + 不同 audit 形状），由契约测试守住其规则覆盖。
 */
import { ERROR_CODES } from '../config/constants.js';
import type { AssetView, AuditSpec, ExecutionMode } from './types.js';
import type { DispatchServices } from './dispatch.js';

export interface GuardedExecInput {
  assetRef: string;
  /** 完整规则名，如 native:host.execute_command / cli:<id>:k8s_run */
  toolName: string;
  args: Record<string, unknown>;
  baseRisk: 'normal' | 'high';
  audit: AuditSpec;
  /** 传入时覆盖 asset 解析结果（derived/cli 可能有会话快照） */
  resolveAsset?: (ref: string) => Promise<AssetView | null>;
  /**
   * 本执行路径明确不接受的执行方式（解析出 asset 后判定，命中即拒）。
   *
   * 存在的理由：执行方式决定"谁能碰这台资产"，而工具族是按品类组织的，两者并不绑定。
   * 原生路径（dispatchNativeTool）必须传 ['cli']——否则一个 category=redis 的 CLI 资产
   * 可以借同品类原生工具 redis_command 走进程内连接执行，绕过"CLI 只能跑它自己配置的
   * 那个二进制"这条边界（越权）。判定必须落在**执行路径**上，不能只靠 tools/list 过滤：
   * 元工具 opsgate_invoke / 旧会话快照都能绕过发现阶段的过滤。
   */
  rejectExecutionModes?: readonly ExecutionMode[];
}

export interface GuardedExecResult {
  content: unknown;
  meta?: Record<string, unknown>;
  /** 执行耗时（仅 exec 本身，不含凭证解析/连接建立）——由回调自行计时，缺省则仅统计 exec 块 */
  durationMs?: number;
}

export interface GuardedExecOutcome {
  ok: boolean;
  code?: number;
  message?: string;
  data?: unknown;
  /** block 命中时返回（不含 pattern，§5 错误码 -32004） */
  rule?: { ruleId: string; ruleName: string };
  intentId?: string;
}

export async function runGuarded(
  input: GuardedExecInput,
  principal: unknown,
  services: DispatchServices,
  exec: (asset: AssetView) => Promise<GuardedExecResult>,
): Promise<GuardedExecOutcome> {
  const ref = input.assetRef;
  // 1. asset 参数由框架注入并解析——工具 inputSchema 里不得出现
  if (typeof ref !== 'string' || ref.trim() === '') {
    return { ok: false, code: ERROR_CODES.assetNotFoundOrDenied, message: 'asset 参数缺失或非法（取值来自 opsgate_list_assets）' };
  }
  const asset = input.resolveAsset
    ? await input.resolveAsset(ref)
    : await services.resolveAsset(ref, principal);
  // 存在但无权 与 根本不存在 返回完全一致（防探测，AC-35）
  if (!asset) return { ok: false, code: ERROR_CODES.assetNotFoundOrDenied, message: '资产不存在或无权访问' };

  // 2. can('invoke')（单一真值源；评估前不执行任何下游）
  if (!(await services.canInvoke(asset, principal))) {
    return { ok: false, code: ERROR_CODES.assetNotFoundOrDenied, message: '资产不存在或无权访问' };
  }

  // 2.5 执行方式闸门：判定放在授权之后，无权者仍只看到统一的 -32006，不泄露"这台是 CLI 资产"。
  // 放在审计与规则之前：这不是"用户发起的调用"，而是执行路径与资产类型不匹配，不应留下 tool_call 记录。
  if (input.rejectExecutionModes?.includes(asset.executionMode)) {
    return {
      ok: false,
      code: ERROR_CODES.assetNotFoundOrDenied,
      message: `该资产执行方式为 ${asset.executionMode}，不支持本工具族调用（CLI 资产只能用其配置的二进制运行）`,
    };
  }

  // 3. guard_rules：先 block 后 mark（§5.8；assetId 用于 group 目标）
  const hit = await services.evaluateRules({
    tool: input.toolName,
    args: input.args,
    assetType: asset.category,
    assetId: asset.id,
  });
  const risk: 'normal' | 'high' = hit?.kind === 'mark' ? 'high' : input.baseRisk;

  // 4. write-ahead intent（block 命中写 status='blocked'；§6 约束 2：失败 → -32003 且不执行任何下游）
  let intent: { intentId: string };
  try {
    intent = await services.writeAuditIntent({
      principal,
      asset,
      tool: input.toolName,
      args: input.args,
      risk,
      status: hit?.kind === 'block' ? 'blocked' : 'pending',
      audit: input.audit,
    });
  } catch {
    return { ok: false, code: ERROR_CODES.auditUnavailable, message: 'Audit unavailable; call refused' };
  }

  if (hit?.kind === 'block') {
    // -32004：不得 acquire 连接（§5.9.3）
    return {
      ok: false,
      code: ERROR_CODES.ruleBlocked,
      message: `被规则拦截: ${hit.ruleName}`,
      rule: { ruleId: hit.ruleId, ruleName: hit.ruleName },
      intentId: intent.intentId,
    };
  }

  // 5. 执行 + 回填。整个执行与结果处理都在 try 内：redact/JSON 抛错也走统一错误映射，不逃逸。
  // durationMs 优先用回调自报（仅 exec 本身），否则退回 exec 块墙钟。
  const t0 = Date.now();
  try {
    const result = await exec(asset);
    const durationMs = result.durationMs ?? Date.now() - t0;
    const summary = JSON.stringify(services.redact(result.meta ?? null)).slice(0, services.outputTruncateBytes);
    const content = services.redact(result.content);
    // 回填失败不得逃逸：保持 pending 交由 reconciler 兜底（原实现的合同）
    await services.fillAudit(intent.intentId, { status: 'success', output: summary, durationMs }).catch(() => undefined);
    return { ok: true, data: { content, meta: result.meta }, intentId: intent.intentId };
  } catch (err) {
    const normalized = services.normalizeError(err);
    await services
      .fillAudit(intent.intentId, {
        status: 'error',
        errorMessage: normalized.message.slice(0, services.outputTruncateBytes),
        durationMs: Date.now() - t0,
      })
      .catch(() => undefined);
    return { ok: false, code: normalized.code, message: normalized.message, intentId: intent.intentId };
  }
}
