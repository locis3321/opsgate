/**
 * Nacos 工具共享逻辑（下划线前缀不被 barrel 加载）。
 *
 * Nacos OpenAPI 基址：http://host:8848/nacos/v1（baseUrlOf 已含 /nacos/v1）
 * 鉴权两种（沿用旧版优先级）：
 *   1. 传了 NACOS_TOKEN → 直接 Bearer
 *   2. 否则用 NACOS_USERNAME/NACOS_PASSWORD 调 /auth/login 换 accessToken → Bearer
 */
import type { HttpHandle } from '../../connectors/http.js';
import type { NativeToolContext } from '../../../framework/types.js';

export async function nacosClient(ctx: NativeToolContext): Promise<{ client: HttpHandle; authMode: string }> {
  const handle = (ctx as unknown as { handle: HttpHandle }).handle;
  const token = ctx.credentials['NACOS_TOKEN'];
  if (token) {
    return { client: withAuth(handle, token), authMode: 'bearer_token' };
  }

  const username = ctx.credentials['NACOS_USERNAME'];
  const password = ctx.credentials['NACOS_PASSWORD'];
  if (!username || !password) {
    throw new Error('缺少 Nacos 凭证：需要 NACOS_TOKEN，或同时提供 NACOS_USERNAME + NACOS_PASSWORD');
  }
  // /auth/login 在 nacos 根路径而非 /v1 下：baseUrl 形如 http://host:8848/nacos/v1
  const root = handle.baseUrl.replace(/\/v1$/, '');
  const loginPath = root + '/v1/auth/login';
  const login = await handle.requestJson<{ accessToken?: string }>(loginPath, {
    method: 'POST',
    form: { username, password },
  });
  const accessToken = login?.accessToken;
  if (!accessToken) {
    throw new Error('Nacos 登录成功但未返回 accessToken（检查用户名/密码或服务端鉴权配置）');
  }
  return { client: withAuth(handle, accessToken), authMode: 'login_bearer_token' };
}

function withAuth(h: HttpHandle, token: string): HttpHandle {
  return {
    baseUrl: h.baseUrl,
    timeoutMs: h.timeoutMs,
    requestJson: (path, init = {}) =>
      h.requestJson(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }),
    requestText: (path, init = {}) =>
      h.requestText(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }),
  };
}
