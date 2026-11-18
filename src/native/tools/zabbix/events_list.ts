/** zabbix_events_list：查询事件（旧版 action=events）。 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { zabbixCall, zabbixClient, safeLimit, parseCsvInts, timeRange } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'zabbix.events_list',
  category: 'zabbix',
  connector: 'zabbix',
  risk: 'read',
  audit: { fields: ['hostids', 'groupids', 'severities', 'search'] },
  name: 'zabbix_events_list',
  description:
    '查询 Zabbix 事件流（告警产生/恢复），可按主机、分组、严重度、关键字与时间窗过滤。Use when: 用户问"昨晚有哪些告警"、"这个服务最近出过什么事"、"高危事件列表"。Required: asset 取自 opsgate_list_assets(category="zabbix")，不要编造；时间用 Unix 秒。',
  inputSchema: {
    type: 'object',
    properties: {
      hostids: { type: 'string', description: '主机 id，逗号分隔' },
      groupids: { type: 'string', description: '主机组 id，逗号分隔' },
      severities: { type: 'string', description: '严重度，逗号分隔（0未分类 1信息 2警告 3一般 4严重 5灾难）' },
      search: { type: 'string', description: '事件名关键字' },
      time_from: { type: 'number', description: '起始 Unix 秒（默认不限）' },
      time_till: { type: 'number', description: '结束 Unix 秒' },
      limit: { type: 'number', description: '返回条数，默认 100，上限 500' },
    },
  },
  async execute(ctx, args) {
    const client = await zabbixClient(ctx);
    const req: Record<string, unknown> = {
      output: ['eventid', 'objectid', 'name', 'severity', 'clock', 'value', 'acknowledged'],
      source: 0,
      object: 0,
      sortfield: ['clock'],
      sortorder: 'DESC',
      limit: safeLimit(args.limit),
      ...timeRange(args.time_from, args.time_till),
    };
    const hostids = String(args.hostids ?? '').split(',').filter(Boolean);
    if (hostids.length) req.hostids = hostids;
    const groupids = String(args.groupids ?? '').split(',').filter(Boolean);
    if (groupids.length) req.groupids = groupids;
    const sev = parseCsvInts(args.severities);
    if (sev.length) req.severities = sev;
    if (typeof args.search === 'string' && args.search.trim()) req.search = { name: args.search.trim() };
    const events = await zabbixCall(client, 'event.get', req);
    return { content: { events }, meta: { count: Array.isArray(events) ? events.length : 0 } };
  },
};

export default tool;
