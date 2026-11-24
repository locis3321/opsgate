/**
 * Redis 连接参数解析（Spec §4.3 多槽位 + ADR-028 personal → asset）。
 *
 * 为什么独立成文件：这段逻辑决定"这次连接用哪个地址与口令"，是成员自绑凭证能否生效的唯一开关。
 * 与 `sshCredential.ts` 同构——放在 server.ts 内联时只能靠真实 Redis 才能验证。
 *
 * Redis 资产的连接信息有三种来源，优先级从高到低：
 *   1. 槽位绑定/直填值（`REDIS_PASSWORD` / `REDIS_HOST` / `REDIS_PORT` / `REDIS_TLS` / `REDIS_DB`）
 *   2. 资产 url（`redis://host:port/db`，便于快速登记）
 *   3. 报错（不猜默认端口后静默连 localhost——那是"看起来成功但连错了机器"）
 */
import type { AssetView } from '../framework/types.js';
import type { CredentialService } from './credentials.js';

export interface RedisConnectionSpec {
  host: string;
  port: number;
  password?: string;
  tls: boolean;
  db: number;
}

const SLOT_CANDIDATES = {
  host: ['REDIS_HOST', 'REDIS_ADDR', 'HOST'],
  port: ['REDIS_PORT', 'PORT'],
  password: ['REDIS_PASSWORD', 'REDIS_PWD', 'PASSWORD', 'AUTH'],
  tls: ['REDIS_TLS', 'REDIS_SSL'],
  db: ['REDIS_DB', 'REDIS_DATABASE'],
} as const satisfies Record<string, readonly string[]>;

function pick(credentials: CredentialService, asset: AssetView, userId: string | undefined, names: readonly string[]): string | undefined {
  for (const name of names) {
    const declared = asset.credentialSlots.some((s) => s.name === name);
    if (!declared) continue;
    const v = credentials.resolveSlotValues(asset.id, [name], userId)[0]?.value;
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function parseUrl(raw: string): { host: string; port: number; password?: string; tls: boolean; db: number } | null {
  try {
    const u = new URL(raw);
    if (!/^rediss?:$/.test(u.protocol)) return null;
    const dbPath = u.pathname.replace(/^\//, '');
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 6379,
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      tls: u.protocol === 'rediss:',
      db: dbPath ? Number(dbPath) : 0,
    };
  } catch {
    return null;
  }
}

export function resolveRedisConnection(
  credentials: CredentialService,
  asset: AssetView,
  userId?: string,
): RedisConnectionSpec {
  const fromUrl = asset.url ? parseUrl(asset.url) : null;

  const host = pick(credentials, asset, userId, SLOT_CANDIDATES.host) ?? fromUrl?.host;
  if (!host) {
    throw new Error('未配置 Redis 地址：请在槽位 REDIS_HOST 绑定/直填，或在资产 url 填 redis://host:port/db');
  }
  const portRaw = pick(credentials, asset, userId, SLOT_CANDIDATES.port);
  const port = portRaw ? Number(portRaw) : (fromUrl?.port ?? 6379);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Redis 端口非法："${portRaw}"（应为 1–65535 整数）`);
  }

  const password = pick(credentials, asset, userId, SLOT_CANDIDATES.password) ?? fromUrl?.password;
  const tlsRaw = pick(credentials, asset, userId, SLOT_CANDIDATES.tls);
  const tls = tlsRaw !== undefined ? /^(1|true|yes|on)$/i.test(tlsRaw) : (fromUrl?.tls ?? false);
  const dbRaw = pick(credentials, asset, userId, SLOT_CANDIDATES.db);
  const db = dbRaw ? Number(dbRaw) : (fromUrl?.db ?? 0);
  if (!Number.isInteger(db) || db < 0) {
    throw new Error(`Redis db 非法："${dbRaw}"（应为 ≥0 整数）`);
  }

  return { host, port, ...(password ? { password } : {}), tls, db };
}
