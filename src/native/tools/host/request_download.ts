/**
 * host_request_download（§5.5.7）：调用时同步 SFTP 拉取 → 校验上限 → 落暂存 → 返回一次性 GET 入口。
 * 拉取动作本身即审计（dispatch write-ahead intent），agent 是否真的 GET 不影响审计完整性。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import type { SshHandle } from '../../connectors/ssh.js';
import { getTransferService } from '../../../services/transferInstance.js';
import { sha256Of } from '../../../services/transfer.js';

const tool: NativeToolDefinition = {
  id: 'host.request_download',
  category: 'host',
  connector: 'ssh',
  risk: 'read',
  audit: { fields: ['remote_path'] },
  name: 'host_request_download',
  description:
    '从指定主机同步拉取一个文件到网关暂存区，返回一次性下载入口（GET，5 分钟内单次使用）。Use when: 用户说"把 web-01 的 nginx.conf 拿回来看看"、"取这个日志文件"。Required: 先调用 opsgate_list_assets(category="host") 取 id 作为 asset 参数，不要编造；remote_path 为远端绝对路径。',
  inputSchema: {
    type: 'object',
    properties: {
      remote_path: { type: 'string', description: '远端绝对路径（如 /var/log/app.log）；超过 200MB 返回超限错误' },
    },
    required: ['remote_path'],
  },
  async execute(ctx, args) {
    const handle = ctx.handle as SshHandle;
    if (!ctx.principal) throw new Error('缺少调用主体');
    const maxBytes = ctx.settings?.get<number>('transfer.max_file_bytes') ?? 209715200;
    const remotePath = args['remote_path'] as string;
    const data = await handle.download(remotePath, maxBytes);
    const sha = sha256Of(data);
    const entry = getTransferService().createDownload({
      userId: ctx.principal.userId,
      assetId: ctx.asset.id,
      remotePath,
      size: data.length,
      sha256: sha,
      data,
    });
    return {
      content: {
        download_id: entry.id,
        download_url: `/mcp/transfer/${entry.id}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${entry.token}` },
        size: data.length,
        sha256: sha,
        expires_in: Math.floor((entry.expiresAt - Date.now()) / 1000),
      },
      meta: { remote_path: remotePath, size: data.length, sha256: sha.slice(0, 12) },
    };
  },
};

export default tool;
