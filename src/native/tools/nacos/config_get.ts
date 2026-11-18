/** nacos_config_get：读取配置内容（旧版 action=get_config）。 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { nacosClient } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'nacos.config_get',
  category: 'nacos',
  connector: 'nacos',
  risk: 'read',
  audit: { fields: ['data_id', 'group'] },
  name: 'nacos_config_get',
  description:
    '读取 Nacos 配置中心里指定 dataId 的配置内容。Use when: 用户问"这个服务的配置是什么"、"看下某个 dataId 的配置"、"配置里数据库地址是多少"。Required: asset 取自 opsgate_list_assets(category="nacos")，不要编造；data_id 必填。',
  inputSchema: {
    type: 'object',
    properties: {
      data_id: { type: 'string', description: '配置 dataId（如 app.yaml）' },
      group: { type: 'string', description: '分组，默认 DEFAULT_GROUP' },
      namespace: { type: 'string', description: '命名空间 id（默认 public）' },
    },
    required: ['data_id'],
  },
  async execute(ctx, args) {
    const dataId = String(args.data_id ?? '').trim();
    if (!dataId) throw new Error('data_id 必填');
    const group = String(args.group ?? '').trim() || 'DEFAULT_GROUP';
    const ns = String(args.namespace ?? '').trim();
    const { client } = await nacosClient(ctx);
    const qs = new URLSearchParams({ dataId, group, ...(ns ? { tenant: ns } : {}) });
    const content = await client.requestText(`/cs/configs?${qs.toString()}`);
    return { content: { data_id: dataId, group, content }, meta: { dataId, group, bytes: content.length } };
  },
};

export default tool;
