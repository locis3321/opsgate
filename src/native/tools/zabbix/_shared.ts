/**
 * Zabbix 工具共享逻辑（下划线前缀 = 不被 barrel 加载为工具）。
 *
 * 安全边界（沿用旧版 opsgate 的 `_ALLOWED_BRIDGE_METHODS`）：
 * 只允许**只读** API 方法，禁止任何 create/update/delete。
 * 这是"能力收窄"而不是"配置"——新增写操作必须先改这里并评审。
 */
import type { HttpHandle } from '../../connectors/http.js';
import type { NativeToolContext } from '../../../framework/types.js';

/** 只读方法白名单（Zabbix JSON-RPC method 名） */
export const ZABBIX_READ_METHODS = [
  'apiinfo.version',
  'hostgroup.get',
  'hostinterface.get',
  'host.get',
  'item.get',
  'history.get',
  'trend.get',
  'trigger.get',
  'event.get',
  'problem.get',
] as const;

const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 500;

/** 限制条数：默认 100，上限 500（防止一次拉爆上下文） */
export function safeLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return LIMIT_DEFAULT;
  return Math.min(Math.floor(n), LIMIT_MAX);
}

/** CSV 字符串 → 数字数组（旧版 _parse_csv_ints 的等价实现） */
export function parseCsvInts(raw: unknown): number[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
}

/** 取 Zabbix 的 API 端点与鉴权头（凭证槽位 ZABBIX_TOKEN / ZABBIX_USER+ZABBIX_PASSWORD） */
export async function zabbixClient(ctx: NativeToolContext): Promise<HttpHandle> {
  const handle = (ctx as unknown as { handle: HttpHandle }).handle;
  const token = ctx.credentials['ZABBIX_TOKEN'];
  if (!token) {
    throw new Error('缺少 ZABBIX_TOKEN 槽位（Zabbix API Token，在 Zabbix 网页「用户设置 → API tokens」创建）');
  }
  // 每次调用按凭证构造独立句柄（不改共享 handle，避免并发串号）
  return withHeaders(handle, { Authorization: `Bearer ${token}` });
}

function withHeaders(h: HttpHandle, headers: Record<string, string>): HttpHandle {
  return {
    baseUrl: h.baseUrl,
    timeoutMs: h.timeoutMs,
    async requestJson<T>(path: string, init: import('../../connectors/http.js').HttpRequestInit = {}) {
      return h.requestJson<T>(path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    },
    async requestText(path: string, init: import('../../connectors/http.js').HttpRequestInit = {}) {
      return h.requestText(path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    },
  };
}

/**
 * 调一次 Zabbix JSON-RPC（api_jsonrpc.php）。
 * 返回 result 字段；Zabbix 的 error 字段显式抛出（不吞）。
 */
export async function zabbixCall(client: HttpHandle, method: string, params: unknown): Promise<unknown> {
  if (!(ZABBIX_READ_METHODS as readonly string[]).includes(method)) {
    throw new Error(`方法 ${method} 不在只读白名单内（允许：${ZABBIX_READ_METHODS.join(', ')}）`);
  }
  const res = await client.requestJson<{ result?: unknown; error?: { message?: string; data?: string } }>('/api_jsonrpc.php', {
    method: 'POST',
    body: { jsonrpc: '2.0', method, params, id: 1 },
  });
  if (res && typeof res === 'object' && 'error' in res && res.error) {
    throw new Error(`Zabbix API 错误：${res.error.message ?? ''} ${res.error.data ?? ''}`.trim());
  }
  return res?.result ?? null;
}

/** 时间窗：默认最近 1 小时（与旧版一致），未给时间时不下发该字段 */
export function timeRange(from?: unknown, till?: unknown): Record<string, number> {
  const f = Number(from);
  const t = Number(till);
  if (Number.isFinite(f) && f > 0) {
    return { time_from: Math.floor(f), time_till: Number.isFinite(t) && t > 0 ? Math.floor(t) : Math.floor(Date.now() / 1000) };
  }
  return {};
}
