/**
 * Kafka 工具共享逻辑（下划线前缀 = 不被 barrel 加载为工具）。
 */
import type { Admin } from 'kafkajs';
import type { KafkaHandle } from '../../connectors/kafka.js';
import type { NativeToolContext } from '../../../framework/types.js';

export function kafkaHandle(ctx: NativeToolContext): KafkaHandle {
  return (ctx as unknown as { handle: KafkaHandle }).handle;
}

/** 在 admin 上执行操作（连接生命周期由 connector 管，工具不自己 connect/disconnect） */
export function withKafkaAdmin<T>(ctx: NativeToolContext, fn: (admin: Admin) => Promise<T>): Promise<T> {
  return kafkaHandle(ctx).withAdmin(fn);
}

/** 输出裁剪：topic 列表 / 分区位点都可能很长 */
export function trimList<T>(list: T[], maxItems = 200): { items: T[]; truncated?: true; total?: number } {
  if (list.length <= maxItems) return { items: list };
  return { items: list.slice(0, maxItems), truncated: true, total: list.length };
}
