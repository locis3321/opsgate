/**
 * SSH 连接凭证解析（Spec §4.3 多槽位 + ADR-028 personal → asset）。
 *
 * 抽成独立函数的原因：这段逻辑决定"这次连接用谁的账号/密钥"，是成员自绑凭证能否生效的
 * 唯一开关。放在 server.ts 内联时只能靠端到端 SSH 才能验证，抽出来后可对真实装配做集成测试。
 */
import type { AssetView } from '../framework/types.js';
import type { SshCredential } from '../native/connectors/ssh.js';
import type { CredentialService } from './credentials.js';

export function resolveSshCredential(
  credentials: CredentialService,
  asset: AssetView,
  userId?: string,
): SshCredential {
  const authSlot = asset.hostConn?.authSlot;
  if (!authSlot) throw new Error('资产未配置 authSlot');
  const resolved = credentials.resolveSlotValues(asset.id, [authSlot], userId);
  if (resolved.length === 0) throw new Error('槽位未绑定凭证');
  const res = resolved[0]!;
  const isKey = res.value.includes('PRIVATE KEY');
  // Spec §4.3 多槽位：私钥口令可单独绑一个槽位（authPassSlot）。
  // 取哪个键与其他槽位同口径（ADR-031）：绑定上指定了 credential_key 就精确取，
  // 否则按槽位名做同名/归一化匹配，匹配不到即 fail-closed 报错——
  // 不在这里替某个产品名（AUTH_PASS）写死 passphrase 特例。
  const passSlot = asset.hostConn?.authPassSlot;
  let passphrase: string | undefined;
  if (passSlot) {
    passphrase = credentials.resolveSlotValues(asset.id, [passSlot], userId)[0]?.value;
  }
  // 私钥凭证自带 passphrase 键时直接用它（ssh_key 类型的既定键，非猜测）
  passphrase ??= credentials.credentialKey(res.credentialId, 'passphrase') ?? undefined;
  // 用户名优先级：绑定上填的（res.username，与本次取到的凭证是同一条绑定）> 该凭证自带的 username 键 > 资产 host_conn.username。
  // 必须锁在**本次选中的这条凭证**上：同槽另一条绑定（如 root 与 dev 并存）的账号不能串过来。
  const username = res.username ?? credentials.credentialKey(res.credentialId, 'username') ?? undefined;
  return {
    credentialId: res.credentialId,
    updatedAtMs: res.updatedAtMs,
    ...(username ? { username } : {}),
    ...(isKey ? { privateKey: res.value, passphrase } : { password: res.value, passphrase }),
  };
}
