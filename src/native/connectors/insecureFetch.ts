/**
 * 关闭 TLS 证书校验的 fetch 实现（仅用于用户显式开启"允许不安全 TLS"的资产）。
 *
 * 为什么需要：大量内网产品（自签证书的 K8s / 宝塔面板 / 内部 Dashboard）用自签证书，
 * Node 原生 fetch（undici）无法关闭校验，只能自建 https.request 并透传
 * `rejectUnauthorized: false`。这里实现 fetch 兼容签名，供：
 *   1) 原生 HTTP 工具 connector（zabbix/rocketmq/nacos）；
 *   2) MCP SDK 的 StreamableHTTP / SSE 传输（它们都接受自定义 fetch）。
 *
 * 安全边界：**必须**由资产的显式开关触发（`allow_insecure_tls=1`），默认关闭；
 * 开关变更写治理审计。不做全局默认、不做环境变量全局关闭。
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/** 与 undici fetch 够用的子集：返回标准 Response（SDK 只用 ok/status/headers/body/text/json） */
export const insecureFetch: typeof fetch = ((input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as { url?: string })?.url ?? input);
  return new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const body = init?.body;

    // 头逐个写入（Node 需要扁平对象）
    const nodeHeaders: Record<string, string> = {};
    headers.forEach((v, k) => { nodeHeaders[k] = v; });

    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: nodeHeaders,
        // 关键：只对显式开启不安全 TLS 的资产生效，且由此函数独占（正常路径用原生 fetch）
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => responseHeaders.append(k, x));
          else if (v !== undefined) responseHeaders.set(k, v);
        }
        const status = res.statusCode ?? 0;
        // 204/304 无 body
        const noBody = status === 204 || status === 304 || method === 'HEAD';
        const bodyStream = noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream);
        resolve(new Response(bodyStream, { status, headers: responseHeaders }));
      },
    );

    req.on('error', reject);

    // 超时与取消：SDK 的 AbortSignal 需要透传
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
    }

    if (body === undefined || body === null) {
      req.end();
      return;
    }
    if (typeof body === 'string') {
      req.end(body);
      return;
    }
    if (body instanceof Uint8Array) {
      req.end(Buffer.from(body));
      return;
    }
    if (body instanceof URLSearchParams) {
      req.end(body.toString());
      return;
    }
    if (body instanceof ReadableStream) {
      const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
      nodeStream.on('error', reject);
      nodeStream.pipe(req);
      return;
    }
    reject(new Error('不支持的请求体类型（insecureFetch 只支持 string/Uint8Array/URLSearchParams/ReadableStream）'));
  });
}) as typeof fetch;
