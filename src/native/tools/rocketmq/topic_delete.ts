/**
 * rocketmq_topic_delete：删除主题（Dashboard HTTP API）。
 *
 * Dashboard 端点：POST /topic/deleteTopic.do（form：topic）
 * risk='destructive'：删除主题会连带清除消息与消费位点，不可逆，必须二次确认。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { rocketmqClient } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'rocketmq.topic_delete',
  category: 'rocketmq',
  connector: 'rocketmq',
  risk: 'destructive',
  audit: { fields: ['topic'] },
  name: 'rocketmq_topic_delete',
  description:
    '删除 RocketMQ 主题及其消息与消费位点（destructive：不可逆，执行前必须向用户复述主题名并等待确认）。Use when: 用户说"把这个废弃 topic 删了"、"清理测试主题"。Required: asset 取自 opsgate_list_assets(category="rocketmq")，不要编造；topic 必填。',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '要删除的主题名' },
    },
    required: ['topic'],
  },
  async execute(ctx, args) {
    const topic = String(args.topic ?? '').trim();
    if (!topic) throw new Error('topic 必填');

    const client = rocketmqClient(ctx);
    const res = await client.requestJson<{ status?: number; errMsg?: string }>('/topic/deleteTopic.do', {
      method: 'POST',
      form: { topic },
    });
    if (res && typeof res.status === 'number' && res.status !== 0) {
      throw new Error(`RocketMQ 删除主题失败（status=${res.status}${res.errMsg ? `：${res.errMsg}` : ''}）`);
    }
    return { content: { deleted: true, topic }, meta: { topic } };
  },
};

export default tool;
