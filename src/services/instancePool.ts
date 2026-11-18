/**
 * 实例池（§5.4，仅服务 execution_mode='mcp' 的资产）：
 * 生命周期 absent → spawning → ready → draining → absent / failed；
 * active 引用计数，0 时启动 idle TTL（unref）；ready 每 60s ping，连续 2 次失败 → 重建；
 * 配额：全局实例预算 / 权重预算（uvx 2、Node 3）与全局拉起并发（64）合一门闩，
 * 不足则排队（15s → PoolBusyError=-32002）；单用户排队超 queue_per_user → 429；
 * 并发降级：同键实例全部被占用时先等 degrade_wait_sec（期间一旦有实例释放即复用），
 * 超窗后才在 instanceCount<maxPerAsset 且预算允许时开副本实例；
 * 预热：拉起 → handshake → listTools → 立即关闭（并发 2，10min 退避）。
 */
import { insecureFetch } from '../native/connectors/insecureFetch.js';
import treeKill from 'tree-kill';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InstancePlan } from './instancePlan.js';
import type { SettingsLike } from '../config/settings.js';
import { cleanupPlanTempFiles } from './instancePlan.js';

export class PoolBusyError extends Error {}
export class PoolTooManyRequestsError extends Error {}
export class PoolSpawnError extends Error {}

export interface InstancePoolConfig {
  globalBudget: number;
  globalWeightBudget: number;
  maxPerAsset: number;
  queuePerUser: number;
  globalConcurrency: number;
  idleTtlMs: number;
  queueTimeoutMs: number;
  degradeWaitMs: number;
  prewarmConcurrency: number;
  prewarmBackoffMs: number;
  runtimeCredsDir: string;
}

export interface InstanceHandle {
  key: string;
  serverId: string;
  client: Client;
  release(): Promise<void>;
}

/**
 * 镜像源环境变量（L1 可配，默认华为云）。导出供测试直接断言，避免测试重复实现。
 * 只注入到子进程，不污染网关自身进程；留空则该项不注入。
 * 映射：npm_config_registry 覆盖 npx/npm；UV_INDEX_URL/PIP_INDEX_URL 覆盖 uvx/pip。
 */
export function buildRegistryEnv(npmRegistry: string | undefined, pypiIndexUrl: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  const npm = npmRegistry?.trim();
  if (npm) env.npm_config_registry = npm;
  const pypi = pypiIndexUrl?.trim();
  if (pypi) {
    env.UV_INDEX_URL = pypi;
    env.PIP_INDEX_URL = pypi;
  }
  return env;
}

type State = 'spawning' | 'ready' | 'draining' | 'failed';

interface Entry {
  entryKey: string;
  /** stdio 子进程 pid（tree-kill 整树回收，§5.2 信号模型） */
  childPid: number | null;
  planKey: string;
  serverId: string;
  plan: InstancePlan;
  state: State;
  client: Client | null;
  refs: number;
  spawnedAt: number;
  lastUsed: number;
  /** refs 从 0 变为 1 的时刻，用于判断久占不下（degrade_wait_sec） */
  busySince?: number;
  idleTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  pingFails: number;
  error?: string;
}

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class InstancePool {
  private entries = new Map<string, Entry>();
  private activeSpawns = 0;
  private waiters: Waiter[] = [];
  private userQueue = new Map<string, number>();
  private prewarmedAt = new Map<string, number>();

  constructor(
    private readonly config: InstancePoolConfig,
    private readonly transportFactory: (plan: InstancePlan) => Transport = (plan) => {
      // 自签证书：资产显式开启 allow_insecure_tls 时，HTTP/SSE 改用不校验证书的 fetch
      const fetchOpt = plan.allowInsecureTls ? { fetch: insecureFetch } : {};
      if (plan.transport === 'sse') {
        return new SSEClientTransport(new URL(plan.url!), { requestInit: { headers: plan.headers }, ...fetchOpt });
      }
      if (plan.transport === 'http') {
        return new StreamableHTTPClientTransport(new URL(plan.url!), { requestInit: { headers: plan.headers }, ...fetchOpt });
      }
      return new StdioClientTransport({
        command: plan.command!,
        args: plan.args,
        // 镜像源注入：资产自身 env 优先（用户显式指定不覆盖），其次全局镜像设置
        env: {
          ...this.registryEnv(),
          ...plan.env,
          // 自签证书：仅该资产显式开启时关闭子进程的证书校验（作用域限该子进程）
          ...(plan.allowInsecureTls ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
        },
        stderr: 'pipe',
      } satisfies StdioServerParameters);
    },
    /** ADR-024 热生效源：提供后，热项（非 requiresRestart）逐次读取，不持有启动快照 */
    private readonly settingsSrc: SettingsLike | null = null,
  ) {}

  /** 热项读取：settings 源优先，缺省回退构造快照（测试/骨架） */
  private hot<T>(key: string): T {
    if (this.settingsSrc) return this.settingsSrc.get<T>(key);
    const map: Record<string, unknown> = {
      'instance_pool.global_budget': this.config.globalBudget,
      'instance_pool.global_weight_budget': this.config.globalWeightBudget,
      'instance_pool.max_per_asset': this.config.maxPerAsset,
      'instance_pool.queue_per_user': this.config.queuePerUser,
      'instance_pool.idle_ttl_sec': this.config.idleTtlMs / 1000,
      'instance_pool.queue_timeout_sec': this.config.queueTimeoutMs / 1000,
      'instance_pool.degrade_wait_sec': this.config.degradeWaitMs / 1000,
    };
    return map[key] as T;
  }

  private weightOf(plan: InstancePlan): number {
    return plan.weightType === 'uvx' ? 2 : 3;
  }

  /** 镜像源环境变量：从 settings 热读（L1 可改），组装逻辑见 buildRegistryEnv */
  private registryEnv(): Record<string, string> {
    // 无 settings 源（测试/骨架）时 hot() 无该键 → undefined，安全跳过
    const npm = this.hot('general.npm_registry') as string | undefined;
    const pypi = this.hot('general.pypi_index_url') as string | undefined;
    return buildRegistryEnv(npm, pypi);
  }

  private liveEntries(): Entry[] {
    return [...this.entries.values()].filter((e) => e.state === 'ready' || e.state === 'spawning');
  }

  private allocatedWeight(): number {
    return this.liveEntries().reduce((acc, e) => acc + this.weightOf(e.plan), 0);
  }

  private instanceCount(planKey: string): number {
    return this.liveEntries().filter((e) => e.planKey === planKey).length;
  }

  /** 门闩：预算/权重/并发任一不足 → 排队；超时 PoolBusyError */
  private async gate(plan: InstancePlan): Promise<void> {
    const canSpawn = () =>
      this.liveEntries().length < this.hot<number>('instance_pool.global_budget') &&
      this.allocatedWeight() + this.weightOf(plan) <= this.hot<number>('instance_pool.global_weight_budget') &&
      this.activeSpawns < this.config.globalConcurrency;
    while (!canSpawn()) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
      () => reject(new PoolBusyError('实例池预算/并发不足，排队超时')),
      this.hot<number>('instance_pool.queue_timeout_sec') * 1000,
    );
        this.waiters.push({
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          timer,
        });
      });
    }
    this.activeSpawns++; // 预留：spawn 观察期占用（不足以完全表示"并发"，但防同批过度拉起）
  }

  private signal(): void {
    this.activeSpawns = Math.max(0, this.activeSpawns - 1);
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    }
  }

  /**
   * acquire：复用 ready（空闲者优先）→ 复用忙碌实例（多路复用）→ 长调用超窗时降级副本 → 排队拉起。
   * 抛 PoolBusyError(-32002) / PoolTooManyRequestsError(429) / PoolSpawnError。
   *
   * 降级语义（instance_pool.degrade_wait_sec 的唯一消费点）：
   * 同一个实例上的调用已经**持续运行**超过该窗口，且新请求进来时仍全忙 → 开副本，
   * 让长查询不再把后续请求一起堵住。窗口内的并发仍然复用同一实例（AC-11：
   * 稳态实例数不随用户数增长，否则 20 个人同时点一下就翻倍）。
   * `allowDegrade: false` 是显式退出开关（只复用/排队，不开副本）。
   */
  async acquire(plan: InstancePlan, userId: string, opts: { allowDegrade?: boolean } = {}): Promise<InstanceHandle> {
    const slotKey = `${userId}:${plan.instanceKey}`;
    this.enterQueue(slotKey);
    try {
      const ready = () => this.liveEntries().filter((e) => e.planKey === plan.instanceKey && e.state === 'ready' && e.client);

      const free = ready().find((e) => e.refs === 0);
      if (free) return this.takeRef(free);

      const busy = ready();
      if (busy.length > 0) {
        const degradeAfterMs = this.hot<number>('instance_pool.degrade_wait_sec') * 1000;
        const longest = busy.reduce((acc, e) => {
          const since = e.busySince ?? e.lastUsed;
          return Math.max(acc, Date.now() - since);
        }, 0);
        const canDegrade =
          opts.allowDegrade !== false &&
          longest >= degradeAfterMs &&
          busy.length < this.hot<number>('instance_pool.max_per_asset') &&
          this.liveEntries().length < this.hot<number>('instance_pool.global_budget') &&
          this.allocatedWeight() + this.weightOf(plan) <= this.hot<number>('instance_pool.global_weight_budget');
        if (canDegrade) {
          await this.gate(plan);
          const entry = await this.spawn(plan, `${plan.instanceKey}~${busy.length + 1}`);
          this.entries.set(entry.entryKey, entry);
          this.takeRef(entry);
          this.signal();
          return this.handle(entry);
        }
        // 多路复用：同一实例可以被多个调用同时持有（release 时 refs 递减）
        return this.takeRef(busy.sort((a, b) => a.refs - b.refs)[0]!);
      }

      await this.gate(plan);
      const entry = await this.spawn(plan, plan.instanceKey);
      this.entries.set(entry.entryKey, entry);
      this.takeRef(entry);
      this.signal();
      return this.handle(entry);
    } finally {
      this.leaveQueue(slotKey);
    }
  }

  /** 占用一个引用（首个引用记下忙碌起点，供 degrade_wait 判定）并取消 idle 计时 */
  private takeRef(entry: Entry): InstanceHandle {
    if (entry.refs === 0) entry.busySince = Date.now();
    entry.refs++;
    this.cancelIdle(entry);
    return this.handle(entry);
  }

  private async spawn(plan: InstancePlan, entryKey: string): Promise<Entry> {
    const entry: Entry = {
      entryKey,
      childPid: null,
      planKey: plan.instanceKey,
      serverId: plan.serverId,
      plan,
      state: 'spawning',
      client: null,
      refs: 0,
      spawnedAt: Date.now(),
      lastUsed: Date.now(),
      idleTimer: null,
      pingTimer: null,
      pingFails: 0,
    };
    const client = new Client({ name: 'opsgate', version: '0.1.0' });
    let transport: Transport | null = null;
    // 子进程 stderr（uvx 解析失败、包缺失、依赖冲突等）—— 否则只报无用的 "Connection closed"
    let stderrTail = '';
    try {
      transport = this.transportFactory(plan);
      const stderrStream = (transport as { stderr?: NodeJS.ReadableStream | null }).stderr;
      stderrStream?.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      });
      await client.connect(transport);
      // SDK 的 close 只杀父进程；uvx/npx 会拉起子进程树，必须 tree-kill（agreed：tree-kill @ §5.2）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = (transport as any)._process as { pid?: number } | undefined;
      entry.childPid = proc?.pid ?? null;
      entry.client = client;
      entry.state = 'ready';
      this.startPing(entry);
      return entry;
    } catch (err) {
      entry.state = 'failed';
      const base = err instanceof Error ? err.message : String(err);
      const tail = stderrTail.trim().split('\n').filter(Boolean).slice(-4).join(' | ');
      entry.error = tail ? `${base}（子进程输出：${tail}）` : base;
      cleanupPlanTempFiles(plan);
      this.signal();
      throw new PoolSpawnError(entry.error);
    }
  }

  private handle(entry: Entry): InstanceHandle {
    return {
      key: entry.planKey,
      serverId: entry.serverId,
      client: entry.client!,
      release: async () => {
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs === 0 && entry.state === 'ready') this.scheduleIdle(entry);
      },
    };
  }

  /** 凭证轮换/配置变更：该键全部实例立即 drain（AC-23）；新 acquire 走新键 */
  invalidate(planKey: string): void {
    for (const [k, entry] of [...this.entries]) {
      if (entry.planKey === planKey) {
        this.closeEntry(entry);
        this.entries.delete(k);
        this.signal();
      }
    }
  }

  async releaseAll(): Promise<void> {
    for (const [k, entry] of [...this.entries]) {
      this.closeEntry(entry);
      this.entries.delete(k);
    }
    for (const w of this.waiters.splice(0)) clearTimeout(w.timer);
  }

  stats(): {
    instances: number;
    ready: number;
    spawning: number;
    failing: number;
    allocatedWeight: number;
    globalBudget: number;
    perAsset: Record<string, number>;
  } {
    const perAsset: Record<string, number> = {};
    for (const e of this.liveEntries()) perAsset[e.serverId] = (perAsset[e.serverId] ?? 0) + 1;
    const vals = [...this.entries.values()];
    return {
      instances: this.liveEntries().length,
      ready: vals.filter((e) => e.state === 'ready').length,
      spawning: vals.filter((e) => e.state === 'spawning').length,
      failing: vals.filter((e) => e.state === 'failed').length,
      allocatedWeight: this.allocatedWeight(),
      globalBudget: this.config.globalBudget,
      perAsset,
    };
  }

  list(): Array<{ key: string; serverId: string; state: string; refs: number; spawnedAt: number; lastUsed: number; pid: number | null; error?: string }> {
    return [...this.entries.values()].map((e) => ({
      key: e.planKey,
      serverId: e.serverId,
      state: e.state,
      refs: e.refs,
      spawnedAt: e.spawnedAt,
      lastUsed: e.lastUsed,
      pid: e.childPid,
      error: e.error,
    }));
  }

  /**
   * 管理员显式关闭单个实例（2026-11-18 T4）。与 invalidate 同语义的强制关闭：
   * 正在使用它的调用会失败——这是管理动作，不做优雅排空。
   */
  closeByEntryKey(entryKey: string): boolean {
    const entry = this.entries.get(entryKey);
    if (!entry) return false;
    this.closeEntry(entry);
    this.entries.delete(entryKey);
    this.signal();
    return true;
  }

  /** entryKey → 资产 id（运行时页需要知道关的是谁的实例） */
  assetOfEntry(entryKey: string): string | null {
    return this.entries.get(entryKey)?.serverId ?? null;
  }

  /** 预热：拉起 → listTools → 立即关闭；10min 退避（§5.4） */
  async prewarm(plan: InstancePlan): Promise<boolean> {
    const last = this.prewarmedAt.get(plan.instanceKey) ?? 0;
    if (Date.now() - last < this.config.prewarmBackoffMs) return false;
    this.prewarmedAt.set(plan.instanceKey, Date.now());
    await this.gate(plan);
    let entry: Entry | null = null;
    try {
      entry = await this.spawn(plan, `${plan.instanceKey}~prewarm`);
      await entry.client!.listTools();
      return true;
    } finally {
      if (entry) {
        this.closeEntry(entry);
        this.entries.delete(entry.entryKey);
      }
      this.signal();
    }
  }

  private startPing(entry: Entry): void {
    entry.pingTimer = setInterval(async () => {
      if (entry.state !== 'ready' || !entry.client) return;
      try {
        await entry.client.listTools();
        entry.pingFails = 0;
      } catch {
        entry.pingFails++;
        if (entry.pingFails >= 2) {
          entry.state = 'failed';
          entry.error = 'ping 连续 2 次失败';
          this.closeEntry(entry);
          this.entries.delete(entry.entryKey);
          this.signal();
        }
      }
    }, 60_000);
    entry.pingTimer.unref?.();
  }

  private scheduleIdle(entry: Entry): void {
    this.cancelIdle(entry);
    entry.idleTimer = setTimeout(() => {
      if (entry.refs === 0 && entry.state === 'ready') {
        entry.state = 'draining';
        this.closeEntry(entry);
        this.entries.delete(entry.entryKey);
        this.signal();
      }
    }, this.hot<number>('instance_pool.idle_ttl_sec') * 1000);
    entry.idleTimer.unref?.();
  }

  private cancelIdle(entry: Entry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private closeEntry(entry: Entry): void {
    this.cancelIdle(entry);
    if (entry.pingTimer) {
      clearInterval(entry.pingTimer);
      entry.pingTimer = null;
    }
    if (entry.childPid) {
      try {
        treeKill(entry.childPid, 'SIGTERM');
      } catch {
        // 已退出
      }
      entry.childPid = null;
    }
    try {
      void entry.client?.close();
    } catch {
      // 已关闭
    }
    cleanupPlanTempFiles(entry.plan);
  }

  private enterQueue(slotKey: string): void {
    const q = this.userQueue.get(slotKey) ?? 0;
    if (q >= this.hot<number>('instance_pool.queue_per_user')) throw new PoolTooManyRequestsError('单用户排队超限');
    this.userQueue.set(slotKey, q + 1);
  }

  private leaveQueue(slotKey: string): void {
    const q = (this.userQueue.get(slotKey) ?? 0) - 1;
    if (q <= 0) this.userQueue.delete(slotKey);
    else this.userQueue.set(slotKey, q);
  }
}
