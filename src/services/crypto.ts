/**
 * 凭证加密（§5.6）：AES-256-GCM，格式 v1.<iv b64>.<tag b64>.<ciphertext b64>，AAD = credentialId。
 * 密钥 32B：OPSGATE_CREDENTIAL_KEY 指向的文件（<data>/credentials.key，0600，首启生成）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function loadCredentialKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    const b = readFileSync(keyPath);
    if (b.length !== 32) throw new Error(`凭证密钥文件需 32B: ${keyPath}`);
    return b;
  }
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export function encryptCredential(key: Buffer, credentialId: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(credentialId));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptCredential(key: Buffer, credentialId: string, serialized: string): string {
  const parts = serialized.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('凭证密文格式非法（应为 v1.<iv>.<tag>.<ciphertext>）');
  }
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const ct = Buffer.from(parts[3]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(credentialId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** 连接池键用的凭证指纹（实例键构成 §5.4：凭证指纹而非用户 ID） */
export function credentialFingerprint(credentialId: string, updatedAtMs: number): string {
  return createHash('sha256')
    .update(`${credentialId}:${updatedAtMs}`)
    .digest('hex')
    .slice(0, 16);
}

/** 槽位直填值的指纹（实例键构成用：直填值变 → 指纹变 → 实例键变 → 实例重建） */
export function inlineValueFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** 槽位直填值的加密 AAD：绑定到具体资产+槽位，密文不可跨行搬运 */
export function slotValueAad(serverId: string, slotName: string): string {
  return `slot:${serverId}:${slotName}`;
}
