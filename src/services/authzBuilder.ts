/**
 * 授权组装（R-3 唯一入口的 service 侧实现）：为 can() 预取资产分组/用户分组。
 * 调用方：nativeDispatch.canInvoke、toolAggregation 可见性、assets/credentials 写入侧。
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { can, type AssetAuthRow, type Principal, type VisibilityDimension } from './authorize.js';

export async function buildAssetAuth(
  db: BetterSQLite3Database<typeof schema>,
  principal: Principal,
  assetRow: { id: string; ownerId: string | null; visibility: string; sharedWithUserIds: unknown },
): Promise<AssetAuthRow> {
  const assetGroups = (
    await db.select({ groupId: schema.groupServers.groupId }).from(schema.groupServers).where(eq(schema.groupServers.serverId, assetRow.id))
  ).map((r) => r.groupId);
  const userGroups = (
    await db.select({ groupId: schema.groupUsers.groupId }).from(schema.groupUsers).where(eq(schema.groupUsers.userId, principal.userId))
  ).map((r) => r.groupId);
  return {
    id: assetRow.id,
    ownerId: assetRow.ownerId,
    visibility: assetRow.visibility as AssetAuthRow['visibility'],
    sharedWithUserIds: (assetRow.sharedWithUserIds as string[] | null) ?? [],
    groups: assetGroups,
    userGroups,
  };
}

export async function canOnAsset(
  db: BetterSQLite3Database<typeof schema>,
  dimension: VisibilityDimension,
  principal: Principal,
  assetRow: { id: string; ownerId: string | null; visibility: string; sharedWithUserIds: unknown },
): Promise<boolean> {
  return can(dimension, principal, await buildAssetAuth(db, principal, assetRow));
}

/**
 * 凭证使用权（ADR-028）：admin ∨ 归属人 ∨ 凭证共享到用户所在任一分组。
 * 不再从绑定资产派生——共享是凭证自身的事实（credential_group_shares）。
 */
export async function canUseCredentialFor(
  db: BetterSQLite3Database<typeof schema>,
  principal: Principal,
  credential: { id: string; ownerId: string | null },
): Promise<boolean> {
  if (principal.isAdmin || credential.ownerId === principal.userId) return true;
  const [shares, memberships] = await Promise.all([
    db
      .select({ groupId: schema.credentialGroupShares.groupId })
      .from(schema.credentialGroupShares)
      .where(eq(schema.credentialGroupShares.credentialId, credential.id))
      .all(),
    db
      .select({ groupId: schema.groupUsers.groupId })
      .from(schema.groupUsers)
      .where(eq(schema.groupUsers.userId, principal.userId))
      .all(),
  ]);
  const mine = new Set(memberships.map((m) => m.groupId));
  // 不默认跨组：必须有交集
  return shares.some((s) => mine.has(s.groupId));
}
