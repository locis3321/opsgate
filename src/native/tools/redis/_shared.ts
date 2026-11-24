/**
 * Redis 工具共享逻辑（下划线前缀 = 不被 barrel 加载为工具）。
 */
import type { RedisHandle } from '../../connectors/redis.js';
import type { NativeToolContext } from '../../../framework/types.js';

/** 取 Redis 连接句柄（由 dispatch 注入） */
export function redisHandle(ctx: NativeToolContext): RedisHandle {
  return (ctx as unknown as { handle: RedisHandle }).handle;
}

/** 危险命令清单：命中时要求调用方显式 confirm_dangerous（与 guard_rules 形成双层防护） */
export const REDIS_DANGEROUS_COMMANDS = [
  'FLUSHALL',
  'FLUSHDB',
  'SHUTDOWN',
  'DEBUG',
  'CONFIG',
  'KEYS',
  'SLAVEOF',
  'REPLICAOF',
  'MIGRATE',
  'SWAPDB',
  'CLUSTER',
  'SCRIPT',
  'FUNCTION',
  'MODULE',
] as const;

export function isDangerousRedisCommand(name: string): boolean {
  const upper = name.trim().toUpperCase();
  return (REDIS_DANGEROUS_COMMANDS as readonly string[]).includes(upper);
}

/** 输出裁剪：Redis 可能返回巨大数组（如 KEYS *），避免一次打爆上下文 */
export function trimRedisResult(value: unknown, maxItems = 200): unknown {
  if (Array.isArray(value)) {
    if (value.length <= maxItems) return value;
    return { truncated: true, total: value.length, items: value.slice(0, maxItems) };
  }
  return value;
}
