/**
 * HTTP API 连接器（Zabbix / RocketMQ / Nacos 等管理 API 型资产）。
 *
 * 为什么需要：这三类是纯 HTTP API（无子进程、无长连接）。v1 既有的两个 connector
 * 都不适用——`ssh` 面向 shell，`mcp`（实例池）面向 stdio/HTTP MCP 服务。
 *
 * 设计取舍（重要）：
 * - **鉴权不在 acquire 里做**。dispatch 的顺序是 resolveCredentials → acquire → execute，
 *   凭证只注入到 ctx.credentials，acquire 拿不到明文。因此 connector 只提供"能发请求的句柄"，
 *   鉴权头由工具在 execute 里用 ctx.credentials 显式构造——这也更贴合
 *   "有的产品要先登录换 token（Nacos）"的现实差异。
 * - **不做连接池**：HTTP 无状态，池化收益低而故障面高；release/invalidate 为空操作。
 */
import type { AssetView, Connector, PoolStats } from '../../framework/types.js';
import { insecureFetch } from './insecureFetch.js';

export interface HttpHandle {
  /** 资产基地址（已去尾斜杠），工具自行拼路径 */
  baseUrl: string;
  /** 请求超时（毫秒） */
  timeoutMs: number;
  /** 发请求并解析 JSON（非 2xx 抛错并带状态码与响应片段） */
  requestJson<T = unknown>(path: string, init?: HttpRequestInit): Promise<T>;
  /** 发请求取原文（Nacos 等可能返回纯文本 "true"） */
  requestText(path: string, init?: HttpRequestInit): Promise<string>;
}

export interface HttpRequestInit {
  method?: string;
  /** JSON body */
  body?: unknown;
  /** form-urlencoded body（Nacos OpenAPI 常用） */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpConnectorOptions {
  /** 默认超时（毫秒）；传函数则每次 acquire 逐次读取（ADR-024 热生效：改 tools.command_timeout_sec 立即作用） */
  timeoutMs: number | (() => number);
}

export interface HttpConnectorConfig {
  /** 注册用的 connector type 名 */
  type: string;
  /**
   * 由资产推导基地址。不同产品默认路径不同（如 Nacos 需带 /nacos/v1），
   * 因此不在这里统一拼，交给各 connector 配置。
   */
  baseUrlOf: (asset: AssetView) => string;
}

/**
 * 创建 HTTP connector。三个产品共用同一实现，差异只体现在 baseUrlOf，
 * 避免为每个产品复制"拼地址 / 发请求 / 错误处理"的样板。
 */
export function createHttpConnector(config: HttpConnectorConfig, options: HttpConnectorOptions): Connector<HttpHandle> {
  return {
    type: config.type,
    async acquire(asset: AssetView): Promise<HttpHandle> {
      // 自签证书场景：资产显式开启 allow_insecure_tls 时才切换为不校验证书的 fetch
      const timeoutMs = typeof options.timeoutMs === 'function' ? options.timeoutMs() : options.timeoutMs;
      return makeHandle(
        config.baseUrlOf(asset).replace(/\/+$/, ''),
        timeoutMs,
        asset.allowInsecureTls === true ? insecureFetch : undefined,
      );
    },
    release(): void {
      // HTTP 无状态，无可释放资源
    },
    invalidate(): void {
      // 无池化状态
    },
    stats(): PoolStats {
      return { active: 0, idle: 0, total: 0 };
    },
  };
}

/** 构造句柄：统一封装 fetch 的超时、JSON/form 编码与错误语义 */
export function makeHandle(baseUrl: string, defaultTimeoutMs: number, fetchImpl?: typeof fetch): HttpHandle {
  const doFetchImpl = fetchImpl ?? fetch;
  const doFetch = async (path: string, init: HttpRequestInit = {}): Promise<Response> => {
    const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? defaultTimeoutMs);
    try {
      return await doFetchImpl(url, { method: init.method ?? 'GET', headers, body, signal: ac.signal });
    } catch (err) {
      // AbortError 转成人能读懂的语义
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`请求超时（${init.timeoutMs ?? defaultTimeoutMs}ms）：${url}`);
      }
      // 证书错误要单独说清：这是"自签证书"，不是"网络不通"——两者修复动作完全不同
      const cause = (err as { cause?: { code?: string } })?.cause;
      const code = cause?.code ?? '';
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /self.signed|certificate/i.test(err instanceof Error ? err.message : '')) {
        throw new Error(
          `TLS 证书校验失败（${new URL(url).host}）：目标使用自签/不受信证书。若确认该地址可信，可在资产上开启「允许不安全 TLS」。`,
        );
      }
      // undici 的 "fetch failed" 对调用方毫无信息量：至少要说清连不上哪个地址
      if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
        throw new Error(`无法连接 ${new URL(url).origin}（网络不可达 / 端口未开放 / DNS 解析失败）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    baseUrl,
    timeoutMs: defaultTimeoutMs,
    async requestJson<T = unknown>(path: string, init: HttpRequestInit = {}): Promise<T> {
      const res = await doFetch(path, init);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      if (text.trim() === '') return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    },
    async requestText(path: string, init: HttpRequestInit = {}): Promise<string> {
      const res = await doFetch(path, init);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      return text;
    },
  };
}

/** 从槽位值中按候选名取第一个非空（各产品槽位命名不统一，这里只收敛） */
export function pickCred(credentials: Record<string, string>, names: string[]): string | undefined {
  for (const n of names) {
    const v = credentials[n];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}
