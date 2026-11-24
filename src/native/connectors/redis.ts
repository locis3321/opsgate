/**
 * Redis 连接器（原生执行层，ADR-022 分层原则的延伸）。
 *
 * 为什么需要独立 connector：Redis 是**长连接 + 多路复用**协议（RESP），既不是 HTTP（无状态、
 * 一次请求一连接），也不是 SSH（每连接 FIFO 串行）。它与 SSH 的共性是"连接要复用、要有 TTL、
 * 要能按资产回收"，差异是"一个连接可并发发多条命令"——因此池化策略取 SSH 的键设计 + HTTP 的并发。
 *
 * 关键设计：
 *  - 连接键 = `assetId#凭证指纹`：凭证轮换/改值 → 新键（旧连接自然废弃），与 SSH 同构（§5.4）。
 *  - `lazyConnect`：acquire 时不立刻连，第一次命令才连——避免"建了资产就拨号"，也便于测试注入。
 *  - `release` 只递减租赁，不立即断开；空闲超过 TTL 才 quit（与 SSH 池一致）。
 *  - `invalidate(assetId)` 用于凭证轮换/槽位变更后强制重连（dispatch 的实例回收路径会调用）。
 *  - 默认 `enableOfflineQueue: false`：连接未就绪时命令立即失败，而不是无限排队——
 *    "看起来在等"比"明确报错"更难排查。
 */
import { Redis } from 'ioredis';
import type { AssetView, Connector, PoolStats } from '../../framework/types.js';

export interface RedisHandle {
  /** 执行一条原生命令，返回 ioredis 的原始结果（字符串/数组/数字/null） */
  command(name: string, args: Array<string | number>): Promise<unknown>;
}

export interface RedisConnectorOptions {
  /** 空闲回收 TTL（毫秒）；传函数则逐次读取（ADR-024 热生效） */
  idleTtlMs: number | (() => number);
  /** 连接超时（毫秒） */
  connectTimeoutMs: number | (() => number);
  /**
   * 从资产 + 调用者解析连接参数。凭证在这里解密后直接使用，**不进 ctx.credentials 之外的任何地方**。
   * `userId` 由 dispatch 透传（ADR-028 personal 优先）；缺省=系统级路径，只看共享凭证。
   */
  resolveConnection(
    asset: AssetView,
    userId?: string,
  ): Promise<{ host: string; port: number; password?: string; tls: boolean; db: number }>;
}

interface Entry {
  key: string;
  client: Redis;
  leases: number;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
}

export class RedisConnector implements Connector<RedisHandle> {
  readonly type = 'redis';
  private entries = new Map<string, Entry>();
  private leasesOf = new Map<RedisHandle, Entry>();

  constructor(
    private readonly opts: RedisConnectorOptions,
  ) {}

  private idleTtl(): number {
    return typeof this.opts.idleTtlMs === 'function' ? this.opts.idleTtlMs() : this.opts.idleTtlMs;
  }

  private connectTimeout(): number {
    return typeof this.opts.connectTimeoutMs === 'function' ? this.opts.connectTimeoutMs() : this.opts.connectTimeoutMs;
  }

  async acquire(asset: AssetView, _credentialRef: string, principal?: unknown): Promise<RedisHandle> {
    const userId = (principal as { userId?: string } | undefined)?.userId;
    const conn = await this.opts.resolveConnection(asset, userId ?? undefined);
    // 键含 host/port/tls/db 与凭证：改地址或换凭证都必须是新连接
    const key = `${asset.id}#${conn.host}:${conn.port}/${conn.db}#${conn.tls ? 'tls' : 'plain'}#${conn.password ? 'auth' : 'noauth'}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const client = new Redis({
        host: conn.host,
        port: conn.port,
        ...(conn.password ? { password: conn.password } : {}),
        db: conn.db,
        ...(conn.tls ? { tls: {} } : {}),
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: this.connectTimeout(),
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      entry = { key, client, leases: 0, lastUsed: 0, idleTimer: null };
      this.entries.set(key, entry);
    }
    entry.leases++;
    this.cancelIdle(entry);

    const handle: RedisHandle = {
      command: async (name, args) => {
        // ioredis 的 call() 支持原生命令名 + 参数数组；结果形状与 redis-cli 一致
        await this.ensureConnected(entry!.client);
        const res = await (entry!.client as unknown as { call: (cmd: string, ...a: unknown[]) => Promise<unknown> }).call(name, ...args);
        entry!.lastUsed = Date.now();
        return res;
      },
    };
    this.leasesOf.set(handle, entry);
    return handle;
  }

  private async ensureConnected(client: Redis): Promise<void> {
    if (client.status === 'ready') return;
    if (client.status === 'wait' || client.status === 'end') {
      await client.connect();
    }
    // 其它状态（connecting/reconnecting）交给 ioredis 的 connectTimeout 兜底
  }

  release(handle: RedisHandle): void {
    const entry = this.leasesOf.get(handle);
    this.leasesOf.delete(handle);
    if (!entry) return;
    entry.leases = Math.max(0, entry.leases - 1);
    entry.lastUsed = Date.now();
    if (entry.leases === 0) this.scheduleIdle(entry);
  }

  invalidate(assetId: string): void {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${assetId}#`)) continue;
      this.dispose(entry);
      this.entries.delete(key);
    }
  }

  stats(): PoolStats {
    let active = 0;
    let idle = 0;
    for (const e of this.entries.values()) {
      if (e.leases > 0) active++;
      else idle++;
    }
    return { active, idle, total: this.entries.size };
  }

  /** 进程退出时优雅关闭（server.ts 调用） */
  async closeAll(): Promise<void> {
    for (const e of this.entries.values()) this.dispose(e);
    this.entries.clear();
    this.leasesOf.clear();
  }

  private scheduleIdle(entry: Entry): void {
    this.cancelIdle(entry);
    const ttl = this.idleTtl();
    entry.idleTimer = setTimeout(() => {
      const cur = this.entries.get(entry.key);
      if (cur === entry && entry.leases === 0) {
        this.dispose(entry);
        this.entries.delete(entry.key);
      }
    }, ttl);
    if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
  }

  private cancelIdle(entry: Entry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private dispose(entry: Entry): void {
    this.cancelIdle(entry);
    try {
      entry.client.disconnect();
    } catch {
      // 断开失败不影响回收：连接对象会被 GC
    }
  }
}
