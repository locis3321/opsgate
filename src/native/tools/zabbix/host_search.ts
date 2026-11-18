/** zabbix_host_search：按主机名/IP/分组查主机（旧版 action=host_search）。 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { zabbixCall, zabbixClient, safeLimit } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'zabbix.host_search',
  category: 'zabbix',
  connector: 'zabbix',
  risk: 'read',
  audit: { fields: ['hostname', 'ip', 'group'] },
  name: 'zabbix_host_search',
  description:
    '在 Zabbix 查询主机（按主机名/IP/分组，至少给一个条件）。Use when: 用户说"Zabbix 里有哪些 web 主机"、"这台机器在不在监控"、"某分组下有什么机器"。Required: asset 取自 opsgate_list_assets(category="zabbix")，不要编造；条件至少填一个。',
  inputSchema: {
    type: 'object',
    properties: {
      hostname: { type: 'string', description: '主机名模糊匹配' },
      ip: { type: 'string', description: '主机接口 IP 精确匹配' },
      group: { type: 'string', description: '主机组名模糊匹配' },
      limit: { type: 'number', description: '返回条数，默认 100，上限 500' },
    },
  },
  async execute(ctx, args) {
    const hostname = typeof args.hostname === 'string' ? args.hostname.trim() : '';
    const ip = typeof args.ip === 'string' ? args.ip.trim() : '';
    const group = typeof args.group === 'string' ? args.group.trim() : '';
    if (!hostname && !ip && !group) {
      throw new Error('至少提供 hostname / ip / group 之一（避免全量拉取）');
    }
    const client = await zabbixClient(ctx);
    const limit = safeLimit(args.limit);

    // 按 IP：先查接口拿 hostid，再查主机
    if (ip) {
      const ifaces = (await zabbixCall(client, 'hostinterface.get', {
        output: ['hostid', 'ip'], search: { ip }, limit,
      })) as Array<{ hostid: string }>;
      const hostIds = [...new Set(ifaces.map((i) => i.hostid))];
      if (hostIds.length === 0) return { content: { hosts: [] }, meta: { count: 0 } };
      const hosts = await zabbixCall(client, 'host.get', {
        output: ['hostid', 'host', 'name', 'status'], hostids: hostIds, limit,
      });
      return { content: { hosts }, meta: { count: Array.isArray(hosts) ? hosts.length : 0 } };
    }

    // 按分组：先查 groupid
    if (group) {
      const groups = (await zabbixCall(client, 'hostgroup.get', {
        output: ['groupid', 'name'], search: { name: group }, limit,
      })) as Array<{ groupid: string }>;
      const groupIds = groups.map((g) => g.groupid);
      if (groupIds.length === 0) return { content: { hosts: [] }, meta: { count: 0 } };
      const hosts = await zabbixCall(client, 'host.get', {
        output: ['hostid', 'host', 'name', 'status'], groupids: groupIds, limit,
      });
      return { content: { hosts }, meta: { count: Array.isArray(hosts) ? hosts.length : 0 } };
    }

    const hosts = await zabbixCall(client, 'host.get', {
      output: ['hostid', 'host', 'name', 'status'], search: { host: hostname }, limit,
    });
    return { content: { hosts }, meta: { count: Array.isArray(hosts) ? hosts.length : 0 } };
  },
};

export default tool;
