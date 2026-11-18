/**
 * L0 引导配置（ADR-024 / project-facts.md §4.0）：仅本项目 8 项从 env / key file 读取，
 * UI 不可改。判据：读它之前连不上 DB，或它被用来保护 DB 内容（"为什么不能进 DB"见 facts §4.0）。
 *
 * 缺失项按 facts §4.0 记录的默认值处理（ADMIN_INIT / SESSION_SECRET 无默认，
 * 语义为"首启生成/仅首次生效"，由 T3 落地）；**非法值**（端口、日志级别）启动即失败（fail-fast）。
 */
import path from 'node:path';

export interface BootstrapConfig {
  dataDir: string;
  dbPath: string;
  credentialKeyPath: string;
  port: number;
  bind: string;
  /** 未设置 → 首启生成并持久化（T3 认证） */
  sessionSecret: string | null;
  /** 仅首次启动用于建管理员账号；后续启动可为空 */
  adminInit: string | null;
  logLevel: string;
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function readBootstrap(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
  const dataDir = env.OPSGATE_DATA_DIR ?? './data';

  const portRaw = env.OPSGATE_PORT ?? '8080';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`OPSGATE_PORT 非法值 "${portRaw}"：需为 1-65535 整数`);
  }

  const logLevel = env.OPSGATE_LOG_LEVEL ?? 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new Error(`OPSGATE_LOG_LEVEL 非法值 "${logLevel}"：可选 ${LOG_LEVELS.join(' / ')}`);
  }

  return {
    dataDir,
    dbPath: env.OPSGATE_DB_PATH ?? path.join(dataDir, 'opsgate.db'),
    credentialKeyPath: env.OPSGATE_CREDENTIAL_KEY ?? path.join(dataDir, 'credentials.key'),
    port,
    bind: env.OPSGATE_BIND ?? '127.0.0.1',
    sessionSecret: env.OPSGATE_SESSION_SECRET ?? null,
    adminInit: env.OPSGATE_ADMIN_INIT || null,
    logLevel,
  };
}
