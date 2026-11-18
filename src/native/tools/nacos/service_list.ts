/** nacos_service_list：服务列表 + 实例（旧版 action=list_services / get_instances）。 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { nacosClient } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'nacos.service_list',
  category: 'nacos',
  connector: 'nacos',
  risk: 'read',
  audit: { fields: ['namespace', 'group', 'service'] },
  name: 'nacos_service_list',
  description:
    '列出 Nacos 服务（不传 service 时返回列表；传 service 时返回该服务的实例清单与健康状态）。Use when: 用户问"Nacos 里注册了哪些服务"、"这个服务有几个实例"、"实例是否健康"。Required: asset 取自 opsgate_list_assets(category="nacos")，不要编造。',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: '命名空间 id（默认 public）' },
      group: { type: 'string', description: '分组（默认 DEFAULT_GROUP）' },
      service: { type: 'string', description: '服务名（给定时返回其实例清单）' },
      page_no: { type: 'number', description: '页码，默认 1' },
      page_size: { type: 'number', description: '每页条数，默认 50，上限 500' },
    },
  },
  async execute(ctx, args) {
    const { client } = await nacosClient(ctx);
    const ns = String(args.namespace ?? '').trim();
    const group = String(args.group ?? '').trim() || 'DEFAULT_GROUP';
    const service = String(args.service ?? '').trim();
    const pageSize = Math.min(Math.max(Number(args.page_size) || 50, 1), 500);
    const pageNo = Math.max(Number(args.page_no) || 1, 1);

    if (service) {
      const qs = new URLSearchParams({ serviceName: service, groupName: group, ...(ns ? { namespaceId: ns } : {}) });
      const instances = await client.requestJson<unknown>(`/ns/instance/list?${qs.toString()}`);
      return { content: { service, group, instances }, meta: { service } };
    }

    const qs = new URLSearchParams({ pageNo: String(pageNo), pageSize: String(pageSize), groupName: group, ...(ns ? { namespaceId: ns } : {}) });
    const list = await client.requestJson<{ count?: number; doms?: unknown[] }>(`/ns/service/list?${qs.toString()}`);
    return { content: { services: list?.doms ?? [], count: list?.count ?? 0 }, meta: { count: list?.count ?? 0 } };
  },
};

export default tool;
