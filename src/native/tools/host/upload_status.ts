/**
 * host_upload_status（§5.5.7 第三步）：状态 enum = awaiting_upload|received|pushing|done|failed。
 * 落位完成含实际 size / sha256 / 错误原因（AC-44）。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { getTransferService } from '../../../services/transferInstance.js';

const tool: NativeToolDefinition = {
  id: 'host.upload_status',
  category: 'host',
  connector: 'ssh',
  risk: 'read',
  audit: { fields: ['upload_id'] },
  name: 'host_upload_status',
  description:
    '查询一次上传入口的当前状态（等待上传/已接收/推送中/完成/失败）。Use when: 用户上传后问"传完了吗"、"进度如何"、"失败了为什么"。Required: 先调用 opsgate_list_assets(category="host") 取 id 作为 asset 参数，不要编造；upload_id 来自 host_request_upload 返回值。',
  inputSchema: {
    type: 'object',
    properties: {
      upload_id: { type: 'string', description: 'host_request_upload 返回的 upload_id' },
    },
    required: ['upload_id'],
  },
  async execute(_ctx, args) {
    const entry = getTransferService().get(args['upload_id'] as string);
    if (!entry) {
      return {
        content: { status: 'failed', error: '入口不存在或已过期', upload_id: args['upload_id'] },
      };
    }
    return {
      content: {
        upload_id: entry.id,
        status: entry.status,
        actual_size: entry.actualSize,
        sha256: entry.actualSha256 ?? entry.declaredSha256 ?? null,
        error: entry.error ?? null,
      },
    };
  },
};

export default tool;
