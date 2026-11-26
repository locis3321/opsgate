import { describe, expect, it } from 'vitest';
import { CLI_CREDS_MOUNT, SANDBOX_WORK_DIR, buildSandboxCommand } from './cliSandbox.js';

const DATA_DIR = '/opt/opsgate/data';
const CREDS_DIR = '/opt/opsgate/data/runtime-creds/k';
const BIN = '/usr/bin/kubectl';
const ARGV = ['get', 'pods'];

function sandboxed(): ReturnType<typeof buildSandboxCommand> {
  return buildSandboxCommand({
    bin: BIN, argv: ARGV, dataDir: DATA_DIR, credsDir: CREDS_DIR, useSandbox: true,
  });
}

/** 某参数第一次出现的位置（不存在返回 -1）。 */
function idx(c: { args: string[] }, flag: string, value: string): number {
  for (let i = 0; i < c.args.length; i++) {
    if (c.args[i] === flag && c.args[i + 1] === value) return i;
  }
  return -1;
}

describe('buildSandboxCommand', () => {
  it('useSandbox=false（或无 bwrap）→ 直执行 bin+argv，sandboxed=false', () => {
    const c = buildSandboxCommand({
      bin: 'jq', argv: ['--version'], dataDir: '/data', credsDir: '/data/rt/k', useSandbox: false,
    });
    expect(c.sandboxed).toBe(false);
    expect(c.file).toBe('jq');
    expect(c.args).toEqual(['--version']);
  });

  it('useSandbox=true → file 为 bwrap，参数含遮 dataDir 与绑定 credsDir，且保留网络（无 --unshare-net）', () => {
    const c = buildSandboxCommand({
      bin: BIN, argv: ARGV, dataDir: DATA_DIR, credsDir: CREDS_DIR, useSandbox: true,
    });
    expect(c.sandboxed).toBe(true);
    expect(c.file).toBe('bwrap');
    expect(c.args).toContain('--ro-bind');
    expect(c.args).toContain('--tmpfs');
    expect(c.args).toContain(DATA_DIR);
    expect(c.args).toContain('--bind');
    expect(c.args).toContain(CLI_CREDS_MOUNT);
    expect(c.args).not.toContain('--unshare-net');
    expect(c.args).toContain('--die-with-parent');
    // bin 与 argv 在最后，且 bin 之后紧跟 argv
    const i = c.args.indexOf(BIN);
    expect(i).toBeGreaterThan(-1);
    expect(c.args.slice(i)).toEqual([BIN, ...ARGV]);
  });

  it('argv 中 shell 元字符原样保留为一个元素（不经 shell）', () => {
    const c = buildSandboxCommand({
      bin: 'echo', argv: ['hello; rm -rf /'], dataDir: '/d', credsDir: '/d/k', useSandbox: false,
    });
    expect(c.args).toEqual(['hello; rm -rf /']);
  });
});

/**
 * C-2 回归：credsDir 在 dataDir 内，`--bind` 必须先于 `--tmpfs <dataDir>`，
 * 否则 bind 源被 tmpfs 遮掉，沙箱内挂不进凭证目录。
 */
describe('buildSandboxCommand 参数顺序（C-2）', () => {
  it('--bind <credsDir> /run/cli-creds 出现在 --tmpfs <dataDir> 之前', () => {
    const c = sandboxed();
    const bindAt = idx(c, '--bind', CREDS_DIR);
    const hideAt = idx(c, '--tmpfs', DATA_DIR);
    expect(bindAt).toBeGreaterThan(-1);
    expect(hideAt).toBeGreaterThan(-1);
    expect(bindAt).toBeLessThan(hideAt);
    // 挂载点必须是约定值
    expect(c.args[bindAt + 2]).toBe(CLI_CREDS_MOUNT);
  });

  it('--tmpfs /run 在挂载 /run/cli-creds 之前（挂载点建在 tmpfs 之上）', () => {
    const c = sandboxed();
    expect(idx(c, '--tmpfs', '/run')).toBeLessThan(idx(c, '--bind', CREDS_DIR));
  });

  it('--chdir /tmp 且提供可写 --tmpfs /tmp；不出现 --unshare-net', () => {
    const c = sandboxed();
    expect(idx(c, '--tmpfs', SANDBOX_WORK_DIR)).toBeGreaterThan(-1);
    expect(idx(c, '--tmpfs', SANDBOX_WORK_DIR)).toBeLessThan(idx(c, '--chdir', SANDBOX_WORK_DIR));
    expect(idx(c, '--chdir', SANDBOX_WORK_DIR)).toBeGreaterThan(-1);
    expect(c.args).not.toContain('--unshare-net');
  });

  it('工作目录不落在 dataDir 下（沙箱内该路径已被 tmpfs 遮掉）', () => {
    const c = sandboxed();
    const chdirAt = idx(c, '--chdir', SANDBOX_WORK_DIR);
    const workDir = c.args[chdirAt + 1] ?? '';
    expect(workDir).toBe(SANDBOX_WORK_DIR);
    expect(workDir.startsWith(DATA_DIR)).toBe(false);
  });
});
