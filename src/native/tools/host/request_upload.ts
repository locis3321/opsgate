/**
 * host_request_upload（§5.5.7 传输三步第一步）：申请一次性上传入口。
 * 申请阶段即做：size 超限 -32007（TransferLimitError，dispatch normalize 映射）、
 * 敏感路径 block（gr-block-sens-upload 规则在 dispatch evaluateRules 命中，入口不发放，AC-45）。
 * 返回 {upload_id, upload_url, method, headers:{Authorization:Bearer}, expires_in}；文件本体走 HTTP PUT，不进 MCP。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { getTransferService } from '../../../services/transferInstance.js';

const tool: NativeToolDefinition = {
  id: 'host.request_upload',
  category: 'host',
  connector: 'ssh',
  risk: 'write',
  audit: { fields: ['remote_path', 'size_bytes', 'sha256'] },
  name: 'host_request_upload',
  description:
    '申请向指定主机上传文件的一次性 PUT 入口，文件走 HTTP 不进工具参数。Use when: 用户说"把这个脚本传到 web-01"、"上传配置到 /opt/app"。Required: 先 opsgate_list_assets(category="host") 取 id 作 asset，不要编造。Risk: /etc/、/root/.ssh/、cron、shell rc 会被拦截。',
  inputSchema: {
    type: 'object',
    properties: {
      remote_path: { type: 'string', description: '目标路径（如 /opt/app/run.sh）；/etc/、/root/.ssh/、cron 目录、shell rc 会被拦截' },
      size_bytes: { type: 'number', description: '文件字节数（必须不超过 200MB；实际超声明会被拒收）' },
      sha256: { type: 'string', description: '可选的文件 sha256 十六进制，提供则强校验，不匹配拒收并作废入口' },
      mode: { type: 'string', description: '可选目录 mode（八进制字符串，如 0755）；含义：落位时创建目录权限' },
    },
    required: ['remote_path', 'size_bytes'],
  },
  async execute(ctx, args) {
    if (!ctx.principal) throw new Error('缺少调用主体（transfer token 无法归属）');
    const service = getTransferService();
    const entry = service.createUpload({
      userId: ctx.principal.userId,
      assetId: ctx.asset.id,
      remotePath: args['remote_path'] as string,
      declaredSize: args['size_bytes'] as number,
      declaredSha256: typeof args['sha256'] === 'string' ? args['sha256'] : undefined,
    });
    return {
      content: {
        upload_id: entry.id,
        upload_url: `/mcp/transfer/${entry.id}`,
        method: 'PUT',
        headers: { Authorization: `Bearer ${entry.token}` },
        expires_in: Math.floor((entry.expiresAt - Date.now()) / 1000),
        status: entry.status,
      },
      meta: { upload_id: entry.id, remote_path: entry.remotePath, declared_size: entry.declaredSize },
    };
  },
};

export default tool;
