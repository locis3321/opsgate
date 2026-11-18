/**
 * SSRF 防护（§5.6，ADR-016 fail-closed）：资产 URL 保存时即校验。
 * 判定：解析 DNS → ipaddr.js → 私网/环回/链路本地/云元数据（含 IPv4-mapped IPv6 归一化——
 * memory: ipv4-mapped 绕过的先例，先 ip.ipv4_mapped 归一化再判）。
 * allow_private_network=0 → 拒绝保存；按资产显式开启（默认 0，AC-20）。
 */
import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';

const CLOUD_META = new Set(['169.254.169.254']);

export class SsrfError extends Error {}

/** 校验 URL 主机是否允许（allowPrivateNetwork=true 时仅拒绝云元数据等硬底线） */
export async function assertUrlAllowed(url: string, allowPrivateNetwork: boolean): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SsrfError('URL 无法解析');
  }
  const host = u.hostname;
  if (CLOUD_META.has(host)) throw new SsrfError('云元数据地址禁止访问');
  if (ipaddr.isValid(host)) {
    const addr = ipaddr.parse(host);
    const normalized =
      addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()
        ? (addr as ipaddr.IPv6).toIPv4Address()
        : addr;
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
    const addr = ipaddr.parse(a);
    const normalized =
      addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()
        ? (addr as ipaddr.IPv6).toIPv4Address()
        : addr;
    const range = normalized.range();
    const forbidden = range === 'private' || range === 'loopback' || range === 'linkLocal' || range === 'uniqueLocal' || range === 'unspecified';
    if (!allowPrivateNetwork && forbidden) throw new SsrfError('域名解析到私网地址：需按资产开启 allow_private_network');
  }
}
