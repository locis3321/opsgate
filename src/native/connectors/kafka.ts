/**
 * Kafka 连接器（原生执行层，ADR-022 分层原则的延伸）。
 *
 * 为什么需要独立 connector：Kafka 的运维动作全部走 **AdminClient / Consumer 长连接协议**，
 * 与 HTTP 管理端的"一次请求"模型不同；broker 列表、SASL、TLS 都要在客户端初始化时确定。
 *
 * 关键设计：
 *  - 连接键 = `assetId#brokers#sasl|plain#ssl|plain`：改地址或换认证方式必须是新客户端。
 *  - **Admin 单例复用**：kafkajs 的 admin 建连开销大（拉 metadata + 找 controller），
 *    按 entry 复用一个已连接的 admin，空闲超 TTL 再 disconnect。
 *  - **Consumer 按需创建**：fetchOffsets（查 lag）需要 consumer 实例，但它不需要长期存活；
 *    每次调用建临时 consumer、取完即 disconnect——避免消费组成员数抖动。
 *  - `invalidate(assetId)`：凭证轮换/槽位变更后强制重建（dispatch 实例回收路径会调用）。
 */
import { Kafka, type Admin, logLevel, type SASLOptions } from 'kafkajs';
import type { AssetView, Connector, PoolStats } from '../../framework/types.js';

export interface KafkaConnection {
  brokers: string[];
  clientId: string;
  ssl: boolean;
  sasl?: SASLOptions;
}

export interface KafkaHandle {
  /** 在已连接的 admin 上执行一段操作（连接生命周期由 connector 管） */
  withAdmin<T>(fn: (admin: Admin) => Promise<T>): Promise<T>;
  /** 连接参数（工具做校验/回显用） */
  readonly connection: KafkaConnection;
}

export interface KafkaConnectorOptions {
  /** 空闲回收 TTL（毫秒）；传函数则逐次读取（ADR-024 热生效） */
  idleTtlMs: number | (() => number);
  /** 建立连接的等待上限（毫秒） */
  connectTimeoutMs: number | (() => number);
  /** 从资产 + 调用者解析连接参数（凭证明文只在此处出现，不落地 env） */
  resolveConnection(asset: AssetView, userId?: string): Promise<KafkaConnection>;
}

interface Entry {
  key: string;
  kafka: Kafka;
  admin: Admin | null;
  adminReady: Promise<Admin> | null;
  leases: number;
  idleTimer: NodeJS.Timeout | null;
}

export class KafkaConnector implements Connector<KafkaHandle> {
  readonly type = 'kafka';
  private entries = new Map<string, Entry>();

  constructor(private readonly opts: KafkaConnectorOptions) {}

  private idleTtl(): number {
    return typeof this.opts.idleTtlMs === 'function' ? this.opts.idleTtlMs() : this.opts.idleTtlMs;
  }

  private connectTimeout(): number {
    return typeof this.opts.connectTimeoutMs === 'function' ? this.opts.connectTimeoutMs() : this.opts.connectTimeoutMs;
  }

  async acquire(asset: AssetView, _credentialRef: string, principal?: unknown): Promise<KafkaHandle> {
    const userId = (principal as { userId?: string } | undefined)?.userId;
    const conn = await this.opts.resolveConnection(asset, userId ?? undefined);
    const key = [
      asset.id,
      conn.brokers.join(','),
      conn.sasl ? `sasl:${conn.sasl.mechanism}` : 'plain',
      conn.ssl ? 'tls' : 'notls',
    ].join('#');

    let entry = this.entries.get(key);
    if (!entry) {
      const kafka = new Kafka({
        clientId: conn.clientId,
        brokers: conn.brokers,
        ...(conn.ssl ? { ssl: true } : {}),
        ...(conn.sasl ? { sasl: conn.sasl } : {}),
        connectionTimeout: this.connectTimeout(),
        authenticationTimeout: this.connectTimeout(),
        // kafkajs 默认会往 stdout 打大量日志；这里降到 ERROR 避免污染审计输出
        logLevel: logLevel.ERROR,
        retry: { retries: 2, initialRetryTime: 200 },
      });
      entry = { key, kafka, admin: null, adminReady: null, leases: 0, idleTimer: null };
      this.entries.set(key, entry);
    }
    entry.leases++;
    this.cancelIdle(entry);

    const target = entry;
    const handle: KafkaHandle = {
      connection: conn,
      withAdmin: <T>(fn: (admin: Admin) => Promise<T>): Promise<T> =>
        this.ensureAdmin(target).then((admin) => fn(admin)),
    };
    return handle;
  }

  private async ensureAdmin(entry: Entry): Promise<Admin> {
    if (entry.admin && entry.adminReady) return entry.adminReady;
    const admin = entry.kafka.admin();
    entry.admin = admin;
    entry.adminReady = (async () => {
      await admin.connect();
      return admin;
    })().catch((err) => {
      // 连接失败要清掉缓存，否则后续调用会一直拿到 rejected promise
      entry.admin = null;
      entry.adminReady = null;
      throw err;
    });
    return entry.adminReady;
  }

  release(_handle: KafkaHandle): void {
    for (const entry of this.entries.values()) {
      if (entry.leases > 0) {
        entry.leases--;
        if (entry.leases === 0) this.scheduleIdle(entry);
      }
    }
  }

  invalidate(assetId: string): void {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${assetId}#`)) continue;
      void this.dispose(entry);
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
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => this.dispose(e)));
  }

  private scheduleIdle(entry: Entry): void {
    this.cancelIdle(entry);
    entry.idleTimer = setTimeout(() => {
      const cur = this.entries.get(entry.key);
      if (cur === entry && entry.leases === 0) {
        void this.dispose(entry);
        this.entries.delete(entry.key);
      }
    }, this.idleTtl());
    if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
  }

  private cancelIdle(entry: Entry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private async dispose(entry: Entry): Promise<void> {
    this.cancelIdle(entry);
    if (entry.admin) {
      try {
        await entry.admin.disconnect();
      } catch {
        // 断开失败不影响回收
      }
      entry.admin = null;
      entry.adminReady = null;
    }
  }
}
