/**
 * rocketmq_topic_save：创建或更新主题（Dashboard HTTP API）。
 *
 * Dashboard 端点：POST /topic/createOrUpdate.do（form）
 * 参数与 mqadmin updateTopic 对齐：topic / readQueueNums / writeQueueNums / perm / brokerName。
 * Dashboard 成功返回 {status:0}，失败非 0（此处显式报错，不吞）。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { rocketmqClient } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'rocketmq.topic_save',
  category: 'rocketmq',
  connector: 'rocketmq',
  risk: 'write',
  audit: { fields: ['topic', 'read_queue_nums', 'write_queue_nums'] },
  name: 'rocketmq_topic_save',
  description:
    '创建 RocketMQ 主题，或更新已有主题的队列数与权限。Use when: 用户说"新建一个 topic"、"这个 topic 队列不够要扩容"、"建个测试主题"。Required: asset 取自 opsgate_list_assets(category="rocketmq")，不要编造；topic 必填，其余有默认值。',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '主题名（必填）' },
      read_queue_nums: { type: 'number', description: '读队列数，默认 8' },
      write_queue_nums: { type: 'number', description: '写队列数，默认 8' },
      perm: { type: 'number', description: '权限位，默认 6（读写）；2=只写，4=只读' },
      broker_name: { type: 'string', description: '目标 Broker 名（可选；集群多 Broker 时指定）' },
    },
    required: ['topic'],
  },
  async execute(ctx, args) {
    const topic = String(args.topic ?? '').trim();
    if (!topic) throw new Error('topic 必填');
    const readNums = Number(args.read_queue_nums ?? 8);
    const writeNums = Number(args.write_queue_nums ?? 8);
    if (!Number.isInteger(readNums) || readNums < 1 || !Number.isInteger(writeNums) || writeNums < 1) {
      throw new Error('read_queue_nums / write_queue_nums 必须是 ≥1 的整数');
    }
    const perm = Number(args.perm ?? 6);
    if (!Number.isInteger(perm) || perm < 0 || perm > 7) throw new Error('perm 必须是 0–7 的整数');
    const broker = String(args.broker_name ?? '').trim();

    const client = rocketmqClient(ctx);
    const form: Record<string, string> = {
      topic,
      readQueueNums: String(readNums),
      writeQueueNums: String(writeNums),
      perm: String(perm),
    };
    if (broker) form.brokerName = broker;

    const res = await client.requestJson<{ status?: number; errMsg?: string }>('/topic/createOrUpdate.do', {
      method: 'POST',
      form,
    });
    if (res && typeof res.status === 'number' && res.status !== 0) {
      throw new Error(`RocketMQ 创建/更新主题失败（status=${res.status}${res.errMsg ? `：${res.errMsg}` : ''}）`);
    }
    return {
      content: { created_or_updated: true, topic, read_queue_nums: readNums, write_queue_nums: writeNums, perm },
      meta: { topic },
    };
  },
};

export default tool;
