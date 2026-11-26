/**
 * SSRF 防护（§5.6，ADR-016 fail-closed）：资产 URL 保存时即校验。
 * 判定：解析 DNS → ipaddr.js → 私网/环回/链路本地/云元数据（含 IPv4-mapped IPv6 归一化——
 * memory: ipv4-mapped 绕过的先例，先 ip.ipv4_mapped 归一化再判）。
 * allow_private_network=0 → 拒绝保存；按资产显式开启（默认 0，AC-20）。
 */
import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';

/** 云元数据地址硬底线（归一化后的 IPv4 字面量；IPv4-mapped IPv6 归一化后同样命中） */
const CLOUD_META = new Set(['169.254.169.254']);

export class SsrfError extends Error {}

/** IPv4-mapped IPv6 归一化为 IPv4（绕过先例：::ffff:169.254.169.254）。 */
function normalizeAddr(host: string): ipaddr.IPv4 | ipaddr.IPv6 {
  const addr = ipaddr.parse(host);
  return addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()
    ? (addr as ipaddr.IPv6).toIPv4Address()
    : addr;
}

/** 归一化地址是否为云元数据（硬底线；与 allowPrivateNetwork 无关，任何情况都拒）。 */
function isCloudMeta(normalized: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  return CLOUD_META.has(normalized.toString());
}

/**
 * 校验 URL 主机是否允许（allowPrivateNetwork=true 时仅拒绝云元数据等硬底线）。
 *
 * 云元数据判定在**归一化之后**：原始实现用 `CLOUD_META.has(u.hostname)` 比未归一化的 hostname，
 * `[::ffff:169.254.169.254]` 的 hostname 是 `[::ffff:a9fe:a9fe]` 不等于字面量；其 range 是 linkLocal，
 * allow=true 时 linkLocal 被放行 → 云元数据可达（2026-11-26 修复）。
 */
export async function assertUrlAllowed(url: string, allowPrivateNetwork: boolean): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SsrfError('URL 无法解析');
  }
  // WHATWG URL 对 IPv6 主机返回带方括号的 hostname（如 "[::ffff:a9fe:a9fe]"），
  // ipaddr.isValid 不认方括号——不剥掉会被误判为"域名"进而 lookup 失败/绕过 IP 判定。
  const rawHost = u.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (ipaddr.isValid(host)) {
    const normalized = normalizeAddr(host);
    if (isCloudMeta(normalized)) throw new SsrfError('云元数据地址禁止访问');
    const range = normalized.range();
    const forbidden = range === 'private' || range === 'loopback' || range === 'linkLocal' || range === 'uniqueLocal' || range === 'unspecified';
    if (!allowPrivateNetwork && forbidden) throw new SsrfError('私网/环回/链路本地地址：需按资产开启 allow_private_network');
    return;
  }
  // 域名：解析后判定（逐一地址校验）
  let addrs: string[];
  try {
    addrs = (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new SsrfError('域名无法解析（fail-closed）');
  }
  for (const a of addrs) {
    const normalized = normalizeAddr(a);
    if (isCloudMeta(normalized)) throw new SsrfError('域名解析到云元数据地址，禁止访问');
    const range = normalized.range();
    const forbidden = range === 'private' || range === 'loopback' || range === 'linkLocal' || range === 'uniqueLocal' || range === 'unspecified';
    if (!allowPrivateNetwork && forbidden) throw new SsrfError('域名解析到私网地址：需按资产开启 allow_private_network');
  }
}

/**
 * CLI 目标地址 → SSRF 校验用的 URL（仅用于取 hostname，不改落库值）。
 *
 * CLI 的目标地址是 `host[:port]` 形态（mysql 的 MYSQL_HOST、redis 的 `host:port`），
 * 用户不会写 `https://`。而 `new URL('db.internal:3306')` 会把 `db.internal:` 当成 scheme、
 * hostname 变成空串——直接丢给 assertUrlAllowed 就是**空转的校验**（fail-open）。
 * 做法：无 `scheme://` 前缀时补一个 `tcp://`，让 host/port 落在标准位置上。
 */
export function cliTargetForSsrf(target: string): string {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target) ? target : `tcp://${target}`;
}

/**
 * CLI 资产目标地址的 SSRF 闸门：Market 实例化、`POST /servers`、`PATCH /servers/:id` 共用同一份判据。
 *
 * 两步都不可省：先归一化成可解析 URL，再**显式**要求解析出主机名。
 * 取不到主机名时 `assertUrlAllowed` 会拿空串去 `lookup('')`——Node 返回空数组而不抛错，
 * 逐个地址的判定循环体一次都不执行，校验静默通过。那不是"通过"，是"没校验"，必须显式拒绝。
 *
 * 落库值仍是用户填的原始 `host:port`（归一化只服务于校验），故本函数不返回改写后的地址。
 */
export async function assertCliTargetAllowed(target: string, allowPrivateNetwork: boolean): Promise<void> {
  const probe = cliTargetForSsrf(target);
  let host = '';
  try {
    host = new URL(probe).hostname;
  } catch {
    host = '';
  }
  if (!host) throw new SsrfError('目标地址无法解析出主机名（需形如 host:port 或带协议头的 URL）');
  await assertUrlAllowed(probe, allowPrivateNetwork);
}
