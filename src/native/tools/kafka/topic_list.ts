/**
 * kafka_topic_list：列出主题（含分区与副本概要）。
 *
 * 为什么单独成工具：raw admin 虽然也能列，但这是最高频的只读入口，
 * 不该让用户为了"看一眼有哪些 topic"去走 destructive 的 raw。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { withKafkaAdmin, trimList } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'kafka.topic_list',
  category: 'kafka',
  connector: 'kafka',
  risk: 'read',
  audit: { fields: ['with_detail'] },
  name: 'kafka_topic_list',
  description:
    '列出 Kafka 主题（可带分区数与副本数）。Use when: 用户问"有哪些 topic"、"这个 topic 几个分区"、"看下集群主题清单"。Required: asset 取自 opsgate_list_assets(category="kafka")，不要编造；with_detail=true 时拉每个主题的分区明细（较慢）。',
  inputSchema: {
    type: 'object',
    properties: {
      with_detail: { type: 'boolean', description: '是否返回分区/副本明细，默认 false（只列名称）' },
      limit: { type: 'number', description: '返回条数上限，默认 200' },
    },
  },
  async execute(ctx, args) {
    const withDetail = args.with_detail === true;
    const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 500);

    return withKafkaAdmin(ctx, async (admin) => {
      const names = await admin.listTopics();
      if (!withDetail) {
        const trimmed = trimList(names, limit);
        return {
          content: { count: names.length, ...trimmed },
          meta: { count: names.length },
        };
      }
      const meta = await admin.fetchTopicMetadata({ topics: names.slice(0, limit) });
      const topics = meta.topics.map((t) => ({
        name: t.name,
        partitions: t.partitions.length,
        replicas: t.partitions[0]?.replicas.length ?? 0,
        internal: t.name.startsWith('__') || t.name.startsWith('_'),
      }));
      return {
        content: { count: topics.length, topics },
        meta: { count: topics.length },
      };
    });
  },
};

export default tool;
