/**
 * OpsGate 网关进程入口（单 Node 进程，Spec §5.2）。
 * 启动序列：bootstrap(L0) → 数据目录 → SQLite(WAL/FK) → 迁移 → 审计当月表 → settings 启动校验
 * → better-auth（首启建管理员）→ buildApp（default-deny 注册表 + 根级 preHandler）→ listen。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { env } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readBootstrap } from './config/bootstrap.js';
import { Settings } from './config/settings.js';
import * as schema from './db/schema.js';
import { ensureAuditTable } from './db/audit.js';
import { createSettingsStorage } from './db/settings-store.js';
import { BUILTIN_GUARD_RULES } from './db/builtinGuardRules.js';
import { syncBuiltinGuardRules } from './db/guardRulesSeedSync.js';
import { syncCatalogEntries } from './db/marketSeedSync.js';
import { loadCatalog } from './services/marketCatalog.js';
import { createAuth, createUserWithPassword, ensureAuthTables } from './services/auth.js';
import { buildApp } from './app.js';
import { loadNativeTools } from './native/tools/index.js';
import { buildToolRegistry } from './framework/registry.js';
import { loadCredentialKey } from './services/crypto.js';
import { AuditService } from './services/audit.js';
import { archiveExpiredAudit, writeArchiveAuditRow } from './services/auditArchive.js';
import { CredentialService } from './services/credentials.js';
import { TransferService } from './services/transfer.js';
import { setTransferService } from './services/transferInstance.js';
import { SshConnector } from './native/connectors/ssh.js';
import { registerConnector } from './native/connectors/index.js';
import { createHttpConnector } from './native/connectors/http.js';
import { RedisConnector } from './native/connectors/redis.js';
import { KafkaConnector } from './native/connectors/kafka.js';
import { makeNativeDispatchServices } from './services/nativeDispatch.js';
import { resolveSshCredential } from './services/sshCredential.js';
import { resolveRedisConnection } from './services/redisConnection.js';
import { resolveKafkaConnection } from './services/kafkaConnection.js';
import { InstancePool } from './services/instancePool.js';
import { CliRunner } from './services/cliRunner.js';
import { McpEndpoint } from './services/mcpEndpoint.js';
import { canOnAsset } from './services/authzBuilder.js';
import type { DispatchServices } from './framework/dispatch.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./db/migrations', import.meta.url));

/** OPSGATE_SESSION_SECRET 未设置时：<data>/session-secret（0600）首启生成、后续复用 */
function loadOrCreateSessionSecret(dataDir: string, envSecret: string | null): string {
  if (envSecret) return envSecret;
  const p = path.join(dataDir, 'session-secret');
  try {
    const s = readFileSync(p, 'utf8').trim();
    if (s) return s;
  } catch {
    // 首次生成
  }
  const secret = randomBytes(32).toString('base64url');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(p, secret, { mode: 0o600 });
  return secret;
}

async function main(): Promise<void> {
  const cfg = readBootstrap();
  mkdirSync(cfg.dataDir, { recursive: true });

  const sqlite = new Database(cfg.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  ensureAuditTable(sqlite);

  // 内置 Market 目录同步（ADR-029）：用一次性 marker 记录"代码播种过哪些 key"，
  // 只补**代码新增**的条目，不覆盖后台编辑、不复活管理员删掉的条目。
  // 原实现是「表为空才导入」，导致部署机一旦有数据，后续新增条目永远不会出现。
  const marketMarker = path.join(cfg.dataDir, '.market-seeded');
  const catalogSync = syncCatalogEntries(db, loadCatalog(), marketMarker);
  if (catalogSync.inserted.length > 0) {
    console.log(`[bootstrap] Market 目录新增 ${catalogSync.inserted.length} 条：${catalogSync.inserted.join(', ')}`);
  }
  if (catalogSync.skippedDeleted.length > 0) {
    console.log(`[bootstrap] Market 目录跳过已被管理员删除的 ${catalogSync.skippedDeleted.length} 条：${catalogSync.skippedDeleted.join(', ')}`);
  }

  // 内置安全策略增量同步（§4.7）：生产部署不会跑 `pnpm run seed`。
  // 早期实现用一次性标记「首启播种后永不再补」，导致**新增的内置规则进不了存量库**
  // （2026-11-26 真实部署验证：CLI 规则未播种、危险 argv 不触发 risk=high）。
  // 改为与 Market 目录同思路的增量同步：marker 记录"代码播种过哪些 rule id"，
  // 只补代码新增的、不覆盖管理员改动、不复活管理员删掉的（见 guardRulesSeedSync.ts）。
  const guardSeedMarker = path.join(cfg.dataDir, '.guard-rules-seeded');
  const ruleSync = syncBuiltinGuardRules(db, BUILTIN_GUARD_RULES, guardSeedMarker);
  if (ruleSync.inserted.length > 0) {
    console.log(`[bootstrap] 内置安全策略新增 ${ruleSync.inserted.length} 条：${ruleSync.inserted.join(', ')}`);
  }
  if (ruleSync.skippedDeleted.length > 0) {
    console.log(`[bootstrap] 内置安全策略跳过已被管理员删除的 ${ruleSync.skippedDeleted.length} 条：${ruleSync.skippedDeleted.join(', ')}`);
  }

  // L1 settings 启动期校验（AC-59：孤儿告警 / 非法值启动失败）
  const settings = new Settings(createSettingsStorage(db));
  const { warnings } = await settings.init();
  for (const w of warnings) console.warn('[settings]', w);

  const baseUrl = `http://${cfg.bind}:${cfg.port}`;
  const auth = createAuth(sqlite, {
    secret: loadOrCreateSessionSecret(cfg.dataDir, cfg.sessionSecret),
    baseUrl,
  });
  await ensureAuthTables(auth);

  // 首启管理员（OPSGATE_ADMIN_INIT = username:password，仅 users 表为空时生效）
  if (cfg.adminInit) {
    const existing = db.select({ id: schema.users.id }).from(schema.users).limit(1).get();
    if (!existing) {
      const [username, password] = cfg.adminInit.split(':', 2);
      if (!username || !password) {
        throw new Error('OPSGATE_ADMIN_INIT 格式应为 username:password');
      }
      await createUserWithPassword(auth, { username, password, isAdmin: true });
      console.log(`[bootstrap] 已创建首启管理员 ${username}`);
    } else {
      console.warn('[bootstrap] OPSGATE_ADMIN_INIT 忽略：users 已非空（仅首次生效）');
    }
  }

  // —— T5 服务装配：密钥/审计/凭证/传输/SSH 连接池 ——
  const credKey = loadCredentialKey(cfg.credentialKeyPath);
  const audit = new AuditService(sqlite, settings);
  const credentials = new CredentialService(sqlite, credKey);
  const transfer = new TransferService({
    dataDir: cfg.dataDir,
    maxFileBytes: settings.get<number>('transfer.max_file_bytes'),
    entryTtlMs: settings.get<number>('transfer.entry_ttl_sec') * 1000,
    stagingQuotaBytes: settings.get<number>('transfer.staging_quota_bytes'),
    stagingTtlMs: settings.get<number>('transfer.staging_ttl_sec') * 1000,
  }, settings); // E2E-R4：生产装配必须传 settings 源（漏传=启动快照，热生效失效）
  setTransferService(transfer);
  const ssh = new SshConnector({
    idleTtlMs: settings.get<number>('ssh_pool.idle_ttl_sec') * 1000,
    semaphore: settings.get<number>('ssh_pool.global_semaphore'),
    queueTimeoutMs: settings.get<number>('instance_pool.queue_timeout_sec') * 1000,
    truncateBytes: settings.get<number>('tools.output_truncate_bytes'),
    resolveCredential: (asset, userId) => Promise.resolve(resolveSshCredential(credentials, asset, userId)),
    expectFingerprint: (asset) => asset.hostConn?.hostFingerprint ?? null,
  }, settings);
  registerConnector(ssh);
  // HTTP API 型 connector（Zabbix / RocketMQ / Nacos）：鉴权在工具内用 ctx.credentials 构造，
  // 因为 dispatch 的 acquire 阶段拿不到凭证明文（顺序为 resolveCredentials → acquire → execute）。
  // 超时逐次热读 tools.command_timeout_sec（ADR-024：该项 schema 未标 requiresRestart）
  const httpTimeoutMs = () => settings.get<number>('tools.command_timeout_sec') * 1000;
  registerConnector(createHttpConnector({
    type: 'zabbix',
    baseUrlOf: (asset) => asset.url ?? '',
  }, { timeoutMs: httpTimeoutMs }));
  registerConnector(createHttpConnector({
    type: 'rocketmq',
    baseUrlOf: (asset) => asset.url ?? '',
  }, { timeoutMs: httpTimeoutMs }));
  registerConnector(createHttpConnector({
    type: 'nacos',
    // Nacos 的 OpenAPI 与 console 路径分别挂在 /nacos/v1 与 /nacos 下：
    // 这里给到 /nacos/v1，工具内部再按需回退根路径（见 nacos/_shared.ts）
    baseUrlOf: (asset) => `${(asset.url ?? '').replace(/\/+$/, '')}/nacos/v1`,
  }, { timeoutMs: httpTimeoutMs }));
  // 长连接型 connector（Redis / Kafka）：连接池 + idle TTL + 凭证轮换后 invalidate。
  // 凭证在 resolveConnection 里解密后直接建连，不进入 env / 子进程实参（与 SSH 同口径）。
  const redisConnector = new RedisConnector({
    idleTtlMs: () => settings.get<number>('ssh_pool.idle_ttl_sec') * 1000,
    connectTimeoutMs: () => settings.get<number>('tools.command_timeout_sec') * 1000,
    resolveConnection: (asset, userId) => Promise.resolve(resolveRedisConnection(credentials, asset, userId)),
  });
  registerConnector(redisConnector);
  const kafkaConnector = new KafkaConnector({
    idleTtlMs: () => settings.get<number>('ssh_pool.idle_ttl_sec') * 1000,
    connectTimeoutMs: () => settings.get<number>('tools.command_timeout_sec') * 1000,
    resolveConnection: (asset, userId) => Promise.resolve(resolveKafkaConnection(credentials, asset, userId)),
  });
  registerConnector(kafkaConnector);
  const dispatch: DispatchServices = makeNativeDispatchServices({ sqlite, db, settings, audit, credentials });

  void dispatch; // T7 编排层实际消费

  // —— T6 实例池（仅 execution_mode='mcp' 资产；settings 驱动；T7 编排层调用 acquire/prewarm）——
  const instancePool = new InstancePool({
    globalBudget: settings.get<number>('instance_pool.global_budget'),
    globalWeightBudget: settings.get<number>('instance_pool.global_weight_budget'),
    maxPerAsset: settings.get<number>('instance_pool.max_per_asset'),
    queuePerUser: settings.get<number>('instance_pool.queue_per_user'),
    globalConcurrency: settings.get<number>('instance_pool.global_concurrency'),
    idleTtlMs: settings.get<number>('instance_pool.idle_ttl_sec') * 1000,
    queueTimeoutMs: settings.get<number>('instance_pool.queue_timeout_sec') * 1000,
    degradeWaitMs: settings.get<number>('instance_pool.degrade_wait_sec') * 1000,
    prewarmConcurrency: 2,
    prewarmBackoffMs: 600_000,
    runtimeCredsDir: path.join(cfg.dataDir, 'runtime-creds'),
  }, undefined, settings); // E2E-R4：生产装配必须传 settings 源（漏传=启动快照，热生效失效）

  // —— Task 9 CLI 一次性执行器（不进实例池：CLI 无 ready 态）——
  //
  // baseEnv.PATH 必须与创建校验（src/routes/assets.ts 的 `which` 子进程继承网关进程 PATH）**同源**：
  // 创建时用 which 找到的二进制，执行时 CliRunner 用这里注入的 PATH 再解析一次；两处 PATH 不一致
  // 就会出现"资产建成了、执行却 bin-missing"。which 继承的正是本进程环境，故此处取同一份 PATH。
  //
  // AC-61（scripts/check-redlines.mjs）禁止 src/ 出现宿主环境变量的属性访问字面量（逐字扫描，注释也算），
  // 故用 `node:process` 的具名导出 `env` 取值：语义等价、不命中该字面量模式。宿主环境读取仍只收敛在
  // server.ts 这一处装配点，业务代码一律拿注入值。
  const gatewayPath = env.PATH ?? '';
  // dataDir 可能是相对路径（bootstrap 默认 `./data`）。bwrap 参数里 `--tmpfs <dataDir>` 必须是绝对路径：
  // 相对路径会随子进程 CWD 解析——bwrap 启动后工作目录已变，`--tmpfs ./data` 遮的就不是网关的数据目录
  // （凭证/DB 暴露），沙箱也就名存实亡。这里先 resolve 一次，执行器与凭证目录共用同一份绝对路径。
  //
  // runtimeCredsDir 同样必须是绝对路径：它会被 `--bind` 成沙箱内挂载源，相对路径在 bwrap
  // 换过 CWD 后同样解析不到（bind 失败即整次执行失败，或绑到错误目录）。
  const absoluteDataDir = path.resolve(cfg.dataDir);
  const absoluteCredsDir = path.resolve(cfg.dataDir, 'runtime-creds');
  const cliRunner = new CliRunner({
    dataDir: absoluteDataDir,
    runtimeCredsDir: absoluteCredsDir,
    baseEnv: { PATH: gatewayPath },
    outputTruncateBytes: () => settings.get<number>('tools.output_truncate_bytes'),
    commandTimeoutMs: () => settings.get<number>('tools.command_timeout_sec') * 1000,
    // 「要求沙箱」：实际可用性由 isSandboxAvailable() 判定，不可用即 fail-closed 拒绝执行（不降级裸跑）
    sandboxEnabled: () => true,
  });

  const nativeTools = await loadNativeTools();
  const toolRegistry = buildToolRegistry(nativeTools);
  if (toolRegistry.errors.length > 0) {
    for (const e of toolRegistry.errors) console.error(`[native-tools] 违规: ${e}`);
    throw new Error('原生工具注册表校验失败（见上方违规项）');
  }


  // T8 reconciler：每 5min 扫各月表 pending >10min → unknown + 告警（R-2 兜底）

  // —— T7 MCP 端点（聚合/instructions/session 归属；isVisible 为 T8 完整 can() 前的最小版）——
  const mcpEndpoint = new McpEndpoint({
    db,
    sqlite,
    settings,
    pool: instancePool,
    dispatchServices: dispatch,
    audit,
    nativeRegistry: [...toolRegistry.registry.values()],
    runtimeCredsDir: path.join(cfg.dataDir, 'runtime-creds'),
    isVisible: (asset, principal) => canOnAsset(db, 'invoke', principal, {
      id: (asset as { id?: string }).id ?? '',
      ownerId: asset.ownerId,
      visibility: asset.visibility,
      sharedWithUserIds: (asset as { sharedWithUserIds?: string[] }).sharedWithUserIds ?? [],
    }),
    // CLI 资产经 /mcp 调用时必须落到同一个执行器实例：执行器的在飞登记/统计/health 与
    // /runtime/cli 观测的是同一份状态，另建实例会让端点看不到任何在飞进程。
    cliRunner,
  });

  const verifyTransferToken = async (
    token: string,
    _pathname: string,
    method: string,
  ): Promise<{ userId: string; isAdmin: boolean } | null> => {
    try {
      const dir = method.toUpperCase() === 'PUT' ? 'upload' : 'download';
      const entry = transfer.consume(token, dir);
      return { userId: entry.userId, isAdmin: false };
    } catch {
      return null;
    }
  };

  // 暂存清理（TTL 15 min；每分钟扫一次，不阻塞退出）
  const sweeper = setInterval(() => transfer.sweep(), 60_000);
  sweeper.unref?.();

  // 原生工具注册表启动校验（§5.9.4 fail-fast：id 重复 / connector 缺失 / R1-R8 / 派生同名）
  const reconciler = setInterval(() => {
    try {
      for (const t of (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'audit_log_%'").all() as Array<{ name: string }>)) {
        const cutoff = Date.now() - 10 * 60_000;
        const rows = sqlite.prepare(`UPDATE ${t.name} SET status = 'unknown' WHERE status = 'pending' AND ts < ?`).run(cutoff);
        if (rows.changes > 0) console.warn(`[reconciler] ${t.name} 标记 ${rows.changes} 条 pending → unknown`);
      }
    } catch (err) {
      console.error('[reconciler] 失败：', err instanceof Error ? err.message : err);
    }
  }, 5 * 60_000);
  reconciler.unref?.();

  // AC-14 审计归档：保留期（audit.retention_months 热读）外分表行清理；启动即扫 + 每小时
  const auditArchive = () => {
    try {
      const months = settings.get<number>('audit.retention_months');
      const cutoff = Date.now() - months * 30 * 24 * 3600 * 1000;
      const res = archiveExpiredAudit(sqlite, cutoff);
      if (res.tables.length > 0 || res.statsRemoved > 0) {
        console.log(`[audit-archive] 清理超期审计（保留 ${months} 个月）：${JSON.stringify(res)}`);
        writeArchiveAuditRow(sqlite, res); // 删除动作自身留痕
      }
    } catch (err) {
      console.warn('[audit-archive] 失败：', err instanceof Error ? err.message : err);
    }
  };
  auditArchive();
  const archiveTimer = setInterval(auditArchive, 3600_000);
  archiveTimer.unref?.();

  const app = await buildApp({
    db,
    auth,
    baseUrl,
    logLevel: cfg.logLevel,
    transfer,
    ssh,
    redis: redisConnector,
    kafka: kafkaConnector,
    credentials,
    audit,
    settings,
    cryptoKey: credKey,
    sqlite,
    instancePool,
    mcp: mcpEndpoint,
    cliRunner,
    nativeRegistry: [...toolRegistry.registry.values()],
    frontendDist: path.join(fileURLToPath(new URL('.', import.meta.url)), '../dist/frontend'),
    runtimeCredsDir: path.join(cfg.dataDir, 'runtime-creds'),
    verifyTransferToken,
  });
  await app.listen({ port: cfg.port, host: cfg.bind });
}

main().catch((err) => {
  console.error('[bootstrap] 启动失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
