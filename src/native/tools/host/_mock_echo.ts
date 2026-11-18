/**
 * 框架验证用 mock 工具（_ 前缀 = 不进入产品注册表，不作为产品工具暴露，T5 起删除）。
 * 契约测试直接 import 本文件，注册进测试注册表后三组断言自动生效。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';

const tool: NativeToolDefinition = {
  id: 'mock.echo',
  category: 'host',
  connector: 'mock',
  risk: 'read',
  audit: { fields: ['message'] },
  name: 'host_mock_echo',
  description:
    '回显一条消息并报告目标主机名（框架验证用）。' +
    'Use when: 用户说"测试一下工具链路"、"echo 一句试试"。' +
    'Required: 先调用 opsgate_list_assets(category="host") 取得主机清单，用返回的 id 作为 asset 参数，不要编造。',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '要回显的文本' },
    },
    required: ['message'],
  },
  async execute(ctx, args) {
    return { content: { echo: args['message'] as string, host: ctx.asset.name } };
  },
};

export default tool;
