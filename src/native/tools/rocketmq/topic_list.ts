/** rocketmq_topic_list：主题列表与统计（旧版 action=topic_list / topic_stats）。 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { rocketmqClient, rocketmqData, rocketmqLimit } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'rocketmq.topic_list',
  category: 'rocketmq',
  connector: 'rocketmq',
  risk: 'read',
  audit: { fields: ['topic', 'with_stats'] },
  name: 'rocketmq_topic_list',
  description:
    '列出 RocketMQ 主题；可指定 topic 查该主题统计（消息量/TPS）。Use when: 用户问"有哪些 topic"、"这个 topic 有多少消息"、"排查某主题是否在写"。Required: asset 取自 opsgate_list_assets(category="rocketmq")，不要编造；不传 topic 时返回列表。',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '主题名（可选；给了则返回该主题统计）' },
      limit: { type: 'number', description: '列表条数上限，默认 100，上限 500' },
    },
  },
  async execute(ctx, args) {
    const client = rocketmqClient(ctx);
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';

    if (topic) {
      const stats = await rocketmqData(client, `/topic/stats.query?topic=${encodeURIComponent(topic)}`);
      return { content: { topic, stats }, meta: { topic } };
    }

    const list = await rocketmqData<{ topicList?: string[] }>(client, '/topic/list.query');
    const topics = (list?.topicList ?? []).slice(0, rocketmqLimit(args.limit));
    return { content: { topics }, meta: { count: topics.length } };
  },
};

export default tool;
