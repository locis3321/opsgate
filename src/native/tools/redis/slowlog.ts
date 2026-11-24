/**
 * redis_slowlog：读取慢查询日志（SLOWLOG GET）。
 *
 * 为什么需要它：慢查询是缓存抖动最常见的根因，但 `SLOWLOG` 不在任何社区 Redis MCP 的
 * 具名工具里。这里把它单独做成只读工具，避免用户为了一次排障去走 destructive 的 raw 入口。
 *
 * 前提：目标 Redis 必须配置了 `slowlog-log-slower-than`（默认 10000 微秒=10ms）；
 * 若返回空数组，优先提示检查该项（返回里带 hint）。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { redisHandle } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'redis.slowlog',
  category: 'redis',
  connector: 'redis',
  risk: 'read',
  audit: { fields: ['count'] },
  name: 'redis_slowlog',
  description:
    '读取 Redis 慢查询日志（耗时超过 slowlog-log-slower-than 的命令）。Use when: 用户问"为什么 Redis 偶发变慢"、"有哪些慢命令"、"缓存抖动排查"。Required: asset 取自 opsgate_list_assets(category="redis")，不要编造；count 默认 10、上限 128。',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number', description: '返回条数，默认 10，上限 128' },
    },
  },
  async execute(ctx, args) {
    const n = Number(args.count ?? 10);
    const count = !Number.isFinite(n) || n <= 0 ? 10 : Math.min(Math.floor(n), 128);

    const handle = redisHandle(ctx);
    const raw = await handle.command('SLOWLOG', ['GET', count]);
    const entries = Array.isArray(raw) ? raw : [];

    const parsed = entries.map((e) => {
      if (!Array.isArray(e)) return e;
      // SLOWLOG 条目：[id, timestamp, microseconds, [args...], clientAddr, clientName]
      const [id, ts, micros, argv, clientAddr, clientName] = e as [unknown, number, number, unknown[], string, string];
      return {
        id,
        at: typeof ts === 'number' ? new Date(ts * 1000).toISOString() : ts,
        duration_ms: typeof micros === 'number' ? Math.round(micros / 100) / 10 : micros,
        command: Array.isArray(argv) ? argv.slice(0, 20) : argv,
        client: clientAddr,
        client_name: clientName,
      };
    });

    return {
      content: {
        count: parsed.length,
        slowlog: parsed,
        ...(parsed.length === 0 ? { hint: '无慢查询记录；检查 slowlog-log-slower-than 是否为 -1（已关闭）或值过大' } : {}),
      },
      meta: { count: parsed.length },
    };
  },
};

export default tool;
