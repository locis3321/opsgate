/** bwrap 沙箱命令构造（纯函数，便于测试）。Linux 默认启用；不可用由调用方 fail-closed。 */
import { spawnSync } from 'node:child_process';

/** 沙箱内凭证目录挂载点（固定值：调用方给 file:true 槽位的 env 值必须用这个前缀）。 */
export const CLI_CREDS_MOUNT = '/run/cli-creds';

/**
 * 沙箱内工作目录固定 `/tmp`：宿主 `runtimeCredsDir` 位于 dataDir 内，而 dataDir 在沙箱里被
 * `--tmpfs` 遮掉，任何 dataDir 下的路径在沙箱内都不存在（`--chdir` 会失败）。
 */
export const SANDBOX_WORK_DIR = '/tmp';

export interface SandboxCommand {
  file: string;
  args: string[];
  sandboxed: boolean;
}

let probe: boolean | null = null;

export function resetSandboxProbe(): void {
  probe = null;
}

/** 探测 bwrap 是否可用（缓存）。非 Linux 直接 false。 */
export function isSandboxAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  if (probe !== null) return probe;
  try {
    const r = spawnSync('bwrap', ['--version'], { timeout: 3000 });
    probe = r.status === 0;
  } catch {
    probe = false;
  }
  return probe;
}

export function buildSandboxCommand(opts: {
  bin: string;
  argv: string[];
  dataDir: string;
  credsDir: string;
  useSandbox: boolean;
}): SandboxCommand {
  if (!opts.useSandbox) {
    return { file: opts.bin, args: [...opts.argv], sandboxed: false };
  }
  // 顺序有语义，不可随意调整：
  // 1) credsDir 位于 dataDir 内，必须先 `--bind` 绑定（此时 dataDir 仍可见，bind 源可解析），
  //    之后才 `--tmpfs <dataDir>` 遮掉宿主数据目录——否则 bind 源已被遮，凭证目录挂不进来。
  // 2) `--tmpfs /run` 在前，`--bind ... /run/cli-creds` 在后，保证挂载点在 tmpfs 之上。
  // 3) 工作目录用 `/tmp` 并显式 `--tmpfs /tmp` 提供可写目录。
  const bwrapArgs = [
    '--ro-bind', '/', '/',
    '--tmpfs', '/run',
    '--bind', opts.credsDir, CLI_CREDS_MOUNT,
    '--tmpfs', opts.dataDir,
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', SANDBOX_WORK_DIR,
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent',
    '--chdir', SANDBOX_WORK_DIR,
    // 保留网络：kubectl/mysql 等必须能连目标服务（不 --unshare-net）
    opts.bin,
    ...opts.argv,
  ];
  return { file: 'bwrap', args: bwrapArgs, sandboxed: true };
}
