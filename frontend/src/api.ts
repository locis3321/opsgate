/** REST 客户端：统一 {code,data,message} 信封；session cookie 自动携带。 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = typeof init?.body === 'string';
  const res = await fetch(path, {
    credentials: 'include',
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as { code?: number; data?: T; message?: string };
  if (!res.ok) {
    // 会话失效（401）统一回登录页：否则页面停在"加载中"或错误态，用户无从恢复。
    // 登录/登出接口自身的 401 属业务失败（如密码错误），不触发跳转，由调用方展示。
    if (res.status === 401 && !path.startsWith('/api/v1/auth/')) redirectToLogin();
    throw new ApiError(res.status, body.message ?? res.statusText, body.code);
  }
  return body.data as T;
}

/** 仅 SPA（hash 路由）下生效；已登录页或已在登录页时不重复跳转。 */
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash.replace(/^#/, '');
  if (hash.startsWith('/login')) return;
  window.location.hash = '#/login';
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: number,
  ) {
    super(message);
  }
}

export function fmtTs(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';
}
