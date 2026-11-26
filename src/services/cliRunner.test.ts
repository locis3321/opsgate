import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliRunner, fileSlotEnv, resolveSlotPath, type CliAssetView, type CliRunnerOptions } from './cliRunner.js';
import { CLI_CREDS_MOUNT, resetSandboxProbe } from './cliSandbox.js';

/** 开发机是 Windows：sh/sleep 用例依赖 POSIX shell，仅 Linux/macOS 跑（部署目标即 Linux）。 */
const posix = process.platform !== 'win32';

/**
 * 基础环境显式注入（AC-61：业务代码不读 process.env；测试文件豁免，可在此读）。
 * PATH 必须在：跨平台用例要能解析到 node 本体之外的工具，health 的 which() 也依赖它。
 */
const baseEnv: Record<string, string> = { PATH: process.env.PATH ?? '' };

function runner(dataDir: string, sandbox = false) {
  return new CliRunner({
    dataDir,
    runtimeCredsDir: path.join(dataDir, 'rt'),
    baseEnv,
    outputTruncateBytes: () => 4096,
    commandTimeoutMs: () => 5000,
    sandboxEnabled: () => sandbox,   // 测试固定关沙箱，避免依赖 bwrap
  });
}
function cliAsset(over: Partial<CliAssetView> = {}): CliAssetView {
  return {
    id: 'a1', name: 'echo-cli', category: 'other', ownerId: 'u1', executionMode: 'cli',
    command: 'echo', args: null, env: {}, url: null, credentialSlots: [], configHash: 'ch', ...over,
  };
}

beforeEach(() => resetSandboxProbe());

describe.skipIf(!posix)('CliRunner.exec', () => {
  it('执行 echo 返回 stdout 与 exitCode 0', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const res = await r.exec({ asset: cliAsset(), argv: ['hello'], credentials: {}, userId: 'u1' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
  });

  it('shell 元字符不被解释：argv 作为字面量传入', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const res = await r.exec({ asset: cliAsset(), argv: ['hello; rm -rf /'], credentials: {}, userId: 'u1' });
    expect(res.stdout.trim()).toBe('hello; rm -rf /');
  });

  it('env 模板渲染 ${SLOT} 与 ${OPSGATE_TARGET}', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir, false);
    const asset = cliAsset({
      command: 'sh', url: 'https://svc.example.invalid:1234',
      env: { MY_TOKEN: '${TOKEN}', TARGET: '${OPSGATE_TARGET}' },
    });
    const res = await r.exec({
      asset, argv: ['-c', 'printf "%s|%s" "$MY_TOKEN" "$TARGET"'],
      credentials: { TOKEN: 's3cr3t' }, userId: 'u1',
    });
    expect(res.stdout).toBe('s3cr3t|https://svc.example.invalid:1234');
  });

  it('非零退出码原样返回（不抛错）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const asset = cliAsset({ command: 'sh' });
    const res = await r.exec({ asset, argv: ['-c', 'exit 3'], credentials: {}, userId: 'u1' });
    expect(res.exitCode).toBe(3);
  });

  it('超时 → tree-kill 并返回超时结果', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = new CliRunner({
      dataDir: dir, runtimeCredsDir: path.join(dir, 'rt'), baseEnv,
      outputTruncateBytes: () => 4096, commandTimeoutMs: () => 300, sandboxEnabled: () => false,
    });
    const asset = cliAsset({ command: 'sh' });
    const res = await r.exec({ asset, argv: ['-c', 'sleep 5'], credentials: {}, userId: 'u1' });
    expect(res.stderr).toContain('超时');
    expect(r.stats().active).toBe(0);
  });

  it('list 在飞登记；结束后清空', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const p = r.exec({ asset: cliAsset({ command: 'sleep' }), argv: ['0.5'], credentials: {}, userId: 'u1' });
    // 等子进程真的起来（短轮询，避免假绿：登记必须在飞时可见）
    await waitFor(() => r.list().length === 1, 2000);
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0]?.assetId).toBe('a1');
    await p;
    expect(r.list()).toHaveLength(0);
  });
});

/**
 * 跨平台补充（Windows 也能跑）：用 `process.execPath`（node 本体）替代 POSIX shell，
 * 覆盖 spawn 直执行、env 渲染注入、stdout 捕获与退出码传递这四条主路径。
 * 这些用例是 brief 的 POSIX 用例在 Windows 开发机上的等价观测面，不替代 Linux 上的原用例。
 */
describe('CliRunner.exec（跨平台，不依赖 POSIX shell）', () => {
  it('env 模板渲染 ${SLOT} 与 ${OPSGATE_TARGET} 后注入子进程', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir, false);
    const asset = cliAsset({
      command: process.execPath, url: 'https://svc.example.invalid:1234',
      env: { MY_TOKEN: '${TOKEN}', TARGET: '${OPSGATE_TARGET}' },
    });
    const res = await r.exec({
      asset,
      argv: ['-e', 'process.stdout.write(`${process.env.MY_TOKEN}|${process.env.TARGET}`)'],
      credentials: { TOKEN: 's3cr3t' }, userId: 'u1',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('s3cr3t|https://svc.example.invalid:1234');
  });

  it('非零退出码原样返回（不抛错）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const res = await r.exec({
      asset: cliAsset({ command: process.execPath }),
      argv: ['-e', 'process.exit(3)'], credentials: {}, userId: 'u1',
    });
    expect(res.exitCode).toBe(3);
  });

  it('file:true 槽位写成临时文件，env 里给的是文件路径而非明文', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const asset = cliAsset({
      command: process.execPath,
      credentialSlots: [{ target: 'env', name: 'MY_KEY', label: 'key', file: true }],
    });
    const res = await r.exec({
      asset,
      argv: ['-e', [
        'const fs=require("node:fs");',
        'const p=process.env.MY_KEY;',
        'process.stdout.write(JSON.stringify({ p, c: fs.readFileSync(p,"utf8"), m: fs.statSync(p).mode & 0o777 }));',
      ].join('')],
      credentials: { MY_KEY: 'file-secret' }, userId: 'u1',
    });
    const got = JSON.parse(res.stdout) as { p: string; c: string; m: number };
    // env 传的是路径（不是明文），路径指向运行期凭证目录
    expect(got.p).not.toBe('file-secret');
    expect(got.p).toContain('MY_KEY');
    expect(got.c).toBe('file-secret');
    // Windows 上 chmod 无效（mode 无意义），仅 POSIX 断言 0600
    if (posix) expect(got.m).toBe(0o600);
  });

  it('list 在飞可见、结束后清空（node setTimeout 保证跨平台可观测）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const p = r.exec({
      asset: cliAsset({ command: process.execPath }),
      argv: ['-e', 'setTimeout(()=>{},400)'], credentials: {}, userId: 'u1',
    });
    await waitFor(() => r.list().length === 1, 2000);
    expect(r.list()).toHaveLength(1);
    const runId = r.list()[0]?.runId ?? '';
    expect(runId).not.toBe('');
    await p;
    expect(r.list()).toHaveLength(0);
    expect(r.stats().active).toBe(0);
  });

  it('env 模板引用未绑定槽位 → 抛错（fail-closed，不渲染成空串）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const asset = cliAsset({ command: process.execPath, env: { MY_TOKEN: '${UNBOUND}' } });
    await expect(r.exec({
      asset, argv: ['-e', 'process.exit(0)'], credentials: {}, userId: 'u1',
    })).rejects.toThrow(/UNBOUND.*未绑定凭证/);
    expect(r.stats().active).toBe(0);
  });

  it('env 模板小写槽位名也渲染（大小写不敏感匹配）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const asset = cliAsset({ command: process.execPath, env: { TOK: '${token_lc}' } });
    const res = await r.exec({
      asset, argv: ['-e', 'process.stdout.write(process.env.TOK)'],
      credentials: { token_lc: 'lower-ok' }, userId: 'u1',
    });
    expect(res.stdout).toBe('lower-ok');
  });

  it('槽位名路径穿越 → 抛错且不写任何文件（运行期目录不残留）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const credsRoot = path.join(dir, 'rt');
    const asset = cliAsset({
      command: process.execPath,
      credentialSlots: [{ target: 'env', name: '../../escaped.key', label: 'x', file: true }],
    });
    await expect(r.exec({
      asset, argv: ['-e', 'process.exit(0)'],
      credentials: { '../../escaped.key': 'leak' }, userId: 'u1',
    })).rejects.toThrow(/槽位名 .*非法/);
    expect(existsSync(path.join(dir, '..', 'escaped.key'))).toBe(false);
    expect(existsSync(path.join(credsRoot, '..', 'escaped.key'))).toBe(false);
    // 失败路径必须清掉已建的运行期目录（明文凭证零残留）
    expect(listDir(credsRoot)).toHaveLength(0);
  });

  it('spawn 失败（二进制不存在）→ reject 且清理运行期目录', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const credsRoot = path.join(dir, 'rt');
    const asset = cliAsset({
      command: path.join(dir, 'no-such-binary'),
      credentialSlots: [{ target: 'env', name: 'MY_KEY', label: 'key', file: true }],
    });
    await expect(r.exec({
      asset, argv: ['x'], credentials: { MY_KEY: 's' }, userId: 'u1',
    })).rejects.toThrow(/CLI 启动失败/);
    expect(r.stats().active).toBe(0);
    expect(listDir(credsRoot)).toHaveLength(0);
  });

  it('多字节输出跨 chunk 不被切坏（StringDecoder）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    // 每次只写 1 字节并让出事件循环 → UTF-8 三字节序列必然跨多个 chunk 到达父进程
    const text = '中文';
    const res = await r.exec({
      asset: cliAsset({ command: process.execPath }),
      argv: ['-e', [
        `const s=${JSON.stringify(text)};`,
        'const buf=Buffer.from(s,"utf8");',
        '(async()=>{',
        'for(const b of buf){process.stdout.write(Buffer.from([b]));await new Promise(r=>setTimeout(r,5));}',
        '})();',
      ].join('')],
      credentials: {}, userId: 'u1',
    });
    expect(res.exitCode).toBe(0);
    expect(res.truncated).toBe(false);
    expect(res.stdout).toBe(text);
    expect(res.stdout).not.toContain('\uFFFD');
  });

  it('超时后 SIGTERM 无效 → SIGKILL 升级并强制 settle（不永久挂起）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = new CliRunner({
      dataDir: dir, runtimeCredsDir: path.join(dir, 'rt'), baseEnv,
      outputTruncateBytes: () => 4096, commandTimeoutMs: () => 200, sandboxEnabled: () => false,
    });
    // 子进程忽略 SIGTERM（POSIX），Windows 上同样忽略 '-' 之外无影响——本用例只验证"一定 settle"
    const res = await r.exec({
      asset: cliAsset({ command: process.execPath }),
      argv: ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)'],
      credentials: {}, userId: 'u1',
    });
    expect(res.stderr).toContain('超时');
    expect(r.stats().active).toBe(0);
    expect(listDir(path.join(dir, 'rt'))).toHaveLength(0);
  }, 20000);
});

/**
 * C-1 纯推导（无需 bwrap / 不启进程，Windows 可跑）：
 * 沙箱模式下 file:true 槽位的 env 值必须是沙箱内挂载点路径，非沙箱模式才是宿主路径。
 */
describe('fileSlotEnv / resolveSlotPath（C-1、I-4 纯推导）', () => {
  // 用真实存在的平台路径做基准：path.resolve 在 Windows 会补盘符，写死 '/srv/...' 无法跨平台比较
  const runDir = path.join(mkdtempSync(path.join(tmpdir(), 'cli-')), 'run-1');
  const hostPath = path.resolve(runDir, 'KUBECONFIG');

  it('沙箱模式 env 值为 /run/cli-creds/<slot>，不是宿主路径', () => {
    const got = fileSlotEnv(runDir, 'KUBECONFIG', true);
    expect(got.envValue).toBe(`${CLI_CREDS_MOUNT}/KUBECONFIG`);
    expect(got.envValue.startsWith(runDir)).toBe(false);
    // 落盘仍写宿主路径（沙箱靠 --bind 把它挂到挂载点）
    expect(got.hostPath).toBe(hostPath);
  });

  it('非沙箱模式 env 值为宿主 runDir 下的路径', () => {
    const got = fileSlotEnv(runDir, 'KUBECONFIG', false);
    expect(got.envValue).toBe(got.hostPath);
    expect(got.envValue.startsWith(path.resolve(runDir))).toBe(true);
  });

  it('槽位名含 ../ 穿越 → 抛错（不产出路径）', () => {
    expect(() => resolveSlotPath(runDir, '../../credentials.key')).toThrow(/非法/);
    expect(() => fileSlotEnv(runDir, '../x', true)).toThrow(/非法/);
    expect(() => resolveSlotPath(runDir, 'a/b')).toThrow(/非法/);
    expect(() => resolveSlotPath(runDir, '')).toThrow(/非法/);
  });
});

describe('CliRunner.health', () => {  it('二进制存在 → healthy；不存在 → bin-missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    const ok = await r.health(cliAsset({ command: process.execPath }));
    expect(ok.status).toBe('healthy');
    const bad = await r.health(cliAsset({ command: 'definitely-not-a-bin-xyz' }));
    expect(bad.status).toBe('bin-missing');
  });

  it('目录 → not-executable（可搜索位不等于可执行文件，I-2 同类 fail-open）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const r = runner(dir);
    // 含分隔符/绝对路径分支；目录的 X_OK（可搜索）为真，但必须是普通文件才算二进制
    const res = await r.health(cliAsset({ command: dir }));
    expect(res.status).toBe('not-executable');
  });

  it('which() 用注入的 baseEnv.PATH，不读进程环境', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const emptyPath: CliRunnerOptions = {
      dataDir: dir, runtimeCredsDir: path.join(dir, 'rt'),
      baseEnv: { PATH: '' },   // 空 PATH → 裸名必然解析不到
      outputTruncateBytes: () => 4096, commandTimeoutMs: () => 5000, sandboxEnabled: () => false,
    };
    const r = new CliRunner(emptyPath);
    const hit = await r.health(cliAsset({ command: 'node' }));
    expect(hit.status).toBe('bin-missing');
  });
});

/** 轮询等待（避免用固定 sleep 造成的假绿/假红）。 */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((res) => setTimeout(res, 10));
  }
}

function listDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];   // 目录不存在（已被清理）等价于"无残留"
  }
}
