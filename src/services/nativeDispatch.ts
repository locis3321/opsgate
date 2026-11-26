/**
 * 原生工具 dispatch 服务适配器（T5 落地；T8 将替换 canInvoke 为完整 can() 矩阵/单一真值源）：
 * resolveAsset / canInvoke（暂 owner|admin）/ guard_rules（块+mark）/ write-ahead 审计 /
 * 凭证解密注入 / 脱敏与截断 / 错误码映射 / L1 设置读取。
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Database } from 'better-sqlite3';
import * as schema from '../db/schema.js';
import type { Settings } from '../config/settings.js';
import { ERROR_CODES, parseRef } from '../config/constants.js';
import type { DispatchServices } from '../framework/dispatch.js';
import type { AssetView } from '../framework/types.js';
import { AuditService } from './audit.js';
import { canOnAsset } from './authzBuilder.js';
import { redactValue, truncateString } from './audit.js';
import { CredentialService, type ResolvedCredential } from './credentials.js';
import { evaluateRules, loadActiveRules } from './guardRules.js';
import { CliConfigError } from './cliRunner.js';
import { TransferLimitError, TransferTokenError, TransferSizeMismatchError } from './transfer.js';

export interface NativeDispatchDeps {
  sqlite: Database;
  db: BetterSQLite3Database<typeof schema>;
  settings: Settings;
  audit: AuditService;
  credentials: CredentialService;
}

export function makeNativeDispatchServices(deps: NativeDispatchDeps): DispatchServices {
  const { db, sqlite, settings, audit, credentials } = deps;

  /**
   * 解析槽位（不做缓存）：结果随"谁在调用"和"凭证是否刚被改绑"变化，
   * 缓存任一份都会让审计记错凭证或让新绑的凭证迟迟不生效。
   */
  function resolveSlots(asset: AssetView, slotNames: string[], userId?: string): ResolvedCredential[] {
    return credentials.resolveSlotValues(asset.id, slotNames, userId);
  }

  return {
    async resolveAsset(ref: string): Promise<AssetView | null> {
      const row = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.enabled, true))
        .all();
      const match = row.find((r) => r.id === ref || r.name === ref);
      if (!match) return null;
      return {
        id: match.id,
        name: match.name,
        category: match.category,
        ownerId: match.ownerId,
        // 不归一化：cli 归一成 native 会让下游（如 dispatch 的执行方式闸门）看不出这是 CLI 资产，
        // 等于让"同品类原生工具执行 CLI 资产"重新变得可能。
        executionMode: match.executionMode === 'mcp' ? 'mcp' : match.executionMode === 'cli' ? 'cli' : 'native',
        hostConn: (match.hostConn ?? null) as AssetView['hostConn'],
        url: match.url,
        // 自签证书资产：让 HTTP connector 改用不校验证书的 fetch
        allowInsecureTls: match.allowInsecureTls === true,
        env: (match.env ?? null) as Record<string, unknown> | null,
        args: (match.args ?? null) as unknown[] | null,
        headers: (match.headers ?? null) as Record<string, unknown> | null,
        credentialSlots: (match.credentialSlots ?? []) as AssetView['credentialSlots'],
        configHash: match.configHash,
      };
    },

    async canInvoke(asset: AssetView, principal: unknown): Promise<boolean> {
      // R-3 唯一真值源（T8）：完整 can('invoke') 矩阵（visibility/shared/group）
      const row = await db.select().from(schema.servers).where(eq(schema.servers.id, asset.id)).get();
      if (!row) return false;
      return await canOnAsset(db, 'invoke', principal as { userId: string; isAdmin: boolean }, row);
    },

    async evaluateRules(input) {
      let groups: string[] = [];
      if (input.assetId) {
        const rows = await db
          .select({ name: schema.groups.name })
          .from(schema.groupServers)
          .innerJoin(schema.groups, eq(schema.groups.id, schema.groupServers.groupId))
          .where(eq(schema.groupServers.serverId, input.assetId))
          .all();
        groups = rows.map((r) => r.name);
      }
      return evaluateRules(loadActiveRules(sqlite), { ...input, groups });
    },

    async writeAuditIntent(entry) {
      let credentialId: string | undefined;
      const authSlot = entry.asset.hostConn?.authSlot;
      if (authSlot) {
        // 审计记"这次调用实际用哪个凭证"：同一资产不同成员用到的是不同 personal 凭证。
        //
        // 这里只是**补充元信息**，不是授权判定：槽位解析失败（如绑定未指定键名）必须由后续
        // resolveCredentials 以真实原因报出来。若在此处抛错，会被 dispatch 的 catch 统一换成
        // "Audit unavailable; call refused"，用户和 LLM 都看不到真正该改的配置。
        try {
          const callerId = (entry.principal as { userId?: string } | null)?.userId;
          const res = resolveSlots(entry.asset, [authSlot], callerId);
          credentialId = res[0]?.credentialId;
        } catch {
          credentialId = undefined;
        }
      }
      // ref.<凭证名>.<键名>：审计"用哪个凭证"落到被引用凭证（第一处引用）
      if (!credentialId) {
        const refSource = [
          ...Object.values((entry.asset.env ?? {}) as Record<string, unknown>),
          ...((entry.asset.args ?? []) as unknown[]),
          ...Object.values((entry.asset.headers ?? {}) as Record<string, unknown>),
        ];
        for (const v of refSource) {
          if (typeof v !== 'string') continue;
          const ref = parseRef(v);
          if (!ref) continue;
          const r = credentials.valueOfRef(ref.name, ref.key);
          if (r) credentialId = r.credentialId;
          break;
        }
      }
      return audit.writeIntent({
        principal: entry.principal as { userId: string; isAdmin: boolean },
        asset: entry.asset,
        tool: entry.tool,
        args: entry.args,
        risk: entry.risk,
        status: entry.status,
        credentialId,
        audit: entry.audit,
        action: 'tool_call',
      });
    },

    async fillAudit(intentId, result) {
      await audit.fill({
        intentId,
        status: (result.status as 'success' | 'error' | 'unknown') ?? 'success',
        outputSummary: result.output,
        errorMessage: result.errorMessage,
        durationMs: result.durationMs,
      });
    },

    async resolveCredentials(asset, slotNames, userId, credentialId) {
      // ADR-028：指定 credential 时优先用它覆盖能覆盖的槽位，其余槽位按 personal → asset 解析。
      // 未绑定的槽位不出现在结果里（平台不替产品判必填）。
      const res = credentials.resolveSlotValues(asset.id, slotNames, userId, credentialId ?? undefined);
      return Object.fromEntries(res.map((r) => [r.slotName, r.value]));
    },

    resolveSlotValues(assetId, slotNames, userId) {
      return credentials.resolveSlotValues(assetId, slotNames, userId);
    },

    resolveRefValue(refName, key) {
      return credentials.valueOfRef(refName, key)?.value ?? null;
    },

    redact: (value) => redactValue(value),

    truncate: (value, bytes) => truncateString(value, bytes),

    normalizeError(err) {
      if (err instanceof TransferLimitError) return { code: ERROR_CODES.transferLimit, message: err.message };
      if (err instanceof TransferTokenError) return { code: ERROR_CODES.unauthorized, message: err.message };
      if (err instanceof TransferSizeMismatchError) return { code: ERROR_CODES.transferLimit, message: err.message };
      // CLI 配置类失败（bwrap 不可用 / command 缺失 / 槽位未绑定 / 槽位名非法）是**永久**错误：
      // 落进下面的 -32002（"实例忙，缩小范围重试"）会让 agent 死循环重试。
      // 这里只按显式类型分流，不动其它 -32002 路径（瞬时忙/超时语义原样保留）。
      if (err instanceof CliConfigError) {
        return { code: ERROR_CODES.settingsInvalid, message: `配置类错误（不可重试）：${err.message}` };
      }
      if (err instanceof Error && /指纹|未信任|Host denied/.test(err.message)) {
        // 拒绝动作正确；文案需要面向调用方（§6：说清什么错了 + 下一步）
        return { code: ERROR_CODES.instanceBusy, message: '主机指纹校验失败：目标主机未信任或指纹已变更，请先在管理端重新 trust-fingerprint' };
      }
      return { code: ERROR_CODES.instanceBusy, message: err instanceof Error ? err.message : String(err) };
    },

    getSetting: <T>(key: string) => settings.get<T>(key),
    // 热读：schema 未标 requiresRestart，用构造快照会让"改小截断长度"直到重启才生效
    get outputTruncateBytes() {
      return settings.get<number>('tools.output_truncate_bytes');
    },
  };
}
