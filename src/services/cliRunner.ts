/**
 * CLI 一次性进程执行器（不进 InstancePool：CLI 无 ready 态，池化只会制造假状态机）。
 * 职责：凭证注入（env + 临时文件）、bwrap 包装、超时 tree-kill、输出截断、在飞登记与统计。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import treeKill from 'tree-kill';
import type { AssetView } from '../framework/types.js';
import { CLI_CREDS_MOUNT, buildSandboxCommand, isSandboxAvailable } from './cliSandbox.js';

/**
 * CLI 资产视图 = 通用 `AssetView` + 二进制字段。
 *
 * 二进制来自 `servers.command` 列（D10 复用列，不新增字段）。刻意**不**并入 `AssetView`：
 * 那是所有执行方式共享的白名单视图，只有 CLI 路径需要二进制；放进本地类型后，
 * "CLI 执行缺 command" 在编译期就可见，而不是运行期才发现空串（§2 原则 2/5）。
 */
export type CliAssetView = AssetView & { command: string | null };

export interface CliRunInfo {
  runId: string;
  assetId: string;
  pid: number | null;
  argvSummary: string;
  userId: string;
  startedAt: number;
  sandboxed: boolean;
}

export interface CliExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  sandboxed: boolean;
}

export interface CliHealthStatus {
  status: 'healthy' | 'bin-missing' | 'not-executable' | 'sandbox-unavailable' | 'slots-unbound';
  detail: string;
}

export interface CliRunnerOptions {
  dataDir: string;
  runtimeCredsDir: string;
  /**
   * 子进程基础环境（调用方注入，至少含 PATH）。
   * 刻意不继承宿主进程环境：AC-61 红线禁止 src/ 业务代码直接读进程环境（配置一律走 settings）。
   */
  baseEnv: Record<string, string>;
  outputTruncateBytes: () => number;
  commandTimeoutMs: () => number;
  sandboxEnabled: () => boolean;
}

/**
 * CLI **配置类**失败（永久性：改参数重试也没用，要改资产/部署）。
 *
 * 为什么需要独立类型：这些错误经 `normalizeError` 默认映射到 -32002（"实例忙，缩小范围重试"），
 * 会让 agent 陷入重试死循环——而 bwrap 不可用、command 缺失、槽位未绑定都不是"忙"，
 * 重试一万次结果都一样。带上 `retryable=false` 让调用方能一眼分开"忙"与"配错了"。
 *
 * 刻意**不**覆盖"CLI 启动失败"（spawn 的 ENOENT/EACCES）：那可能是瞬时资源问题，
 * 与配置缺失不同口径，保持原有映射。
 */
export class CliConfigError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'CliConfigError';
  }
}

/** 超时 SIGTERM 后升级 SIGKILL 的宽限（ms）：给进程树优雅退出的机会。 */
const KILL_GRACE_MS = 3000;
/** SIGKILL 后仍无 close 的总看门狗余量（ms）：保证 exec 一定 settle、在飞登记与临时目录一定清理。 */
const WATCHDOG_EXTRA_MS = 2000;

/** 槽位名必须是标识符：它同时是 env 名与凭证文件名，含 `/`、`..` 会造成 dataDir 内任意文件写入。 */
const SLOT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** env 模板占位符：`${NAME}`（大小写均允许，避免漏渲染小写槽位）。 */
const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface Active {
  info: CliRunInfo;
  child: ChildProcess;
}

export class CliRunner {
  private readonly active = new Map<string, Active>();
  private totalRuns = 0;

  constructor(private readonly opts: CliRunnerOptions) {}

  list(): CliRunInfo[] {
    return [...this.active.values()].map((a) => ({ ...a.info }));
  }

  stats(): { active: number; total: number } {
    return { active: this.active.size, total: this.totalRuns };
  }

  kill(runId: string): boolean {
    const a = this.active.get(runId);
    if (!a) return false;
    if (a.info.pid !== null) treeKill(a.info.pid, 'SIGTERM', noop);
    return true;
  }

  async health(asset: CliAssetView): Promise<CliHealthStatus> {
    const bin = asset.command;
    if (!bin) return { status: 'bin-missing', detail: '未配置二进制（command 为空）' };
    // 含分隔符即按路径直查（不经 PATH 搜索）；`path.isAbsolute` 补齐 Windows 盘符路径（`D:\...`），
    // 否则开发机上一条存在的绝对路径会被误报为 bin-missing。
    const resolved = bin.includes('/') || path.isAbsolute(bin) ? bin : which(bin, this.pathEnv());
    if (!resolved) return { status: 'bin-missing', detail: `二进制 "${bin}" 不在 PATH` };
    // 必须是**普通文件**且带可执行位：只看 X_OK 会让目录（可执行位 = 可搜索）被判成可执行，
    // 创建校验放过 `/tmp` 这类路径。与创建侧 `resolveCliBinary` 同一判据。
    if (!isExecutableFile(resolved)) {
      return { status: 'not-executable', detail: `"${resolved}" 不是可执行的普通文件` };
    }
    if (this.opts.sandboxEnabled() && !isSandboxAvailable()) {
      return { status: 'sandbox-unavailable', detail: 'bwrap 不可用，CLI 资产将拒绝执行' };
    }
    return { status: 'healthy', detail: resolved };
  }

  async exec(input: {
    asset: CliAssetView;
    argv: string[];
    credentials: Record<string, string>;
    userId: string;
  }): Promise<CliExecResult> {
    const { asset, argv, credentials, userId } = input;
    if (!Array.isArray(argv) || argv.length === 0) throw new Error('argv 不能为空数组');
    if (!argv.every((a) => typeof a === 'string')) throw new Error('argv 元素必须全是字符串');
    const bin = asset.command;
    if (!bin) throw new CliConfigError('CLI 资产缺少二进制（command），请先在资产上补 command');

    const useSandbox = this.opts.sandboxEnabled();
    if (useSandbox && !isSandboxAvailable()) {
      throw new CliConfigError('bwrap 不可用：CLI 资产要求隔离执行（fail-closed，不降级），请在网关主机安装 bubblewrap');
    }

    const runId = randomUUID();
    const runDir = path.join(this.opts.runtimeCredsDir, runId);
    const timeoutMs = this.opts.commandTimeoutMs();
    const truncate = this.opts.outputTruncateBytes();
    const t0 = Date.now();

    // mkdir → 写凭证 → 构造命令 → spawn 全链在 try 内：任一环节失败都必须先删掉已落盘的明文凭证。
    try {
      mkdirSync(runDir, { recursive: true, mode: 0o700 });

      // 凭证注入：file:true 槽位写 0600 文件（env 给路径）；其余进 env
      const env: Record<string, string> = {};
      const envTemplate = (asset.env ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(envTemplate)) {
        if (typeof v !== 'string') continue;
        env[k] = v.replace(ENV_PLACEHOLDER_RE, (_m, name: string) => {
          if (name === 'OPSGATE_TARGET') return asset.url ?? '';
          const val = credentials[name];
          if (val === undefined) {
            // fail-closed：不把缺失凭证渲染成空串，否则 CLI 会带着假凭证去连目标
            throw new CliConfigError(`env 模板 "${k}" 引用的槽位 ${name} 未绑定凭证（拒绝降级为空串），请先在「凭证绑定」补齐该槽位`);
          }
          return val;
        });
      }
      for (const slot of asset.credentialSlots) {
        const val = credentials[slot.name];
        if (val === undefined) continue;
        if (slot.file) {
          const { hostPath, envValue } = fileSlotEnv(runDir, slot.name, useSandbox);
          writeFileSync(hostPath, val, { mode: 0o600 });
          env[slot.name] = envValue;
        } else if (env[slot.name] === undefined) {
          env[slot.name] = val;
        }
      }

      const built = buildSandboxCommand({
        bin, argv, dataDir: this.opts.dataDir, credsDir: runDir, useSandbox,
      });

      return await new Promise<CliExecResult>((resolve, reject) => {
        let settled = false;
        const timers: NodeJS.Timeout[] = [];

        const clearTimers = (): void => {
          for (const t of timers) clearTimeout(t);
          timers.length = 0;
        };
        // 刻意不 unref：看门狗必须真的能触发；所有计时器都在 settle 时统一 clear，不会滞留事件循环。
        const addTimer = (ms: number, fn: () => void): void => {
          timers.push(setTimeout(fn, ms));
        };

        const cleanup = (): void => {
          clearTimers();
          this.active.delete(runId);
          try { rmSync(runDir, { recursive: true, force: true }); } catch { /* 删除失败不改变结果语义 */ }
        };
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };

        const child = spawn(built.file, built.args, {
          env: { ...this.opts.baseEnv, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
        const info: CliRunInfo = {
          runId, assetId: asset.id, pid: child.pid ?? null,
          argvSummary: argv.join(' ').slice(0, 200), userId, startedAt: t0, sandboxed: built.sandboxed,
        };
        this.active.set(runId, { info, child });
        this.totalRuns++;

        let out = '';
        let err = '';
        let truncated = false;
        const cap = (s: string, chunk: string): string => {
          if (s.length >= truncate) { truncated = true; return s; }
          const next = s + chunk;
          if (next.length > truncate) { truncated = true; return next.slice(0, truncate); }
          return next;
        };
        // StringDecoder 缓存跨 chunk 的不完整多字节序列，避免中文/emoji 被 chunk 边界切成乱码
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        child.stdout?.on('data', (c: Buffer) => { out = cap(out, outDecoder.write(c)); });
        child.stderr?.on('data', (c: Buffer) => { err = cap(err, errDecoder.write(c)); });

        let timedOut = false;
        const finish = (code: number | null): CliExecResult => {
          // flush 残留的完整字符（截断窗口已满时 cap 会丢弃剩余，符合 truncated 语义）
          out = cap(out, outDecoder.end());
          err = cap(err, errDecoder.end());
          return {
            exitCode: code,
            stdout: out,
            stderr: timedOut ? `${err}\n[超时 ${timeoutMs}ms，已终止]`.trim() : err,
            truncated,
            durationMs: Date.now() - t0,
            sandboxed: built.sandboxed,
          };
        };

        addTimer(timeoutMs, () => {
          timedOut = true;
          // 一级：SIGTERM 让进程树有机会优雅退出
          if (child.pid !== undefined) treeKill(child.pid, 'SIGTERM', noop);
          // 二级：宽限后仍未 close → SIGKILL 强制回收（防止孙进程占着管道让 close 永不到来）
          addTimer(KILL_GRACE_MS, () => {
            if (settled) return;
            if (child.pid !== undefined) treeKill(child.pid, 'SIGKILL', noop);
          });
          // 三级：总看门狗 —— 即便 SIGKILL 也没换来 close，也强制 settle 并清理临时凭证目录
          addTimer(KILL_GRACE_MS + WATCHDOG_EXTRA_MS, () => {
            settle(() => resolve(finish(null)));
          });
        });

        child.on('error', (e) => {
          settle(() => reject(new Error(`CLI 启动失败: ${e.message}`)));
        });
        child.on('close', (code) => {
          settle(() => resolve(finish(code)));
        });
      });
    } catch (err) {
      // 覆盖同步抛错（mkdir/写凭证/构造/spawn）与上面 Promise 的 reject：
      // 任何失败都不能把明文凭证留在 dataDir 下。
      try { rmSync(runDir, { recursive: true, force: true }); } catch { /* 删除失败不改变错误语义 */ }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private pathEnv(): string {
    return this.opts.baseEnv.PATH ?? '';
  }
}

/** tree-kill 的回调仅用于吞掉"进程已退出"之类的终止错误：最终状态由 close 事件或总看门狗决定。 */
function noop(): void { /* 见超时看门狗 */ }

/**
 * 解析 file:true 槽位的落盘路径。
 * 槽位名先过标识符白名单，再 `path.resolve` 后断言前缀落在 runDir 内 —— 双重防线挡住 `../` 穿越写 dataDir 任意文件。
 */
export function resolveSlotPath(runDir: string, slotName: string): string {
  if (!SLOT_NAME_RE.test(slotName)) {
    // 槽位名是资产配置的一部分（建资产时写入）：改不了参数就能修复，属永久配置错误
    throw new CliConfigError(`凭证槽位名 "${slotName}" 非法：只允许字母或下划线开头的标识符（请修正资产配置）`);
  }
  const base = path.resolve(runDir);
  const p = path.resolve(base, slotName);
  if (!p.startsWith(base + path.sep)) {
    throw new CliConfigError(`凭证槽位名 "${slotName}" 解析后越出运行期目录（拒绝写入，请修正资产配置）`);
  }
  return p;
}

/**
 * file:true 槽位的 env 取值（纯推导，便于不启进程地断言）。
 *
 * 沙箱内 dataDir 被 `--tmpfs` 清空，宿主路径在沙箱里不存在，CLI 读不到文件；
 * 所以沙箱模式必须给固定挂载点 `/run/cli-creds/<slot>`，非沙箱模式才用宿主路径。
 */
export function fileSlotEnv(
  runDir: string,
  slotName: string,
  sandboxed: boolean,
): { hostPath: string; envValue: string } {
  const hostPath = resolveSlotPath(runDir, slotName);
  return {
    hostPath,
    envValue: sandboxed ? `${CLI_CREDS_MOUNT}/${slotName}` : hostPath,
  };
}

/**
 * 二进制判据：必须是**普通文件**且带可执行位。
 *
 * 只看 `accessSync(X_OK)` 会把目录判成"可执行"（目录的可执行位 = 可搜索），
 * 于是 `command: '/tmp'` 这类目录能通过创建校验与健康检查（fail-open）。
 * 创建侧（routes/assets.ts）与健康检查共用本判据，避免两处口径漂移。
 */
export function isExecutableFile(p: string): boolean {
  let isFile = false;
  try {
    isFile = statSync(p).isFile();
  } catch {
    return false; // 不存在 / 无权限 / 悬空链接 → 不可执行
  }
  if (!isFile) return false;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(bin: string, pathEnv: string): string | null {
  for (const d of pathEnv.split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, bin);
    // 目录同样可能带可执行位（=`cd` 得进去），必须按普通文件过滤，否则会挡住 PATH 后面真正的二进制
    if (isExecutableFile(p)) return p;
  }
  return null;
}
