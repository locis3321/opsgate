/**
 * Kafka 连接参数解析（Spec §4.3 多槽位 + ADR-028 personal → asset）。
 *
 * 与 `redisConnection.ts` 同构。Kafka 的连接信息来源：
 *   1. 槽位（`KAFKA_BROKERS` / `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` / `KAFKA_SASL_MECHANISM` / `KAFKA_SSL`）
 *   2. 资产 url（`kafka://broker1:9092,broker2:9092`）
 *   3. 报错
 *
 * 安全默认：**没有显式给 SASL 就按无认证连**（内网常见），但绝不默认关闭 TLS 校验——
 * `KAFKA_SSL` 缺省 false 与 kafkajs 默认一致；开启后使用系统 CA。
 */
import type { AssetView } from '../framework/types.js';
import type { CredentialService } from './credentials.js';
import type { KafkaConnection } from '../native/connectors/kafka.js';
import type { SASLOptions } from 'kafkajs';

const SLOT_CANDIDATES = {
  brokers: ['KAFKA_BROKERS', 'KAFKA_BOOTSTRAP_SERVERS', 'BROKERS'],
  username: ['KAFKA_SASL_USERNAME', 'KAFKA_USERNAME', 'SASL_USERNAME'],
  password: ['KAFKA_SASL_PASSWORD', 'KAFKA_PASSWORD', 'SASL_PASSWORD'],
  mechanism: ['KAFKA_SASL_MECHANISM', 'SASL_MECHANISM'],
  ssl: ['KAFKA_SSL', 'KAFKA_TLS'],
} as const satisfies Record<string, readonly string[]>;

function pick(credentials: CredentialService, asset: AssetView, userId: string | undefined, names: readonly string[]): string | undefined {
  for (const name of names) {
    if (!asset.credentialSlots.some((s) => s.name === name)) continue;
    const v = credentials.resolveSlotValues(asset.id, [name], userId)[0]?.value;
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** `kafka://a:9092,b:9092` → ['a:9092', 'b:9092'] */
function brokersFromUrl(raw: string): string[] | null {
  const m = /^kafka:\/\/(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const list = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

export function resolveKafkaConnection(
  credentials: CredentialService,
  asset: AssetView,
  userId?: string,
): KafkaConnection {
  const brokersRaw = pick(credentials, asset, userId, SLOT_CANDIDATES.brokers);
  const brokers = brokersRaw
    ? brokersRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : (asset.url ? brokersFromUrl(asset.url) : null);

  if (!brokers || brokers.length === 0) {
    throw new Error(
      '未配置 Kafka broker：请在槽位 KAFKA_BROKERS 绑定/直填（逗号分隔），或在资产 url 填 kafka://host:9092',
    );
  }
  for (const b of brokers) {
    if (!/^[^:\s]+:\d{1,5}$/.test(b)) {
      throw new Error(`Kafka broker 格式非法："${b}"（应为 host:port）`);
    }
  }

  const username = pick(credentials, asset, userId, SLOT_CANDIDATES.username);
  const password = pick(credentials, asset, userId, SLOT_CANDIDATES.password);
  const mechRaw = (pick(credentials, asset, userId, SLOT_CANDIDATES.mechanism) ?? 'plain').toLowerCase();
  const sslRaw = pick(credentials, asset, userId, SLOT_CANDIDATES.ssl);
  const ssl = sslRaw !== undefined ? /^(1|true|yes|on)$/i.test(sslRaw) : false;

  let sasl: SASLOptions | undefined;
  if (username && password) {
    if (mechRaw === 'plain') {
      sasl = { mechanism: 'plain', username, password };
    } else if (mechRaw === 'scram-sha-256') {
      sasl = { mechanism: 'scram-sha-256', username, password };
    } else if (mechRaw === 'scram-sha-512') {
      sasl = { mechanism: 'scram-sha-512', username, password };
    } else {
      throw new Error(`不支持的 SASL 机制："${mechRaw}"（plain / scram-sha-256 / scram-sha-512）`);
    }
  } else if (username || password) {
    throw new Error('SASL 认证需要同时提供用户名与密码');
  }

  return {
    brokers,
    clientId: `opsgate-${asset.name}`.slice(0, 64),
    ssl,
    ...(sasl ? { sasl } : {}),
  };
}
