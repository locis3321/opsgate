/**
 * redis_info：读取 Redis INFO（server / memory / stats / replication / cluster 等段）。
 *
 * 为什么单独成工具而不是让 raw 命令干：INFO 是最高频的排障入口，解析成键值对直接可读，
 * 比让 LLM 自己切文本更稳；且它是纯只读，不该走 destructive 的 raw 入口。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { redisHandle } from './_shared.js';

const SECTIONS = ['default', 'server', 'clients', 'memory', 'persistence', 'stats', 'replication', 'cpu', 'cluster', 'keyspace'] as const;

const tool: NativeToolDefinition = {
  id: 'redis.info',
  category: 'redis',
  connector: 'redis',
  risk: 'read',
  audit: { fields: ['section'] },
  name: 'redis_info',
  description:
    '读取 Redis INFO（内存/命中率/持久化/主从/键空间等运行时指标）。Use when: 用户问"Redis 内存用了多少"、"缓存命中率怎么样"、"主从同步正常吗"、"有没有大量淘汰"。Required: asset 取自 opsgate_list_assets(category="redis")，不要编造；section 可省略（默认全段）。',
  inputSchema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: [...SECTIONS],
        description: 'INFO 段：default 是指全段，server/memory/stats 等是指单个段',
      },
    },
  },
  async execute(ctx, args) {
    const section = String(args.section ?? '').trim() || 'default';
    if (!(SECTIONS as readonly string[]).includes(section)) {
      throw new Error(`section 仅支持 ${SECTIONS.join(' / ')}`);
    }
    const handle = redisHandle(ctx);
    const raw = await handle.command('INFO', section === 'default' ? [] : [section]);
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    return { content: { section, info: text }, meta: { section, bytes: text.length } };
  },
};

export default tool;
