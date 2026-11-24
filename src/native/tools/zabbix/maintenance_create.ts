/**
 * zabbix_maintenance_create：创建维护期（抑制告警）。
 *
 * Zabbix JSON-RPC：maintenance.create
 * 关键参数：name / active_since / active_till / hostids / timeperiods
 *
 * 默认 timeperiod：一次性窗口（timeperiod_type=0），覆盖 [active_since, active_till]。
 * 不提供"周期性维护"入口——那会变成长期静默，属于监控治理决策，应由人在网页端配置。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { zabbixClient, zabbixWrite } from './_shared.js';

const ALLOWED = ['maintenance.create'] as const;

const tool: NativeToolDefinition = {
  id: 'zabbix.maintenance_create',
  category: 'zabbix',
  connector: 'zabbix',
  risk: 'write',
  audit: { fields: ['name', 'hostids', 'duration_minutes'] },
  name: 'zabbix_maintenance_create',
  description:
    '为指定主机创建一次性维护窗口（窗口内不产生告警，常用于计划性变更）。Use when: 用户说"今晚升级先挂个维护"、"这段时间别报警"、"给这几台机器加维护窗口"。Required: asset 取自 opsgate_list_assets(category="zabbix")，不要编造；hostids 与 duration_minutes 必填。',
  inputSchema: {
    type: 'object',
    properties: {
      hostids: { type: 'string', description: '主机 id，逗号分隔' },
      duration_minutes: { type: 'number', description: '维护时长（分钟），从当前时刻起算' },
      name: { type: 'string', description: '维护期名称，默认 "opsgate maintenance"' },
      description: { type: 'string', description: '维护说明（可选）' },
    },
    required: ['hostids', 'duration_minutes'],
  },
  async execute(ctx, args) {
    const raw = String(args.hostids ?? '').trim();
    if (!raw) throw new Error('hostids 必填');
    const hostids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const minutes = Number(args.duration_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60 * 24 * 30) {
      throw new Error('duration_minutes 必须在 1 – 43200（30 天）之间');
    }
    const name = String(args.name ?? '').trim() || 'opsgate maintenance';
    const description = typeof args.description === 'string' ? args.description.trim() : '';

    const now = Math.floor(Date.now() / 1000);
    const till = now + Math.floor(minutes * 60);

    const params: Record<string, unknown> = {
      name,
      active_since: now,
      active_till: till,
      hostids,
      // timeperiod_type=0：一次性；period 必须 ≥ 60s，这里取整个窗口
      timeperiods: [{ timeperiod_type: 0, start_date: now, period: Math.floor(minutes * 60) }],
    };
    if (description) params.description = description;

    const client = await zabbixClient(ctx);
    const result = await zabbixWrite(client, 'maintenance.create', params, ALLOWED);
    return {
      content: { created: true, name, hostids, active_since: now, active_till: till, result },
      meta: { hostCount: hostids.length, minutes },
    };
  },
};

export default tool;
