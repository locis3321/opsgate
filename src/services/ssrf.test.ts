/**
 * SSRF 校验（AC-20 / ADR-016）：私网/环回/链路本地/云元数据拒绝；
 * IPv4-mapped IPv6 归一化（绕过先例）；allow_private_network 显式开启后放行（云元数据始终拒）。
 */
import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, SsrfError } from './ssrf.js';

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

  it('公网地址允许；allow=true 时私网放行（显式开启语义）', async () => {
    await expect(assertUrlAllowed('http://8.8.8.8/', false)).resolves.toBeUndefined();
    await expect(assertUrlAllowed('http://10.1.2.3/', true)).resolves.toBeUndefined();
  });
});
