/**
 * host_execute_command（§5.5.7）：非交互 shell 无 PTY；timeout 默认 30s 上限 300s；
 * stdout/stderr 各截断（tools.output_truncate_bytes，connector 执行）并置 truncated=true。
 * 审计含 command 全文（脱敏后）、exit_code、stdout/stderr 摘要（AC-39）。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import type { SshHandle } from '../../connectors/ssh.js';

const tool: NativeToolDefinition = {
  id: 'host.execute_command',
  category: 'host',
  connector: 'ssh',
  risk: 'write',
  audit: { includeCommand: true, fields: ['command'] },
  name: 'host_execute_command',
  description:
    '在指定 Linux 主机执行一条 shell 命令并返回 stdout/stderr。Use when: 用户说"看下 web-01 磁盘"、"查这几台负载"、"跑个 df -h"。Required: 先 opsgate_list_assets(category="host") 取 id 作 asset，不要编造。Risk: 高危命令会命中标记，执行前先复述主机与命令。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令（非交互 shell，无 PTY）' },
      timeout: { type: 'number', description: '超时秒数，默认 30，上限 300；超过即中止并返回忙/超时错误' },
    },
    required: ['command'],
  },
  async execute(ctx, args) {
    const handle = ctx.handle as SshHandle;
    const defaultMs = (ctx.settings?.get<number>('tools.command_timeout_sec') ?? 30) * 1000;
    const t = args['timeout'];
    const timeoutMs = typeof t === 'number' && t > 0 ? Math.min(t, 300) * 1000 : defaultMs;
    const res = await handle.exec(args['command'] as string, timeoutMs);
    return {
      content: {
        stdout: res.stdout,
        stderr: res.stderr,
        exit_code: res.exitCode,
        truncated: res.truncated,
      },
      meta: {
        exitCode: res.exitCode,
        stdout: res.stdout.slice(0, 200),
        stderr: res.stderr.slice(0, 200),
        truncated: res.truncated,
      },
    };
  },
};

export default tool;
