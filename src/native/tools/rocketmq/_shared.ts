/**
 * RocketMQ 工具共享逻辑（下划线前缀不被 barrel 加载为工具）。
 *
 * 走 Dashboard 的 HTTP API（默认 8080）：
 *   GET /cluster/list.query       集群与 Broker 概况
 *   GET /topic/list.query         主题列表（支持 topic 模糊过滤）
 *   GET /topic/stats.query        主题统计
 *   GET /consumer/queryTopicByConsumer.query  消费进度
 * 鉴权沿用旧版：可选 Bearer token（内网无鉴权部署时留空即可）。
 */
import type { HttpHandle } from '../../connectors/http.js';
import type { NativeToolContext } from '../../../framework/types.js';

/** 按凭证构造带鉴权的句柄；无 token 时原样返回（允许无鉴权部署） */
export function rocketmqClient(ctx: NativeToolContext): HttpHandle {
  const handle = (ctx as unknown as { handle: HttpHandle }).handle;
  const token = ctx.credentials['ROCKETMQ_TOKEN'];
  if (!token) return handle;
  return {
    baseUrl: handle.baseUrl,
    timeoutMs: handle.timeoutMs,
    requestJson: (path, init = {}) =>
      handle.requestJson(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }),
    requestText: (path, init = {}) =>
      handle.requestText(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }),
  };
}

/** 限制条数：默认 100，上限 500（RocketMQ 返回体可能很大） */
export function rocketmqLimit(v: unknown, def = 100, max = 500): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Dashboard HTTP API 返回 {status, data}：data 为 0 表示成功，非 0 显式报错（不吞） */
export async function rocketmqData<T = unknown>(client: HttpHandle, path: string): Promise<T> {
  const res = await client.requestJson<{ status?: number; data?: T; errMsg?: string }>(path);
  if (res && typeof res === 'object' && typeof res.status === 'number' && res.status !== 0) {
    throw new Error(`RocketMQ 返回非成功状态 ${res.status}${res.errMsg ? `：${res.errMsg}` : ''}（${path}）`);
  }
  return (res?.data ?? res) as T;
}
