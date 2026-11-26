/**
 * rocketmq_consumer_reset：重置消费位点（Dashboard HTTP API）。
 *
 * Dashboard 端点：POST /consumer/resetOffset.do（form）
 * 参数：consumerGroup / topic / resetOffset（相对标记）
 *
 * 注意：位点回退会导致重复消费，前移会丢消息 —— 这是最容易造成业务事故的运维动作。
 * risk='destructive' 且必须二次确认；reset_type 用枚举而不是自由字符串，避免 LLM 编造取值。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { rocketmqClient } from './_shared.js';

const RESET_TYPES = ['earliest', 'latest', 'timestamp'] as const;

const tool: NativeToolDefinition = {
  id: 'rocketmq.consumer_reset',
  category: 'rocketmq',
  connector: 'rocketmq',
  risk: 'destructive',
  audit: { fields: ['consumer_group', 'topic', 'reset_type', 'timestamp'] },
  name: 'rocketmq_consumer_reset',
  description:
    '重置 RocketMQ 消费组在某主题上的消费位点（destructive：回退会重复消费、前移会丢消息，执行前必须向用户复述消费组/主题/目标位点并等待确认）。Use when: 用户说"这个组积压太多要跳过"、"从最早重新消费一遍"。Required: asset 取自 opsgate_list_assets(category="rocketmq")，不要编造；三个必填参数缺一不可。',
  inputSchema: {
    type: 'object',
    properties: {
      consumer_group: { type: 'string', description: '消费组名' },
      topic: { type: 'string', description: '主题名' },
      reset_type: {
        type: 'string',
        enum: [...RESET_TYPES],
        description: '重置方式：earliest 是指回到最早位点，latest 是指跳到最新位点，timestamp 是指回到指定时间点',
      },
      timestamp: { type: 'number', description: 'reset_type=timestamp 时必填，Unix 毫秒时间戳' },
    },
    required: ['consumer_group', 'topic', 'reset_type'],
  },
  async execute(ctx, args) {
    const group = String(args.consumer_group ?? '').trim();
    const topic = String(args.topic ?? '').trim();
    const resetType = String(args.reset_type ?? '').trim();
    if (!group || !topic) throw new Error('consumer_group 与 topic 均必填');
    if (!(RESET_TYPES as readonly string[]).includes(resetType)) {
      throw new Error(`reset_type 仅支持 ${RESET_TYPES.join(' / ')}`);
    }

    const client = rocketmqClient(ctx);
    const form: Record<string, string> = { consumerGroup: group, topic };

    if (resetType === 'timestamp') {
      const ts = Number(args.timestamp);
      if (!Number.isFinite(ts) || ts <= 0) {
        throw new Error('reset_type=timestamp 时必须提供 timestamp（Unix 毫秒）');
      }
      form.resetOffset = String(Math.floor(ts));
    } else {
      form.resetOffset = resetType;
    }

    const res = await client.requestJson<{ status?: number; errMsg?: string }>('/consumer/resetOffset.do', {
      method: 'POST',
      form,
    });
    if (res && typeof res.status === 'number' && res.status !== 0) {
      throw new Error(
        `RocketMQ 重置位点失败（status=${res.status}${res.errMsg ? `：${res.errMsg}` : ''}）；` +
          '注意：广播模式不支持重置，且消费组必须在线',
      );
    }
    return { content: { reset: true, consumer_group: group, topic, reset_type: resetType }, meta: { group, topic } };
  },
};

export default tool;
