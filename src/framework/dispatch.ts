/**
 * 原生工具 dispatch 编排（§5.9.3 框架承担全部横切；顺序与 §5.8 / §6 约束 2 一致）：
 * 解析 asset → can('invoke')（T8 单一真值源，调用点已就位）→ guard_rules（block 先 mark 后）
 * → write-ahead intent（block 命中写 status='blocked'；审计不可用 → -32003 且不执行下游）
 * → connector.acquire → execute → 截断/脱敏 → 回填 → release。
 * 工具自己严禁实现这些（ESLint 强制，见 eslint.config.js）。
 */
import { ERROR_CODES } from '../config/constants.js';
import type { AssetView, CallerPrincipal, NativeToolDefinition, NativeToolContext } from './types.js';
import { CONNECTOR_REGISTRY } from '../native/connectors/index.js';
import type { ResolvedCredential } from '../services/credentials.js';

/** principal 是 unknown（传输层各自形状）——统一收敛成框架/connector 认识的形状 */
function principalObject(principal: unknown): CallerPrincipal | undefined {
  if (typeof principal !== 'object' || principal === null) return undefined;
  const p = principal as { userId?: unknown; isAdmin?: unknown };
  if (typeof p.userId !== 'string') return undefined;
  return { userId: p.userId, isAdmin: p.isAdmin === true };
}

export interface GuardHit {
  kind: 'block' | 'mark';
  ruleId: string;
  ruleName: string;
}

export interface DispatchServices {
  /** 解析 asset 引用（id 或 name）→ 资产视图；不存在/无权 → null（框架统一回 -32006，防探测） */
  resolveAsset(ref: string, principal: unknown): Promise<AssetView | null>;
  /** T8 实现：can('invoke')，全项目唯一授权真值源（ADR-013） */
  canInvoke(asset: AssetView, principal: unknown): Promise<boolean>;
  /** T8 实现：guard_rules 评估（先 block 后 mark，命中取最高 priority；assetId 用于 group 目标匹配） */
  evaluateRules(input: { tool: string; args: Record<string, unknown>; assetType: string; assetId?: string }): Promise<GuardHit | null>;
  /** T8 实现：write-ahead intent；抛错 = 审计不可用（调用方返回 -32003） */
  writeAuditIntent(entry: {
    principal: unknown;
    asset: AssetView;
    tool: string;
    args: Record<string, unknown>;
    risk: 'normal' | 'high';
    status: 'pending' | 'blocked';
    audit: NativeToolDefinition['audit'];
  }): Promise<{ intentId: string }>;
  /** T8 实现：回填（status/output 等）；失败保持 pending（reconciler 兜底） */
  fillAudit(intentId: string, result: { status: string; output?: string; errorMessage?: string; durationMs?: number }): Promise<void>;
  /** 按槽位名取解密凭证值（T8/§5.6 注入点第五类 ssh2）。
   *  `userId` 传入时按 personal → asset 取值（ADR-028）；`credentialId` 指定优先凭证。 */
  resolveCredentials(
    asset: AssetView,
    slotNames: string[],
    userId?: string,
    credentialId?: string | null,
  ): Promise<Record<string, string>>;
  /** 按资产 id 解析绑定凭证（ResolvedCredential 形状，含 credentialId/updatedAtMs；未绑定的槽位不出现）——聚合层复用 */
  resolveSlotValues(assetId: string, slotNames: string[], userId?: string): ResolvedCredential[];
  /** ref.<凭证名>.<键名> 按名取键值（无值返回 null，调用方 fail-closed）——一个凭证可服务多个资产 */
  resolveRefValue(refName: string, key: string): string | null;
  /** T8 实现：输出脱敏 + 截断 */
  redact(value: unknown): unknown;
  truncate(value: string, bytes: number): string;
  /** 原始异常 → 明确错误码 + message（-32002 连接忙等） */
  normalizeError(err: unknown): { code: number; message: string };
  /** 输出截断字节数（取自 settings，T8 接入） */
  outputTruncateBytes: number;
  /** L1 设置读取（经框架注入 ctx.settings） */
  getSetting<T>(key: string): T;
}

export interface DispatchOutcome {
  ok: boolean;
  code?: number;
  message?: string;
  data?: unknown;
  /** block 命中时返回（不含 pattern，§5 错误码 -32004） */
  rule?: { ruleId: string; ruleName: string };
  intentId?: string;
}

export async function dispatchNativeTool(
  tool: NativeToolDefinition,
  args: Record<string, unknown>,
  principal: unknown,
  services: DispatchServices,
): Promise<DispatchOutcome> {
  // 1. asset 参数由框架注入并解析——工具 inputSchema 里不得出现（R：JSON Schema 校验器保证）
  const assetRef = args.asset;
  if (typeof assetRef !== 'string' || assetRef.trim() === '') {
    return { ok: false, code: ERROR_CODES.assetNotFoundOrDenied, message: 'asset 参数缺失或非法（取值来自 opsgate_list_assets）' };
  }
  const asset = await services.resolveAsset(assetRef, principal);
  if (!asset) {
    // 存在但无权 与 根本不存在 返回完全一致（防探测，AC-35）
    return { ok: false, code: ERROR_CODES.assetNotFoundOrDenied, message: '资产不存在或无权访问' };
  }

  // 2. can('invoke')（T8 落地；评估前不执行任何下游）
  const allowed = await services.canInvoke(asset, principal);
  if (!allowed) {
    return { ok: false, code: ERROR_CODES.assetNotFoundOrDenied, message: '资产不存在或无权访问' };
  }

  // 3. guard_rules：先 block 后 mark（§5.8；assetId 用于 group 目标）
  const ruleName = `native:${tool.id}`;
  const hit = await services.evaluateRules({
    tool: ruleName,
    args,
    assetType: asset.category,
    assetId: asset.id,
  });

  // 4. write-ahead intent（block 命中写 status='blocked'；§6 约束 2：失败 → -32003 且不执行任何下游）
  const risk: 'normal' | 'high' = hit?.kind === 'mark' ? 'high' : 'normal';
  let intent: { intentId: string };
  try {
    intent = await services.writeAuditIntent({
      principal,
      asset,
      tool: ruleName,
      args,
      risk,
      status: hit?.kind === 'block' ? 'blocked' : 'pending',
      audit: tool.audit,
    });
  } catch {
    return { ok: false, code: ERROR_CODES.auditUnavailable, message: 'Audit unavailable; call refused' };
  }

  if (hit?.kind === 'block') {
    // -32004：不得 acquire 连接（§5.9.3）
    return { ok: false, code: ERROR_CODES.ruleBlocked, message: `被规则拦截: ${hit.ruleName}`, rule: { ruleId: hit.ruleId, ruleName: hit.ruleName }, intentId: intent.intentId };
  }

  // 5. 凭证与连接（按注册表取 connector；异常映射 -32002）
  const connectorDef = CONNECTOR_REGISTRY.get(tool.connector);
  if (!connectorDef) {
    return { ok: false, code: 500, message: `connector ${tool.connector} 未注册（启动应已失败）` };
  }
  // 调用者必须一路传到 acquire：SSH 的账号/密钥随调用者变化（ADR-028 personal 优先），
  // 若在此丢掉 principal，成员自绑的个人凭证永远不会被使用，一律落到归属人的共享凭证上。
  const caller = principalObject(principal);
  let handle: unknown;
  try {
    const slotNames = toolCredentialSlots(tool, asset);
    const credentials = await services.resolveCredentials(asset, slotNames, caller?.userId);
    handle = await connectorDef.acquire(asset, slotNames[0] ?? '', caller);
    return await executeWithFill(
      tool,
      args,
      principal,
      services,
      asset,
      connectorDef,
      handle,
      intent.intentId,
      credentials,
    );
  } catch (err) {
    const normalized = services.normalizeError(err);
    return { ok: false, code: normalized.code, message: normalized.message };
  } finally {
    if (handle !== undefined) connectorDef.release(handle);
  }
}

async function executeWithFill(
  tool: NativeToolDefinition,
  args: Record<string, unknown>,
  principal: unknown,
  services: DispatchServices,
  asset: AssetView,
  connector: { type: string },
  handle: unknown,
  intentId: string,
  credentials: Record<string, string>,
): Promise<DispatchOutcome> {
  const ctx: NativeToolContext & { handle: unknown } = {
    asset,
    handle,
    credentials,
    principal: principalObject(principal),
    settings: { get: services.getSetting },
  };
  const t0 = Date.now();
  try {
    const result = await tool.execute(ctx, args);
    const summary = JSON.stringify(services.redact(result.meta ?? null)).slice(0, services.outputTruncateBytes);
    await services.fillAudit(intentId, { status: 'success', output: summary, durationMs: Date.now() - t0 });
    return {
      ok: true,
      data: { content: services.redact(result.content), meta: result.meta },
      intentId,
    };
  } catch (err) {
    const normalized = services.normalizeError(err);
    await services.fillAudit(intentId, {
      status: 'error',
      errorMessage: normalized.message.slice(0, services.outputTruncateBytes),
      durationMs: Date.now() - t0,
    });
    return { ok: false, code: normalized.code, message: normalized.message, intentId };
  }
}

/** 从 audit 声明 + slot 绑定推出需要解密的槽位名（不在此解，T8 resolveCredentials 做） */
function toolCredentialSlots(tool: NativeToolDefinition, asset: AssetView): string[] {
  const slots = new Set<string>();
  for (const s of asset.credentialSlots) slots.add(s.name);
  return [...slots];
}
