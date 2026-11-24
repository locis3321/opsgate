/**
 * zabbix_host_update：启停主机监控 / 改主机状态。
 *
 * Zabbix JSON-RPC：host.update
 * 只开放一个安全子集：status（0=启用监控，1=停用监控）与 description。
 * 刻意不开放 host.update 的全参数（templates / groups / interfaces）——
 * 那些会改变监控拓扑，应走 raw 入口并单独确认。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { zabbixClient, zabbixWrite } from './_shared.js';

const ALLOWED = ['host.update'] as const;
const STATUS = ['enabled', 'disabled'] as const;

const tool: NativeToolDefinition = {
  id: 'zabbix.host_update',
  category: 'zabbix',
  connector: 'zabbix',
  risk: 'write',
  audit: { fields: ['hostid', 'status'] },
  name: 'zabbix_host_update',
  description:
    '启用或停用某台主机的监控（停用后该主机不再产生告警）。Use when: 用户说"这台机器下了先别监控"、"重新开启监控"、"停掉这台告警"。Required: asset 取自 opsgate_list_assets(category="zabbix")，不要编造；hostid 与 status 必填。',
  inputSchema: {
    type: 'object',
    properties: {
      hostid: { type: 'string', description: '主机 id（单个；批量请逐个调用）' },
      status: {
        type: 'string',
        enum: [...STATUS],
        description: '目标状态：enabled 是指开启监控，disabled 是指停止监控',
      },
      description: { type: 'string', description: '主机描述（可选，会覆盖原值）' },
    },
    required: ['hostid', 'status'],
  },
  async execute(ctx, args) {
    const hostid = String(args.hostid ?? '').trim();
    if (!hostid) throw new Error('hostid 必填');
    const status = String(args.status ?? '').trim();
    if (!(STATUS as readonly string[]).includes(status)) {
      throw new Error(`status 仅支持 ${STATUS.join(' / ')}`);
    }

    const params: Record<string, unknown> = {
      hostid,
      // Zabbix 的 status 是数字：0=monitored，1=unmonitored
      status: status === 'enabled' ? 0 : 1,
    };
    const desc = args.description;
    if (typeof desc === 'string' && desc !== '') params.description = desc;

    const client = await zabbixClient(ctx);
    const result = await zabbixWrite(client, 'host.update', params, ALLOWED);
    return { content: { updated: true, hostid, status, result }, meta: { hostid, status } };
  },
};

export default tool;
