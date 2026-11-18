/** rocketmq_consumer_progress：消费组在某主题上的进度与积压（旧版 action=consumer_progress）。 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { rocketmqClient, rocketmqData } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'rocketmq.consumer_progress',
  category: 'rocketmq',
  connector: 'rocketmq',
  risk: 'read',
  audit: { fields: ['consumer_group', 'topic'] },
  name: 'rocketmq_consumer_progress',
  description:
    '查询 RocketMQ 消费进度：某消费组在某主题各队列的位点与堆积量。Use when: 用户问"这个消费组有没有积压"、"消息为什么没被消费"、"看下 lag"。Required: asset 取自 opsgate_list_assets(category="rocketmq")，不要编造；consumer_group 与 topic 都必填。',
  inputSchema: {
    type: 'object',
    properties: {
      consumer_group: { type: 'string', description: '消费组名' },
      topic: { type: 'string', description: '主题名' },
    },
    required: ['consumer_group', 'topic'],
  },
  async execute(ctx, args) {
    const group = typeof args.consumer_group === 'string' ? args.consumer_group.trim() : '';
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    if (!group || !topic) throw new Error('consumer_group 与 topic 均必填');
    const client = rocketmqClient(ctx);
    const qs = `?consumerGroup=${encodeURIComponent(group)}&topic=${encodeURIComponent(topic)}`;
    const progress = await rocketmqData(client, `/consumer/queryTopicByConsumer.query${qs}`);
    return { content: { consumer_group: group, topic, progress }, meta: { group, topic } };
  },
};

export default tool;
