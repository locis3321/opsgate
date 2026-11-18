/**
 * 授权单一真值源（R-3 / ADR-013）：全项目**只有**本文件的 can() / canCredential()。
 * - 无角色矩阵（project-rules §1）：身份 = 管理员 / 成员。
 * - view 与 invoke 共用同一个布尔表达式（AC-6 参数化断言）。
 * - 凭证使用权只由绑定资产的 can('invoke') 派生（ADR-017/020）；不读凭证 visibility（无此列，AC-22/26）。
 * 调用方仅四处（project-rules §0 R-3）：mcpEntryService / serverService / auditService / 前端经 REST。
 */
export interface Principal {
  userId: string;
  isAdmin: boolean;
}

export interface AssetAuthRow {
  id: string;
  /** 成员被删除后为 null：无主资产，仅 admin 可用（ADR-028 §2.5） */
  ownerId: string | null;
  visibility: 'owner' | 'group' | 'public';
  sharedWithUserIds: string[];
  /** 资产所属分组（group_servers → groups），由 service 层预取 */
  groups: string[];
  /** 用户所属分组（group_users），由 service 层预取 */
  userGroups: string[];
}

export type VisibilityDimension = 'view' | 'invoke';

/**
 * can()：唯一授权判定。view 与 invoke 共用同一表达式（可见 ≡ 可调用）。
 * 不允许任何调用方自行判断可见性（AC-6 / AC-22 / R-3）。
 *
 * 2026-11-17 修订（用户决策）：**把资产关联进成员所在分组即构成查看权**，
 * 不再要求额外把 visibility 切到 'group'。原模型里「加进分组」只是筛选维度、
 * 必须再单独切可见范围才生效，实际用起来就是「加了组但没人看得见」，成员连
 * 详情页都进不去、也无法在详情页绑定自己的凭证。
 * 现在：分组关联 = 可见 = 可调用；visibility='owner' 只对**不在你任何分组里**的资产生效。
 */
export function can(
  _dimension: VisibilityDimension,
  principal: Principal,
  asset: Pick<AssetAuthRow, 'ownerId' | 'visibility' | 'sharedWithUserIds' | 'groups' | 'userGroups'>,
): boolean {
  if (principal.isAdmin) return true;
  if (asset.ownerId === principal.userId) return true;
  // §6 约束 3：共享名单为独立 OR（任一命中即可见/可调用）
  if (asset.sharedWithUserIds.includes(principal.userId)) return true;
  if (asset.visibility === 'public') return true;
  // 资产所在分组 ∩ 用户所在分组 → 可见（覆盖 visibility='group'，也覆盖"已关联分组但仍是 owner"）
  return asset.userGroups.some((g) => asset.groups.includes(g));
}

/**
 * canCredential（ADR-028 修订）：凭证使用权 = admin ∨ 归属人 ∨ 凭证已共享到 principal 所在任一分组。
 *
 * 与 ADR-019/020 的差别：不再从"资产授权"派生。ADR-028 恢复了显式的共享开关
 * （credential_group_shares），共享是**凭证自身的**事实，不该靠资产可见性间接推断——
 * 否则成员只要看见任一使用该凭证的资产，就等于获得了凭证使用权，与"没共享就看不到"矛盾。
 */
export function canCredential(
  principal: Principal,
  credential: { ownerId: string | null },
  sharedGroupIds: string[],
  userGroupIds: string[],
): boolean {
  if (principal.isAdmin) return true;
  if (credential.ownerId === principal.userId) return true;
  // 不默认跨组：必须存在"该凭证共享到的分组"∩"用户所在分组"
  return sharedGroupIds.some((g) => userGroupIds.includes(g));
}

/** 绑定侧校验（ADR-028 §2.2）：只能绑定**自己创建**的凭证；共享凭证只可"用"不可"绑"。 */
export function assertOwnCredentialOrAdmin(
  principal: Principal,
  credentialOwnerId: string | null,
): boolean {
  return principal.isAdmin || credentialOwnerId === principal.userId;
}

/** 写入侧同主校验（§4.2 两处硬校验，Fail-closed） */
export function assertSameOwnerOrAdmin(
  principal: Principal,
  credentialOwnerId: string | null,
  assetOwnerId: string | null,
): boolean {
  return principal.isAdmin || credentialOwnerId === assetOwnerId;
}
