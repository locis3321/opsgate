/**
 * R-3 授权单一真值源参数化测试（AC-6）：全部可见性组合下 can('view') === can('invoke')。
 */
import { describe, expect, it } from 'vitest';
import { can, canCredential, assertSameOwnerOrAdmin, assertOwnCredentialOrAdmin, type Principal, type AssetAuthRow } from './authorize.js';

const P: Principal[] = [
  { userId: 'alice', isAdmin: false },
  { userId: 'bob', isAdmin: false },
  { userId: 'root', isAdmin: true },
];

function asset(partial: Partial<AssetAuthRow>): AssetAuthRow {
  return {
    id: 'a-1',
    ownerId: 'alice',
    visibility: 'owner',
    sharedWithUserIds: [],
    groups: ['g-host'],
    userGroups: [],
    ...partial,
  };
}

describe("can(view) === can(invoke)（AC-6，全组合参数化）", () => {
  const combos: Array<[string, Partial<AssetAuthRow>, Principal, boolean]> = [
    ['owner-归属人', {}, P[0]!, true],
    ['owner-他人', {}, P[1]!, false],
    ['owner-admin', {}, P[2]!, true],
    ['owner-shared名单', { sharedWithUserIds: ['bob'] }, P[1]!, true],
    ['public-任何人', { visibility: 'public' }, P[1]!, true],
    ['group-成员', { visibility: 'group', userGroups: ['g-host'] }, P[1]!, true],
    ['group-非成员', { visibility: 'group', userGroups: ['g-other'] }, P[1]!, false],
    ['group-成员admin', { visibility: 'group', userGroups: ['g-host'] }, P[2]!, true],
  ];

  for (const [name, partial, principal, expected] of combos) {
    it(`${name}（${expected ? '允许' : '拒绝'}）`, () => {
      const a = asset(partial);
      const view = can('view', principal, a);
      const invoke = can('invoke', principal, a);
      // AC-6：可见 ≡ 可调用，恒等式成立
      expect(view).toBe(invoke);
      expect(view).toBe(expected);
    });
  }
});

describe('canCredential（ADR-028：使用权 = 归属人 ∨ 共享到所在分组）', () => {
  const cred = { ownerId: 'alice' };
  it('归属人/admin 恒允许', () => {
    expect(canCredential({ userId: 'alice', isAdmin: false }, cred, [], [])).toBe(true);
    expect(canCredential({ userId: 'root', isAdmin: true }, cred, [], [])).toBe(true);
  });
  it('凭证共享到用户所在分组 → 允许；无交集 → 拒绝', () => {
    expect(canCredential({ userId: 'bob', isAdmin: false }, cred, ['g1'], ['g1', 'g2'])).toBe(true);
    expect(canCredential({ userId: 'bob', isAdmin: false }, cred, ['g9'], ['g1'])).toBe(false);
    // 不默认跨组：凭证未共享任何分组 → 拒绝
    expect(canCredential({ userId: 'bob', isAdmin: false }, cred, [], ['g1'])).toBe(false);
  });
});

describe('assertOwnCredentialOrAdmin（ADR-028 §2.2 绑定侧）', () => {
  it('只能绑自己创建的凭证；共享凭证不能绑', () => {
    expect(assertOwnCredentialOrAdmin({ userId: 'alice', isAdmin: false }, 'alice')).toBe(true);
    expect(assertOwnCredentialOrAdmin({ userId: 'bob', isAdmin: false }, 'alice')).toBe(false);
    expect(assertOwnCredentialOrAdmin({ userId: 'root', isAdmin: true }, 'alice')).toBe(true);
  });
});

describe('assertSameOwnerOrAdmin（§4.2 写入侧）', () => {
  it('同主或 admin 通过；跨主拒绝', () => {
    expect(assertSameOwnerOrAdmin({ userId: 'alice', isAdmin: false }, 'alice', 'alice')).toBe(true);
    expect(assertSameOwnerOrAdmin({ userId: 'bob', isAdmin: false }, 'alice', 'bob')).toBe(false);
    expect(assertSameOwnerOrAdmin({ userId: 'bob', isAdmin: true }, 'alice', 'bob')).toBe(true);
  });
});
