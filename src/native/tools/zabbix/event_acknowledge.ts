/**
 * zabbix_event_acknowledge：确认告警事件。
 *
 * Zabbix JSON-RPC：event.acknowledge
 * action 位掩码（按位或）：1=确认 2=已读 4=加消息 8=改严重度 16=抑制
 * 默认只做「确认 + 已读」（bit 1|2），避免误改严重度。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { zabbixClient, zabbixWrite } from './_shared.js';

const ALLOWED = ['event.acknowledge'] as const;

const tool: NativeToolDefinition = {
  id: 'zabbix.event_acknowledge',
  category: 'zabbix',
  connector: 'zabbix',
  risk: 'write',
  audit: { fields: ['eventids', 'message'] },
  name: 'zabbix_event_acknowledge',
  description:
    '确认 Zabbix 告警事件（标记为已处理，可附处理说明）。Use when: 用户说"这条告警我处理了"、"帮我 ack 一下"、"把这批告警确认掉"。Required: asset 取自 opsgate_list_assets(category="zabbix")，不要编造；eventids 必填，逗号分隔。',
  inputSchema: {
    type: 'object',
    properties: {
      eventids: { type: 'string', description: '事件 id，逗号分隔（如 "12345,12346"）' },
      message: { type: 'string', description: '处理说明（可选，写入事件备注）' },
    },
    required: ['eventids'],
  },
  async execute(ctx, args) {
    const raw = String(args.eventids ?? '').trim();
    if (!raw) throw new Error('eventids 必填');
    const eventids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (eventids.length === 0) throw new Error('eventids 解析后为空');
    const message = typeof args.message === 'string' ? args.message.trim() : '';

    // 1=确认，2=已读；有 message 时加 4=加消息
    const action = message ? 1 | 2 | 4 : 1 | 2;
    const params: Record<string, unknown> = { eventids, action };
    if (message) params.message = message;

    const client = await zabbixClient(ctx);
    const result = await zabbixWrite(client, 'event.acknowledge', params, ALLOWED);
    return { content: { acknowledged: true, eventids, action, result }, meta: { count: eventids.length } };
  },
};

export default tool;
