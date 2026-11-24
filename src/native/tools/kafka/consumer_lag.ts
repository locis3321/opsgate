/**
 * kafka_consumer_lag：消费组在某主题上的堆积（lag = high - committed）。
 *
 * 数据来源：admin.fetchOffsets（位点）+ admin.fetchTopicOffsets（分区高低水位）。
 * 两个都没报错但集团不在线时，committed 为 '-1'，此时 lag 无法判定（返回 null 而不是 0）。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { withKafkaAdmin } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'kafka.consumer_lag',
  category: 'kafka',
  connector: 'kafka',
  risk: 'read',
  audit: { fields: ['group_id', 'topic'] },
  name: 'kafka_consumer_lag',
  description:
    '计算 Kafka 消费组在某主题上的分区堆积量（lag）。Use when: 用户问"这个组积压多少"、"消费是不是卡住了"、"lag 为什么一直涨"。Required: asset 取自 opsgate_list_assets(category="kafka")，不要编造；group_id 与 topic 都必填。',
  inputSchema: {
    type: 'object',
    properties: {
      group_id: { type: 'string', description: '消费组 id' },
      topic: { type: 'string', description: '主题名' },
    },
    required: ['group_id', 'topic'],
  },
  async execute(ctx, args) {
    const groupId = String(args.group_id ?? '').trim();
    const topic = String(args.topic ?? '').trim();
    if (!groupId || !topic) throw new Error('group_id 与 topic 均必填');

    return withKafkaAdmin(ctx, async (admin) => {
      const [committedRes, topicOffsets] = await Promise.all([
        admin.fetchOffsets({ groupId, topics: [topic] }),
        admin.fetchTopicOffsets(topic),
      ]);
      const committed = committedRes.find((t) => t.topic === topic)?.partitions ?? [];
      const committedByPartition = new Map(committed.map((p) => [p.partition, p.offset]));

      let totalLag = 0;
      let unknownPartitions = 0;
      const partitions = topicOffsets.map((p) => {
        const committedOffset = committedByPartition.get(p.partition) ?? '-1';
        const high = Number(p.high);
        const low = Number(p.low);
        const com = Number(committedOffset);
        // -1 表示该分区没有已提交位点（组不在线或从未消费），lag 不可算
        const lag = Number.isFinite(com) && com >= 0 ? Math.max(high - com, 0) : null;
        if (lag === null) unknownPartitions++;
        else totalLag += lag;
        return { partition: p.partition, low, high, committed: committedOffset, lag };
      });

      return {
        content: {
          group_id: groupId,
          topic,
          total_lag: unknownPartitions === partitions.length ? null : totalLag,
          partitions,
          ...(unknownPartitions > 0
            ? { hint: `${unknownPartitions} 个分区无已提交位点（消费组可能不在线或从未消费该主题）` }
            : {}),
        },
        meta: { groupId, topic, partitions: partitions.length },
      };
    });
  },
};

export default tool;
