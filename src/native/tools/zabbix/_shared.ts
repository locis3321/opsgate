/**
 * Zabbix 工具共享逻辑（下划线前缀 = 不被 barrel 加载为工具）。
 *
 * 安全边界（2026-11-23 扩展）：原实现是「只读方法白名单」，所有写操作一律拒绝。
 * 用户要求「提供 raw 的 api 调用兜底 + 3 个具名写工具」后改为三层：
 *
 *   1. `ZABBIX_READ_METHODS`：只读白名单（具名只读工具仍只走这里）
 *   2. `ZABBIX_DENIED_METHODS`：**永久黑名单** —— 账号接管类方法，任何工具（含 raw）都不可调用
 *   3. raw 调用允许 1 ∪ 2 之外的方法，但必须显式传 `confirm_dangerous: true`
 *
 * 为什么保留黑名单而不是"全放开"：`user.update` / `user.login` / `script.execute` 一旦被调用，
 * 攻击者可以重置管理员密码或执行任意脚本——这不属于"运维动作"，属于拿平台当跳板。
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
  'maintenance.get',
  'acknowledge.get',
] as const;

/**
 * 永久拒绝的方法（任何入口都不可调用，含 raw）。
 *
 * 判定标准：调用后能改变"谁能登录 / 能跑什么代码 / 能改什么权限"，而不是改监控配置。
 * 用精确 method 名而非正则，避免 `user.update` 误伤 `user.get`。
 */
export const ZABBIX_DENIED_METHODS = [
  // 账号与认证：可接管平台
  'user.login',
  'user.logout',
  'user.create',
  'user.update',
  'user.delete',
  'user.updateprofile',
  'user.checkauthentication',
  'userdirectory.test',
  'authentication.update',
  'authentication.create',
  'authentication.delete',
  // 角色与权限
  'role.create',
  'role.update',
  'role.delete',
  'role.update_rules',
  // 脚本执行：任意代码执行
  'script.create',
  'script.update',
  'script.delete',
  'script.execute',
  'script.getscriptsbyhosts',
  // 令牌
  'token.create',
  'token.update',
  'token.delete',
  'token.generate',
  // 配置文件导入导出（可覆盖模板/主机配置）
  'configuration.import',
  'configuration.importcompare',
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

/** 底层 JSON-RPC 调用（不做方法校验，由调用方决定用哪个闸门） */
async function zabbixRaw(client: HttpHandle, method: string, params: unknown): Promise<unknown> {
  const res = await client.requestJson<{ result?: unknown; error?: { message?: string; data?: string } }>('/api_jsonrpc.php', {
    method: 'POST',
    body: { jsonrpc: '2.0', method, params, id: 1 },
  });
  if (res && typeof res === 'object' && 'error' in res && res.error) {
    throw new Error(`Zabbix API 错误：${res.error.message ?? ''} ${res.error.data ?? ''}`.trim());
  }
  return res?.result ?? null;
}

/** 只读调用：必须命中 READ 白名单，否则抛错（具名只读工具用这个） */
export async function zabbixCall(client: HttpHandle, method: string, params: unknown): Promise<unknown> {
  if (!(ZABBIX_READ_METHODS as readonly string[]).includes(method)) {
    throw new Error(`方法 ${method} 不在只读白名单内（允许：${ZABBIX_READ_METHODS.join(', ')}）`);
  }
  return zabbixRaw(client, method, params);
}

/**
 * 写调用闸门：具名写工具用这个（绕过 READ 白名单，但仍受黑名单约束）。
 *
 * 为什么具名写工具不需要 `confirm_dangerous`：它们的参数已被 schema 收敛到固定字段，
 * 不会出现"任意 method + 任意 params"的组合；危险度由 `risk` 声明 + guard_rules 承担。
 */
export async function zabbixWrite(
  client: HttpHandle,
  method: string,
  params: unknown,
  allowedMethods: readonly string[],
): Promise<unknown> {
  if ((ZABBIX_DENIED_METHODS as readonly string[]).includes(method)) {
    throw new Error(`方法 ${method} 属于永久拒绝清单（账号/权限/脚本类），任何入口都不可调用`);
  }
  if (!allowedMethods.includes(method)) {
    throw new Error(`方法 ${method} 不在本工具的允许集内（允许：${allowedMethods.join(', ')}）`);
  }
  return zabbixRaw(client, method, params);
}

/**
 * raw 调用闸门：任意方法（黑名单除外），但必须显式 `confirm_dangerous: true`。
 *
 * 这样即使 LLM 想调 `host.delete`，也要先"自己声明这是危险操作"，审计里能看出来意图；
 * 同时 guard_rules 的 arg 维度仍会扫到 method 字符串。
 */
export async function zabbixRawCall(client: HttpHandle, method: string, params: unknown): Promise<unknown> {
  if ((ZABBIX_DENIED_METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `方法 ${method} 属于永久拒绝清单（账号/权限/脚本类），raw 入口同样不可调用。` +
        '如确需账号级操作，请在 Zabbix 网页端由管理员人工执行。',
    );
  }
  return zabbixRaw(client, method, params);
}

/** 时间窗：默认最近 1 小时（与旧版一致），未给时间时不下发该字段 */
export function timeRange(from?: unknown, till?: unknown): Record<string, number> {
  const f = Number(from);
  const t = Number(till);
  if (Number.isFinite(f) && f > 0) {
    return {
      time_from: Math.floor(f),
      time_till: Number.isFinite(t) && t > 0 ? Math.floor(t) : Math.floor(Date.now() / 1000),
    };
  }
  return {};
}
