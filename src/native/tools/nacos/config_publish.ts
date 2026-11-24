/**
 * nacos_config_publish：发布/更新配置（写入 Nacos 配置中心）。
 *
 * Nacos OpenAPI：POST /cs/configs（form-urlencoded）
 * 与 config_get 的关系：一写一读，group/namespace 口径必须一致（默认 DEFAULT_GROUP / public）。
 *
 * risk='write'：会修改线上配置，调用方需自行确认变更窗口；guard_rules 可按 arg 维度拦截。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { nacosClient } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'nacos.config_publish',
  category: 'nacos',
  connector: 'nacos',
  risk: 'write',
  audit: { fields: ['data_id', 'group', 'type'] },
  name: 'nacos_config_publish',
  description:
    '向 Nacos 配置中心发布或更新一条配置。Use when: 用户说"把这个配置推到 Nacos"、"改一下某 dataId 的值"、"发布灰度配置"。Required: asset 取自 opsgate_list_assets(category="nacos")，不要编造；data_id 与 content 必填，content 是完整的新配置正文（不是差量）。',
  inputSchema: {
    type: 'object',
    properties: {
      data_id: { type: 'string', description: '配置 dataId（如 app.yaml）' },
      content: { type: 'string', description: '完整配置正文，整体替换旧值' },
      group: { type: 'string', description: '分组，默认 DEFAULT_GROUP' },
      namespace: { type: 'string', description: '命名空间 id（默认 public）' },
      type: { type: 'string', description: '配置格式（yaml/properties/json/text/xml/html），可选' },
    },
    required: ['data_id', 'content'],
  },
  async execute(ctx, args) {
    const dataId = String(args.data_id ?? '').trim();
    if (!dataId) throw new Error('data_id 必填');
    const content = args.content;
    if (typeof content !== 'string' || content === '') {
      throw new Error('content 必填（完整配置正文；如需清空请显式传空字符串）');
    }
    const group = String(args.group ?? '').trim() || 'DEFAULT_GROUP';
    const ns = String(args.namespace ?? '').trim();
    const type = String(args.type ?? '').trim();
    const { client } = await nacosClient(ctx);

    const form: Record<string, string> = { dataId, group, content };
    if (ns) form.tenant = ns;
    if (type) form.type = type;

    // Nacos 成功返回纯文本 "true"；非 true 视为失败（不吞）
    const result = await client.requestText('/cs/configs', { method: 'POST', form });
    if (result.trim() !== 'true') {
      throw new Error(`Nacos 拒绝发布（返回 "${result.slice(0, 200)}"）：检查 dataId/group/namespace 与账号权限`);
    }
    return {
      content: { published: true, data_id: dataId, group, namespace: ns || 'public', bytes: content.length },
      meta: { dataId, group, bytes: content.length },
    };
  },
};

export default tool;
