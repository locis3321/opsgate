/**
 * Agent API Key（§4.4）：每人一个；明文只签发时展示一次；存 SHA-256；
 * 校验映射到 userId（审计归属：agent 调用记到 Key 所属人）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { API_KEY_PREFIX } from '../config/constants.js';
import type { Principal } from '../routes/registry.js';

export function hashApiKey(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function generatePlainKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString('base64url');
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  clientName: string | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function createApiKey(
  db: BetterSQLite3Database<typeof schema>,
  userId: string,
  name: string,
  clientName?: string,
): Promise<{ plainKey: string; info: ApiKeyInfo }> {
  const plainKey = generatePlainKey();
  const row = await db
    .insert(schema.apiKeys)
    .values({
      name,
      userId,
      keyHash: hashApiKey(plainKey),
      clientName: clientName || null,
      scopes: ['mcp:invoke'],
    })
    .returning({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      clientName: schema.apiKeys.clientName,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      revokedAt: schema.apiKeys.revokedAt,
    })
    .get();
  return { plainKey, info: row! };
}

export async function listApiKeys(
  db: BetterSQLite3Database<typeof schema>,
  userId: string,
  isAdmin: boolean,
): Promise<ApiKeyInfo[]> {
  const rows = await db
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      clientName: schema.apiKeys.clientName,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      revokedAt: schema.apiKeys.revokedAt,
    })
    .from(schema.apiKeys)
    .where(isAdmin ? undefined : eq(schema.apiKeys.userId, userId));
  return rows;
}

/** 校验：hash 匹配 + 未吊销；成功则刷新 last_used_at 并返回 principal */
export async function verifyApiKey(
  db: BetterSQLite3Database<typeof schema>,
  plain: string,
): Promise<Principal | null> {
  const hash = hashApiKey(plain);
  const row = await db
    .select({
      id: schema.apiKeys.id,
      userId: schema.apiKeys.userId,
      clientName: schema.apiKeys.clientName,
      revokedAt: schema.apiKeys.revokedAt,
      isAdmin: schema.users.isAdmin,
    })
    .from(schema.apiKeys)
    .innerJoin(schema.users, eq(schema.apiKeys.userId, schema.users.id))
    .where(and(eq(schema.apiKeys.keyHash, hash), isNull(schema.apiKeys.revokedAt)))
    .get();
  if (!row) return null;
  await db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, row.id))
    .run();
  return { userId: row.userId, isAdmin: row.isAdmin, apiKeyId: row.id, clientName: row.clientName ?? undefined };
}

export async function revokeApiKey(
  db: BetterSQLite3Database<typeof schema>,
  apiKeyId: string,
): Promise<boolean> {
  const res = await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, apiKeyId))
    .run();
  return res.changes > 0;
}

/**
 * 删除已吊销的 Key（2026-11-18 T6）。**只允许删已吊销的行**——
 * 吊销是可追溯的状态（"这个 Key 曾经存在、后来被谁作废"），直接删掉有效 Key
 * 会让审计里的 api_key_id 指向一个从未存在过的 id。因此"吊销"与"删除"是两个动作。
 */
export async function deleteRevokedApiKey(
  db: BetterSQLite3Database<typeof schema>,
  apiKeyId: string,
): Promise<boolean> {
  const res = await db
    .delete(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, apiKeyId), isNotNull(schema.apiKeys.revokedAt)))
    .run();
  return res.changes > 0;
}
