/**
 * SSH 连接器（T5 / §5.5.7 连接池，ADR-022 原生执行层）：
 * 连接键 (assetId, credentialFingerprint)；idle TTL（默认 5min）；每连接 FIFO 串行；
 * 全局信号量（默认 32，需重启生效）；断线自动重连 1 次；
 * 主机指纹：管理端 trust 后校验，不一致/未信任 → 拒绝连接（不做自动信任，AC-47）。
 * 凭证注入：authSlot → ssh2.connect({ password | privateKey })，不落地 env、无子进程（AC-37）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { AssetView, CallerPrincipal, Connector, PoolStats } from '../../framework/types.js';
import type { SettingsLike } from '../../config/settings.js';
import { credentialFingerprint } from '../../services/crypto.js';

export interface SshCredential {
  password?: string;
  privateKey?: string;
  /** 私钥口令（authPassSlot 槽位，Spec §4.3 多槽位：私钥一个凭证、口令另一个） */
  passphrase?: string;
  /**
   * 凭证里携带的 SSH 用户名（`username` 键）。给出时**优先于** `host_conn.username`：
   * 账号随凭证走，"账号密码"类凭证换个资产也能用，不必在两个地方重复填写。
   * 凭证没带 username 时回落到资产上的用户名（资产账号名仍必填）。
   */
  username?: string;
  /** 凭证 id（审计与键指纹用） */
  credentialId: string;
  updatedAtMs: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: { stdout: boolean; stderr: boolean };
}

/**
 * 组装 ssh2 连接参数（认证部分）。连接器与主机指纹采集端点**必须**共用这一份——
 * 早前指纹端点自己拼了一遍，漏了 passphrase，加密私钥直接报
 * "Encrypted private OpenSSH key detected, but no passphrase given"。
 *
 * 接受两种形态：
 *  - 槽位解析结果（`value` 是私钥或密码原文）——指纹端点用它，私钥/密码按值内容判定
 *    （含 "PRIVATE KEY" 即私钥；槽位名 AUTH 既可能是私钥也可能是密码，不能靠名字区分）；
 *  - 已解析凭证（`privateKey` / `password` 已分开）——连接器内部用它。
 */
export function sshAuthParams(
  hostConn: { host: string; port?: number; username: string },
  cred: { value: string; username?: string } | SshCredential,
  passphrase: string | undefined,
): ConnectConfig {
  const auth = 'value' in cred
    ? (cred.value.includes('PRIVATE KEY') ? { privateKey: cred.value } : { password: cred.value })
    : {
        ...(cred.privateKey !== undefined ? { privateKey: cred.privateKey } : {}),
        ...(cred.password !== undefined ? { password: cred.password } : {}),
      };
  return {
    host: hostConn.host,
    port: hostConn.port ?? 22,
    // 凭证自带用户名优先于资产上的（账号随凭证走）
    username: cred.username ?? hostConn.username,
    ...auth,
    ...(passphrase !== undefined ? { passphrase } : {}),
  };
}

export interface SshHandle {
  exec(command: string, timeoutMs: number): Promise<ExecResult>;
  /** SFTP 推文件并原子 rename（.opsgate.tmp.<rand> → remotePath），失败清理无残留（AC-41） */
  upload(remotePath: string, data: Buffer): Promise<void>;
  download(remotePath: string, maxBytes: number): Promise<Buffer>;
}

export interface SshConnectorOptions {
  idleTtlMs: number;
  semaphore: number;
  queueTimeoutMs: number;
  truncateBytes: number;
  /**
   * 解析该调用者这次连接要用哪套凭证。`userId` 由 dispatch 透传：
   * 成员自绑的 personal 凭证优先于归属人的共享（asset）凭证；缺省 = 系统级路径，只看共享凭证。
   */
  resolveCredential(asset: AssetView, userId?: string): Promise<SshCredential>;
  /** 存储的主机指纹（SHA256:…）；null = 未信任 */
  expectFingerprint(asset: AssetView): string | null;
}

interface Entry {
  key: string;
  conn: Client | null;
  leases: number;
  tail: Promise<unknown>;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
}

/** 全局信号量：连接上限（超时排队者被移除并报错） */
class Semaphore {
  private active = 0;
  private waiters: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];

  constructor(
    private readonly max: number,
    /** 排队超时（毫秒）：传函数则每次排队逐次读取（ADR-024 热生效） */
    private readonly timeoutMs: number | (() => number),
  ) {}

  private timeout(): number {
    return typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs;
  }

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve, timer: undefined as unknown as NodeJS.Timeout };
        const ms = this.timeout();
        waiter.timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`连接池排队超时（${Math.round(ms / 1000)}s）`));
        }, ms);
        this.waiters.push(waiter);
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      }
    }
  }
}

export class SshConnector implements Connector<SshHandle> {
  readonly type = 'ssh';
  private entries = new Map<string, Entry>();
  /** handle → entry（release 时递减租赁并启动 idle 计时） */
  private leasesOf = new Map<SshHandle, Entry>();
  private semaphore: Semaphore;
  /** 指纹不匹配（已信任但 host key 变了）累计次数——运行时端点展示用 */
  private fingerprintFailures = 0;

  constructor(
    private readonly opts: SshConnectorOptions,
    /** ADR-024 热生效源：提供后 truncate/idle/queue 逐次读取 */
    private readonly settingsSrc: SettingsLike | null = null,
  ) {
    this.semaphore = new Semaphore(opts.semaphore, () => this.hot<number>('instance_pool.queue_timeout_sec') * 1000);
  }

  private hot<T>(key: string): T {
    if (this.settingsSrc) return this.settingsSrc.get<T>(key);
    const map: Record<string, unknown> = {
      'ssh_pool.idle_ttl_sec': this.opts.idleTtlMs / 1000,
      'instance_pool.queue_timeout_sec': this.opts.queueTimeoutMs / 1000,
      'tools.output_truncate_bytes': this.opts.truncateBytes,
    };
    return map[key] as T;
  }

  async acquire(asset: AssetView, _credentialRef: string, principal?: CallerPrincipal): Promise<SshHandle> {
    // 按调用者解析凭证：不同成员的 personal 凭证 → 不同凭证指纹 → 不同连接池条（互不串用连接）
    const cred = await this.opts.resolveCredential(asset, principal?.userId);
    // 键 = assetId + 凭证指纹 + 登录用户名：同一凭证在不同绑定用不同账号时连接不可复用，
    // 否则改完用户名仍沿用旧账号建立的连接（表现为"改了没生效"）。
    // 凭证轮换/改值 → updatedAt 变 → 新键（§5.4 同构）
    const key = `${asset.id}#${credentialFingerprint(cred.credentialId, cred.updatedAtMs)}#${cred.username ?? ''}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, conn: null, leases: 0, tail: Promise.resolve(), lastUsed: 0, idleTimer: null };
      this.entries.set(key, entry);
    }
    entry.leases++;
    this.cancelIdle(entry);

    const expected = this.opts.expectFingerprint(asset);
    const handle: SshHandle = {
      exec: (command, timeoutMs) => this.enqueue(entry, () => this.execVia(entry, asset, cred, expected, command, timeoutMs)),
      upload: (remotePath, data) => this.enqueue(entry, () => this.uploadVia(entry, asset, cred, expected, remotePath, data)),
      download: (remotePath, maxBytes) => this.enqueue(entry, () => this.downloadVia(entry, asset, cred, expected, remotePath, maxBytes)),
    };
    this.leasesOf.set(handle, entry);
    return handle;
  }

  release(handle: SshHandle): void {
    const entry = this.leasesOf.get(handle);
    this.leasesOf.delete(handle);
    if (!entry) return;
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases === 0) this.scheduleIdle(entry);
  }

  invalidate(assetId: string): void {
    for (const [key, entry] of this.entries) {
      if (key.startsWith(`${assetId}#`) && entry.leases === 0) {
        this.closeEntry(key, entry);
      }
    }
  }

  stats(): PoolStats {
    let active = 0;
    let idle = 0;
    for (const e of this.entries.values()) {
      if (e.conn) {
        if (e.leases > 0) active++;
        else idle++;
      }
    }
    return { active, idle, total: this.entries.size };
  }

  /** 指纹不匹配累计（已信任主机 host key 变化）——`/runtime/ssh-connections` 展示 */
  fingerprintFailureCount(): number {
    return this.fingerprintFailures;
  }

  private enqueue<T>(entry: Entry, op: () => Promise<T>): Promise<T> {
    entry.lastUsed = Date.now();
    const run = entry.tail.then(op, op);
    entry.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async getConn(entry: Entry, asset: AssetView, cred: SshCredential, expected: string | null): Promise<Client> {
    if (entry.conn) return entry.conn;
    try {
      const conn = await this.connectOnce(asset, cred, expected);
      entry.conn = conn;
      return conn;
    } catch {
      // 断线自动重连 1 次（§5.5.7）
      const conn = await this.connectOnce(asset, cred, expected);
      entry.conn = conn;
      return conn;
    }
  }

  private connectOnce(asset: AssetView, cred: SshCredential, expected: string | null): Promise<Client> {
    return this.semaphore.acquire(async () => {
      const hostConn = asset.hostConn;
      if (!hostConn?.host) throw new Error('资产缺少 host_conn（非 native 配置）');
      const config: ConnectConfig = {
        ...sshAuthParams(hostConn, cred, cred.passphrase),
        readyTimeout: 10_000,
        keepaliveInterval: 10_000,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          if (!expected) return verify(false); // 未信任即拒绝（AC-47，不做自动信任）
          const ok = fingerprintOf(key) === expected;
          if (!ok) this.fingerprintFailures++;
          verify(ok);
        },
      };
      return await new Promise<Client>((resolve, reject) => {
        const c = new Client();
        let settled = false;
        c.once('ready', () => {
          settled = true;
          resolve(c);
        });
        // 必须常驻 error 监听：只在首次错误时 reject，之后**继续吞掉**。
        // 用 once 会在连接建立后失去监听 —— 对端断连/网络抖动时 ssh2 客户端抛
        // 未处理的 'error' 事件，直接让整个网关进程退出（实测踩到）。
        c.on('error', (err) => {
          if (!settled) reject(err);
        });
        c.connect(config);
      });
    });
  }

  /**
   * 包装一次通过连接的操作：已建立的连接可能已死（服务端重启/网络中断，ssh2 报
   * "Not connected"/"Connection lost" 之类）——关闭该连接并重连 1 次（§5.5.7 断线自动重连）。
   * 只对连接死亡类错误重试：命令/SFTP 业务错误（ENOENT、权限、命令失败）绝不重放。
   */
  private async withConn<T>(
    entry: Entry,
    asset: AssetView,
    cred: SshCredential,
    expected: string | null,
    op: (conn: Client) => Promise<T>,
  ): Promise<T> {
    try {
      const conn = await this.getConn(entry, asset, cred, expected);
      return await op(conn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (entry.conn && /not connected|connection lost|channel closed|socket closed|econnreset|epipe|no channel/i.test(message)) {
        this.closeEntry(entry.key, entry);
        const conn = await this.getConn(entry, asset, cred, expected);
        return await op(conn);
      }
      throw err;
    }
  }

  private async execVia(
    entry: Entry,
    asset: AssetView,
    cred: SshCredential,
    expected: string | null,
    command: string,
    timeoutMs: number,
  ): Promise<ExecResult> {
    const execOn = (conn: Client): Promise<ExecResult> =>
      new Promise<ExecResult>((resolve, reject) => {
        conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let stdoutOver = false;
        let stderrOver = false;
        stream.on('data', (d: Buffer) => {
          if (stdout.length >= this.hot<number>('tools.output_truncate_bytes')) {
            stdoutOver = true;
            return;
          }
          stdout += d.toString('utf8');
          if (stdout.length > this.hot<number>('tools.output_truncate_bytes')) {
            stdoutOver = true;
            stdout = stdout.slice(0, this.hot<number>('tools.output_truncate_bytes'));
          }
        });
        stream.stderr.on('data', (d: Buffer) => {
          if (stderr.length >= this.hot<number>('tools.output_truncate_bytes')) {
            stderrOver = true;
            return;
          }
          stderr += d.toString('utf8');
          if (stderr.length > this.hot<number>('tools.output_truncate_bytes')) {
            stderrOver = true;
            stderr = stderr.slice(0, this.hot<number>('tools.output_truncate_bytes'));
          }
        });
        const timer = setTimeout(() => {
          stream.destroy();
          reject(new Error('命令执行超时'));
        }, timeoutMs);
        stream.once('close', (code: number | null) => {
          clearTimeout(timer);
          resolve({
            stdout,
            stderr,
            exitCode: typeof code === 'number' ? code : -1,
            truncated: { stdout: stdoutOver, stderr: stderrOver },
          });
        });
        stream.once('error', (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    });
    return this.withConn(entry, asset, cred, expected, execOn);
  }

  private async uploadVia(
    entry: Entry,
    asset: AssetView,
    cred: SshCredential,
    expected: string | null,
    remotePath: string,
    data: Buffer,
  ): Promise<void> {
    return this.withConn(entry, asset, cred, expected, async (conn) => {
      const slash = remotePath.lastIndexOf('/');
    const dir = slash > 0 ? remotePath.slice(0, slash) : '.';
    const tmp = `${dir}/.opsgate.tmp.${randomBytes(8).toString('hex')}`;
    try {
      await sftpOp(conn, (sftp) => new Promise<void>((res) => sftp.mkdir(dir, () => res())));
      await sftpOp(conn, (sftp) => new Promise<void>((res, rej) => sftp.writeFile(tmp, data, (e: Error | null | undefined) => (e ? rej(e) : res()))));
      // 原子覆盖目标：优先 posix-rename@openssh.com（SFTP v3 原生 rename 遇已存在目标会失败）
      await sftpOp(
        conn,
        (sftp) =>
          new Promise<void>((res, rej) =>
            (sftp as unknown as { ext_openssh_rename: (a: string, b: string, cb: (e: Error | null) => void) => void }).ext_openssh_rename(
              tmp,
              remotePath,
              (e) => (e ? rej(e) : res()),
            ),
          ),
      );
    } catch (err) {
      await sftpOp(
        conn,
        (sftp) => new Promise<void>((res) => sftp.unlink(tmp, () => res())),
      ).catch(() => undefined);
      throw err;
    }
    });
  }

  private async downloadVia(
    entry: Entry,
    asset: AssetView,
    cred: SshCredential,
    expected: string | null,
    remotePath: string,
    maxBytes: number,
  ): Promise<Buffer> {
    return this.withConn(entry, asset, cred, expected, async (conn) => {
      const size = await sftpOp(
      conn,
      (sftp) => new Promise<number>((res, rej) => sftp.stat(remotePath, (e, st) => (e ? rej(e) : res(st.size)))),
    );
    if (size > maxBytes) throw new Error('文件超出下载上限（200MB）');
    return await sftpOp(
      conn,
      (sftp) => new Promise<Buffer>((res, rej) => sftp.readFile(remotePath, (e, data) => (e ? rej(e) : res(data)))),
    );
    });
  }

  private cancelIdle(entry: Entry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private scheduleIdle(entry: Entry): void {
    this.cancelIdle(entry);
    if (entry.conn === null) return;
    entry.idleTimer = setTimeout(() => {
      if (entry.leases === 0) {
        this.closeEntry(entry.key, entry);
      }
    }, this.hot<number>('ssh_pool.idle_ttl_sec') * 1000);
    entry.idleTimer.unref?.();
  }

  private closeEntry(key: string, entry: Entry): void {
    this.cancelIdle(entry);
    const c = entry.conn;
    entry.conn = null;
    if (c) {
      try {
        c.end();
      } catch {
        // 已关闭
      }
    }
    if (entry.leases === 0) this.entries.delete(key);
  }
}

/** sha256(base64 公钥，OpenSSH 指纹格式 SHA256:<b64 去 padding>) */
export function fingerprintOf(hostKey: Buffer): string {
  const b64 = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
  return `SHA256:${b64}`;
}

function sftpOp<T>(conn: Client, op: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      op(sftp).then(resolve, reject);
    });
  });
}
