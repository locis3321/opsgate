/** zabbix_problems_list：当前未恢复问题（旧版 action=problems）。 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { zabbixCall, zabbixClient, safeLimit, parseCsvInts, timeRange } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'zabbix.problems_list',
  category: 'zabbix',
  connector: 'zabbix',
  risk: 'read',
  audit: { fields: ['hostids', 'groupids', 'severities'] },
  name: 'zabbix_problems_list',
  description:
    '列出 Zabbix 当前未恢复的问题（比事件流更适合"现在有什么在告警"）。Use when: 用户问"现在有什么告警"、"哪些问题还没恢复"、"生产当前故障面"。Required: asset 取自 opsgate_list_assets(category="zabbix")，不要编造。',
  inputSchema: {
    type: 'object',
    properties: {
      hostids: { type: 'string', description: '主机 id，逗号分隔' },
      groupids: { type: 'string', description: '主机组 id，逗号分隔' },
      severities: { type: 'string', description: '严重度，逗号分隔（0-5）' },
      time_from: { type: 'number', description: '起始 Unix 秒' },
      time_till: { type: 'number', description: '结束 Unix 秒' },
      limit: { type: 'number', description: '返回条数，默认 100，上限 500' },
    },
  },
  async execute(ctx, args) {
    const client = await zabbixClient(ctx);
    const req: Record<string, unknown> = {
      output: ['eventid', 'name', 'severity', 'clock', 'r_eventid'],
      recent: true,
      sortfield: ['eventid'],
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
    const problems = await zabbixCall(client, 'problem.get', req);
    return { content: { problems }, meta: { count: Array.isArray(problems) ? problems.length : 0 } };
  },
};

export default tool;
