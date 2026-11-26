/**
 * SSRF 校验（AC-20 / ADR-016）：私网/环回/链路本地/云元数据拒绝；
 * IPv4-mapped IPv6 归一化（绕过先例）；allow_private_network 显式开启后放行（云元数据始终拒）。
 */
import { describe, expect, it } from 'vitest';
import { assertCliTargetAllowed, cliTargetForSsrf, assertUrlAllowed, SsrfError } from './ssrf.js';

describe('ssrf（§5.6 fail-closed）', () => {
  it('私网 10.0.0.1 / 环回 127.0.0.1 / 链路本地 169.254.0.1 → 拒绝', async () => {
    for (const host of ['10.0.0.1', '127.0.0.1', '169.254.0.1']) {
      await expect(assertUrlAllowed(`http://${host}:3306`, false)).rejects.toThrow(SsrfError);
    }
  });

  it('IPv4-mapped IPv6（::ffff:10.0.0.1）→ 归一化后拒绝（绕过先例）', async () => {
    await expect(assertUrlAllowed('http://[::ffff:10.0.0.1]/', false)).rejects.toThrow(SsrfError);
    await expect(assertUrlAllowed('http://[::ffff:169.254.169.254]/', false)).rejects.toThrow(SsrfError);
  });

  it('云元数据 169.254.169.254：allow=true 也拒绝（硬底线）', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/', true)).rejects.toThrow(/云元数据/);
  });

  it('云元数据 IPv4-mapped 各种写法：allow=true 也拒绝（硬底线，堵绕过）', async () => {
    // 原始漏洞：CLOUD_META.has(hostname) 比对未归一化 hostname，[::ffff:a9fe:a9fe] 不等于字面量；
    // 归一化后 range=linkLocal，allow=true 时 linkLocal 被放行 → 云元数据可达。
    for (const u of [
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:169.254.169.254]:80/',
      'http://[0:0:0:0:0:ffff:169.254.169.254]/', // 全展开写法
    ]) {
      await expect(assertUrlAllowed(u, true)).rejects.toThrow(/云元数据/);
    }
  });

  it('公网地址允许；allow=true 时私网放行（显式开启语义）', async () => {
    await expect(assertUrlAllowed('http://8.8.8.8/', false)).resolves.toBeUndefined();
    await expect(assertUrlAllowed('http://10.1.2.3/', true)).resolves.toBeUndefined();
  });
});

/**
 * cli 目标地址（裸 `host:port`）的归一化闸门。
 *
 * 旁路：`new URL('db.internal:3306')` 的 hostname 是空串，`lookup('')` 返回空数组不抛错，
 * 判定循环一次都不跑 → 静默通过。以下用例钉住"必须真的判定到地址"。
 */
describe('cliTargetForSsrf / assertCliTargetAllowed', () => {
  it('裸 host:port 补 tcp:// 前缀；已有协议头原样返回', () => {
    expect(cliTargetForSsrf('db.internal:3306')).toBe('tcp://db.internal:3306');
    expect(cliTargetForSsrf('10.0.0.5:3306')).toBe('tcp://10.0.0.5:3306');
    expect(cliTargetForSsrf('localhost')).toBe('tcp://localhost');
    expect(cliTargetForSsrf('https://k8s.example.invalid:6443')).toBe('https://k8s.example.invalid:6443');
    // URL 会把 `db.internal:` 当 scheme（这正是必须归一化的原因）
    expect(new URL('db.internal:3306').hostname).toBe('');
  });

  it('私网 IP 的裸目标 → 拒绝（allow=false）；显式开启私网 → 放行', async () => {
    await expect(assertCliTargetAllowed('10.0.0.5:3306', false)).rejects.toThrow(SsrfError);
    await expect(assertCliTargetAllowed('127.0.0.1:6379', false)).rejects.toThrow(SsrfError);
    await expect(assertCliTargetAllowed('10.0.0.5:3306', true)).resolves.toBeUndefined();
  });

  it('归一化后 hostname 仍为空 → 抛 SsrfError（不是静默通过）', async () => {
    for (const bad of [':3306', '/tmp/x', 'tcp:///path', 'http://']) {
      await expect(assertCliTargetAllowed(bad, true)).rejects.toThrow(/主机名/);
    }
  });

  it('云元数据地址：allow=true 也拒绝（硬底线在归一化后仍生效）', async () => {
    await expect(assertCliTargetAllowed('169.254.169.254:80', true)).rejects.toThrow(/云元数据/);
  });
});
