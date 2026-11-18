/**
 * 实例企划（§5.4 / §5.3 / §5.6）：从 servers 行 + 已解析凭证构造**不可变快照**。
 * 注入（§5.6 注入点）：env / args 占位符替换（${NAME}）；file:true 槽位 → runtime-creds 临时文件（0600，实例关闭即删）。
 * 实例键：hash(serverId + configHash + sorted([(slotName, credentialId, credentialUpdatedAt)]))（§5.4）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SLOT_PLACEHOLDER_SCAN_RE, parseRef } from '../config/constants.js';
import type { ResolvedCredential } from './credentials.js';
import type { CredentialService } from './credentials.js';

export interface SlotRef {
  slotName: string;
  credentialId: string;
  updatedAtMs: number;
}

export interface InstancePlan {
  serverId: string;
  configHash: string;
  instanceKey: string;
  /** stdio 命令；HTTP/SSE 型资产为 null（用 url） */
  command: string | null;
  args: string[];
  env: Record<string, string>;
  /** HTTP/SSE 型资产目标（Spec §5.3：command/args/env 或 url/headers）；stdio 型为 null */
  url: string | null;
  headers: Record<string, string>;
  /** 传输协议（stdio=http|sse 之外的直连子进程；http=Streamable HTTP；sse=旧式 SSE） */
  transport: McpTransport;
  /** 权重类型：uvx 类 2 / Node 类 3（§5.4 重量预算） */
  weightType: 'uvx' | 'node';
  /** 实例关闭时必须清理的临时文件（file:true 槽位） */
  tempFiles: string[];
  /** 允许不安全 TLS（自签证书）：HTTP/SSE 用自定义 fetch、stdio 注入 NODE_TLS_REJECT_UNAUTHORIZED */
  allowInsecureTls: boolean;
}

export function buildInstanceKey(
  serverId: string,
  configHash: string,
  slots: SlotRef[],
): string {
  const sorted = slots
    .map((s) => `${s.slotName}:${s.credentialId}:${s.updatedAtMs}`)
    .sort();
  return createHash('sha256')
    .update(`${serverId}:${configHash}:${JSON.stringify(sorted)}`)
    .digest('hex');
}

/** MCP 传输协议（§4.1 servers.type）：stdio 直连子进程 / http Streamable HTTP / sse 旧式 SSE */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** servers.type → 传输协议；native 非 MCP 资产（不进入实例池），此处不参与 */
export function transportOf(type: string | null | undefined): McpTransport {
  return type === 'sse' ? 'sse' : type === 'http' ? 'http' : 'stdio';
}

export interface PlanSource {
  id: string;
  configHash: string;
  command: string | null;
  args: unknown;
  env: unknown;
  /** HTTP/SSE 型资产（Spec §5.3） */
  url?: string | null;
  headers?: unknown;
  /** 传输协议；缺省按 url 有无推断（http） */
  transport?: McpTransport;
  /** 允许不安全 TLS（自签证书）；默认 false */
  allowInsecureTls?: boolean;
  /** ref.<凭证名>.<键名> 解析器（无解析器时遇到 ref 即抛错 fail-closed） */
  resolveRef?: (ref: { name: string; key: string }) => string;
  credentialSlots: Array<{ target: 'env' | 'args' | 'headers' | string; name: string; label: string; file: boolean }>;
}

function resolveRefValue(source: PlanSource, ref: { name: string; key: string }): string {
  if (!source.resolveRef) {
    throw new Error(`ref.${ref.name}.${ref.key} 无法解析（未提供解析器，fail-closed）`);
  }
  return source.resolveRef(ref);
}

/** ref.<凭证名>.<键名> 解析器工厂：无凭证服务/引用不存在/键缺失 → fail-closed 抛错 */
export function makeRefResolver(credentials: CredentialService | null) {
  return (ref: { name: string; key: string }): string => {
    if (!credentials) throw new Error(`ref.${ref.name}.${ref.key} 无法解析（凭证服务未初始化，fail-closed）`);
    const r = credentials.valueOfRef(ref.name, ref.key);
    if (!r) throw new Error(`凭证引用 ref.${ref.name}.${ref.key} 不存在或键缺失（fail-closed）`);
    return r.value;
  };
}

export function buildPlan(
  source: PlanSource,
  resolved: ResolvedCredential[],
  runtimeCredsDir: string,
): InstancePlan {
  const transport: McpTransport = source.transport ?? (source.url ? 'http' : 'stdio');
  if (transport === 'stdio' && !source.command) {
    throw new Error('stdio 资产缺少 command');
  }
  if (transport !== 'stdio' && !source.url) {
    throw new Error(`${transport} 资产缺少 url`);
  }
  if (transport === 'stdio' && source.url) {
    throw new Error('stdio 资产不应携带 url');
  }
  const slotsRefs: SlotRef[] = resolved.map((r) => ({
    slotName: r.slotName,
    credentialId: r.credentialId,
    updatedAtMs: r.updatedAtMs,
  }));
  const instanceKey = buildInstanceKey(source.id, source.configHash, slotsRefs);

  const byName = new Map(resolved.map((r) => [r.slotName, r]));
  const tempFiles: string[] = [];
  const dir = path.join(runtimeCredsDir, instanceKey);

  /**
   * 注入一个槽位值（file:true 落 0600 临时文件）。
   *
   * 未绑定的槽位**不在这里判必填**：产品的鉴权常是多选一（ES：API Key 或 账号密码；
   * Nacos：token 或 用户名+密码），平台无法替产品决定哪个必填。因此引用未绑定槽位的
   * 整条注入项（env/header/arg）直接**省略**——不能留空串，否则第三方进程会把它当成
   * "已提供空值"（如 @elastic/mcp-server-elasticsearch 只要 ES_API_KEY 非 undefined 就优先用 API Key）。
   */
  const materialize = (slotName: string, res: ResolvedCredential): string => {
    const slotDef = source.credentialSlots.find((s) => s.name === slotName);
    if (slotDef?.file) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fp = path.join(dir, slotName);
      writeFileSync(fp, res.value, { mode: 0o600 });
      tempFiles.push(fp);
      return fp;
    }
    return res.value;
  };

  /** 替换值里每一处 `${NAME}`；任一处槽位未绑定 → 返回 null（调用方省略整条注入项） */
  const inject = (value: string): string | null => {
    let missing = false;
    const out = value.replace(SLOT_PLACEHOLDER_SCAN_RE, (whole, name: string) => {
      const res = byName.get(name);
      if (!res) { missing = true; return whole; }
      return materialize(name, res);
    });
    return missing ? null : out;
  };

  const env: Record<string, string> = {};
  const rawEnv = (source.env ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v !== 'string') continue;
    const ref = parseRef(v);
    if (ref) {
      env[k] = resolveRefValue(source, ref); // ref.<凭证名>.<键名>：一个凭证可服务多个资产
      continue;
    }
    const injected = inject(v);
    if (injected === null) continue;
    env[k] = injected;
  }

  const rawArgs = (source.args ?? []) as unknown[];
  const args = rawArgs.flatMap((a) => {
    if (typeof a !== 'string') return [String(a)];
    const ref = parseRef(a);
    if (ref) return [resolveRefValue(source, ref)];
    const injected = inject(a);
    return injected === null ? [] : [injected];
  });

  // HTTP 型资产：headers / url 占位符同样注入（§5.6 注入点 headers）
  const rawHeaders = (source.headers ?? {}) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v !== 'string') continue;
    const ref = parseRef(v);
    if (ref) {
      headers[k] = resolveRefValue(source, ref);
      continue;
    }
    const injected = inject(v);
    if (injected === null) continue;
    headers[k] = injected;
  }
  // url 里的槽位（如 `${MCP_URL}`）：地址随部署而变，必须能注入。
  // 未绑定时保留占位符原样传下去——URL 没有"省略"这个选项，让连接栈报出可见的地址错误。
  const url = source.url === null || source.url === undefined
    ? null
    : source.url.replace(SLOT_PLACEHOLDER_SCAN_RE, (whole, name: string) => {
        const res = byName.get(name);
        return res ? materialize(name, res) : whole;
      });

  const weightType: 'uvx' | 'node' = source.command ? (/\buvx\b/.test(source.command) ? 'uvx' : 'node') : 'node';
  const command = transport === 'stdio' ? source.command : null;
  return {
    serverId: source.id,
    configHash: source.configHash,
    instanceKey,
    command,
    args,
    env,
    url,
    headers,
    transport,
    weightType,
    tempFiles,
    allowInsecureTls: source.allowInsecureTls === true,
  };
}

export function cleanupPlanTempFiles(plan: InstancePlan): void {
  for (const f of plan.tempFiles) {
    try {
      rmSync(f, { force: true });
    } catch {
      // 忽略
    }
  }
  if (plan.tempFiles.length > 0) {
    try {
      rmSync(path.dirname(plan.tempFiles[0]!), { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
}
