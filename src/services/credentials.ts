/**
 * 凭证解析服务（§5.6 注入点第五类 ssh2 / §4.3 槽位映射）：
 * server_credentials → credentials → AES-256-GCM 解密（AAD=credentialId）→ JSON 命名值集合。
 * server_slot_values → 资产自带的槽位直填值 → AES-256-GCM 解密（AAD=slot:<serverId>:<slotName>）。
 * 未绑定的槽位**跳过**（不抛错、不补值）：产品侧鉴权常为"多选一"（ES 的 API Key 或 账号密码、
 * Nacos 的 token 或 用户名+密码），平台无从判断哪个是必填——缺失交给产品自己在连接时报错。
 */
import type { Database } from 'better-sqlite3';
import { decryptCredential, encryptCredential, inlineValueFingerprint, slotValueAad } from './crypto.js';

export interface ResolvedCredential {
  slotName: string;
  /** 解密后的值（password 或 privateKey 原文，仅内存） */
  value: string;
  /** 绑定凭证时为 credentialId；直填值为 `inline:<值指纹>`（实例键构成用） */
  credentialId: string;
  updatedAtMs: number;
  /** true = 资产自带直填值（非凭证） */
  inline?: boolean;
  /** 该条绑定指定的登录用户名（SSH 专用；绑定未指定时不出现，调用方回落凭证再回落资产） */
  username?: string;
}

export class CredentialService {
  constructor(
    private readonly sqlite: Database,
    private readonly key: Buffer,
  ) {}

  /** 凭证命名值集合的键名列表（不返回值/明文——仅元信息，供候选下拉按槽位键过滤） */
  valueKeysOf(credentialId: string): string[] {
    const row = this.sqlite
      .prepare('SELECT encrypted_values FROM credentials WHERE id = ?')
      .get(credentialId) as { encrypted_values: string } | undefined;
    if (!row) return [];
    try {
      const plaintext = decryptCredential(this.key, credentialId, row.encrypted_values);
      return Object.keys(JSON.parse(plaintext) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  /**
   * 凭证的明文值集合（仅归属人/admin 揭示明文时调用；返回前必须审计留痕）。
   * 解密失败 → null（调用方 fail-closed，不返回半截数据）。
   */
  valuesOf(credentialId: string): Record<string, string> | null {
    const row = this.sqlite
      .prepare('SELECT encrypted_values FROM credentials WHERE id = ?')
      .get(credentialId) as { encrypted_values: string } | undefined;
    if (!row) return null;
    try {
      const plaintext = decryptCredential(this.key, credentialId, row.encrypted_values);
      const parsed = JSON.parse(plaintext) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return null;
    }
  }

  /** ref.<凭证名>.<键名> 按名解析（一个凭证服务多个资产）；不存在/键缺失 → null（调用方 fail-closed） */
  valueOfRef(refName: string, key: string): { value: string; credentialId: string } | null {
    const row = this.sqlite
      .prepare('SELECT id, encrypted_values FROM credentials WHERE name = ?')
      .get(refName) as { id: string; encrypted_values: string } | undefined;
    if (!row) return null;
    try {
      const plaintext = decryptCredential(this.key, row.id, row.encrypted_values);
      const values = JSON.parse(plaintext) as Record<string, unknown>;
      const value = values[key];
      if (typeof value !== 'string') return null;
      return { value, credentialId: row.id };
    } catch {
      return null;
    }
  }

  /** 取某**具体凭证**的指定键（调用方已确定要用哪条凭证时用；键缺失/空串 → null） */
  credentialKey(credentialId: string, key: string): string | null {
    if (credentialId.startsWith('inline:')) return null;
    const row = this.sqlite
      .prepare('SELECT encrypted_values FROM credentials WHERE id = ?')
      .get(credentialId) as { encrypted_values: string } | undefined;
    if (!row) return null;
    try {
      const values = JSON.parse(decryptCredential(this.key, credentialId, row.encrypted_values)) as Record<string, unknown>;
      const v = values[key];
      return typeof v === 'string' && v.trim() !== '' ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * 取某槽位**绑定凭证**里的指定键（不要求该键就是槽位名）。
   *
   * 为什么需要：SSH 的槽位存的是整份密钥/密码，但用户名等连接参数也在同一凭证里
   * （`ssh_key`/`user_password` 都有 `username` 键）。此处按槽位找到被绑定的凭证，
   * 再从中取该键；没有绑定、键缺失或值是空串 → null（调用方回落到资产上的默认值）。
   *
   * `key === 'username'` 时**绑定自身的 username 优先**：绑定上填了就直答，不再看凭证值
   * （同一份私钥在不同资产/不同绑定上用不同账号是合法诉求）。
   */
  slotCredentialKey(
    assetId: string,
    slotName: string,
    key: string,
    userId?: string,
  ): { value: string; credentialId: string; updatedAtMs: number } | null {
    const rows = this.sqlite
      .prepare(
        `SELECT sc.user_id AS userId, sc.scope AS scope, sc.username AS bindingUsername, c.id AS credentialId,
                c.name AS credName, c.encrypted_values AS encrypted, c.updated_at AS updatedAt, c.privileges AS privileges
         FROM server_credentials sc JOIN credentials c ON c.id = sc.credential_id
         WHERE sc.server_id = ? AND sc.slot_name = ?`,
      )
      .all(assetId, slotName) as Array<{
      userId: string;
      scope: string;
      bindingUsername: string | null;
      credentialId: string;
      credName: string;
      encrypted: string;
      updatedAt: number;
      privileges: string;
    }>;
    if (rows.length === 0) return null;
    // 与 resolveSlotValues 同口径：personal（本人）优先，其次 asset；同分按管理账号 + 稳定序
    let picked = userId !== undefined
      ? pickBestBinding(rows.filter((r) => r.scope === 'personal' && r.userId === userId))
      : undefined;
    if (!picked) picked = pickBestBinding(rows.filter((r) => r.scope === 'asset'));
    if (!picked) return null;
    // 绑定级用户名优先：绑定上显式填了就是它，无需解密凭证
    if (key === 'username' && picked.bindingUsername && picked.bindingUsername.trim() !== '') {
      return { value: picked.bindingUsername, credentialId: picked.credentialId, updatedAtMs: Number(picked.updatedAt) };
    }
    try {
      const values = JSON.parse(decryptCredential(this.key, picked.credentialId, picked.encrypted)) as Record<string, unknown>;
      const value = values[key];
      if (typeof value !== 'string' || value.trim() === '') return null;
      return { value, credentialId: picked.credentialId, updatedAtMs: Number(picked.updatedAt) };
    } catch {
      return null;
    }
  }

  /** 资产自带槽位直填值（ADR-027）：解密后的值 + 更新时刻（供管理端回显与实例键） */  slotValuesOf(assetId: string): Map<string, { value: string; updatedAtMs: number }> {
    const rows = this.sqlite
      .prepare('SELECT slot_name AS slotName, encrypted_value AS encrypted, updated_at AS updatedAt FROM server_slot_values WHERE server_id = ?')
      .all(assetId) as Array<{ slotName: string; encrypted: string; updatedAt: number }>;
    const out = new Map<string, { value: string; updatedAtMs: number }>();
    for (const r of rows) {
      try {
        const value = decryptCredential(this.key, slotValueAad(assetId, r.slotName), r.encrypted);
        out.set(r.slotName, { value, updatedAtMs: Number(r.updatedAt) });
      } catch {
        // 密文损坏：跳过该槽位（后续解析时报 fail-closed，不静默补值）
      }
    }
    return out;
  }

  /**
   * 写直填值（覆盖）并清掉**写入者自己**在该槽位的凭证绑定（ADR-027 互斥）。
   *
   * 只清自己的（2026-11-17 用户决策）：一槽多凭证后，同一槽位可能同时存在归属人的
   * asset 绑定与多个成员的 personal 绑定。直填值本身是**资产级**的（server_slot_values
   * 主键只有 server_id+slot_name），写它就等于"这台机器自带了这个密钥"，与写入者是谁无关；
   * 若按槽位清空全部绑定，会顺带删掉其他成员与归属人自己精心绑定的凭证。
   * 因此只移除 writer 自己的绑定行 —— 别人的绑定保留，直填值被清除后自动恢复生效。
   */
  setSlotValue(assetId: string, slotName: string, value: string, writerUserId: string): void {
    const encrypted = encryptCredential(this.key, slotValueAad(assetId, slotName), value);
    const fingerprint = inlineValueFingerprint(value);
    const ts = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO server_slot_values (server_id, slot_name, encrypted_value, value_fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id, slot_name) DO UPDATE SET
           encrypted_value = excluded.encrypted_value,
           value_fingerprint = excluded.value_fingerprint,
           updated_at = excluded.updated_at`,
      )
      .run(assetId, slotName, encrypted, fingerprint, ts, ts);
    this.sqlite
      .prepare('DELETE FROM server_credentials WHERE server_id = ? AND slot_name = ? AND user_id = ?')
      .run(assetId, slotName, writerUserId);
  }

  /** 清除直填值 */
  clearSlotValue(assetId: string, slotName: string): void {
    this.sqlite.prepare('DELETE FROM server_slot_values WHERE server_id = ? AND slot_name = ?').run(assetId, slotName);
  }

  /**
   * 取槽位值（ADR-028）。
   *
   * 取值顺序：直填值 > 指定 credential（若给出）> personal > asset（按 privileges 排序）。
   * `userId` 缺省时跳过 personal —— 系统级路径（SSH 认证槽位解析、预加载）没有"调用者"，
   * 只应看到 owner 绑定的 asset 凭证；成员自绑的凭证只对该成员生效。
   * `preferredCredentialId` 由 tools/call 的 credential 参数传入，只覆盖它实际绑定的槽位。
   * 未绑定的槽位不出现在返回值里（不抛错，见文件头注释）。
   */
  resolveSlotValues(
    assetId: string,
    slotNames: string[],
    userId?: string,
    preferredCredentialId?: string,
  ): ResolvedCredential[] {
    if (slotNames.length === 0) return [];
    const placeholders = slotNames.map(() => '?').join(',');
    const rows = this.sqlite
      .prepare(
        `SELECT sc.slot_name AS slotName, sc.user_id AS userId, sc.scope AS scope,
                sc.username AS bindingUsername, sc.credential_key AS credentialKey,
                c.id AS credentialId, c.name AS credName, c.encrypted_values AS encrypted,
                c.updated_at AS updatedAt, c.privileges AS privileges
         FROM server_credentials sc JOIN credentials c ON c.id = sc.credential_id
         WHERE sc.server_id = ? AND sc.slot_name IN (${placeholders})`,
      )
      .all(assetId, ...slotNames) as Array<{
      slotName: string;
      userId: string;
      scope: string;
      bindingUsername: string | null;
      credentialKey: string | null;
      credentialId: string;
      credName: string;
      encrypted: string;
      updatedAt: number;
      privileges: string;
    }>;

    /** 每槽位：personal（本人）一条；asset 取优先级最高的一条；指定凭证可覆盖二者 */
    const personal = new Map<string, (typeof rows)[number]>();
    const asset = new Map<string, (typeof rows)[number]>();
    const preferred = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (preferredCredentialId && r.credentialId === preferredCredentialId) {
        // 纵深防御（ADR-028 §2.2）：指定凭证必须是「本人绑定」或「asset 绑定（归属人绑的）」。
        // mcpEndpoint 调用前已校验一次，这里再兜一层——否则任何新调用点漏校验就会静默串数据。
        const visible = r.scope === 'asset' || (userId !== undefined && r.userId === userId);
        if (visible) preferred.set(r.slotName, r);
      }
    }
    // 按槽位分组后用统一择优（同分取管理账号 + 稳定序），不依赖行序
    const bySlot = new Map<string, Array<(typeof rows)[number]>>();
    for (const r of rows) {
      const arr = bySlot.get(r.slotName) ?? [];
      arr.push(r);
      bySlot.set(r.slotName, arr);
    }
    for (const [slot, list] of bySlot) {
      const mine = userId !== undefined ? list.filter((r) => r.scope === 'personal' && r.userId === userId) : [];
      const p = pickBestBinding(mine);
      if (p) personal.set(slot, p);
      const a = pickBestBinding(list.filter((r) => r.scope === 'asset'));
      if (a) asset.set(slot, a);
    }

    const inline = this.slotValuesOf(assetId);
    const out: ResolvedCredential[] = [];
    for (const slot of slotNames) {
      const direct = inline.get(slot);
      if (direct) {
        out.push({
          slotName: slot,
          value: direct.value,
          credentialId: `inline:${inlineValueFingerprint(direct.value)}`,
          updatedAtMs: 0,
          inline: true,
        });
        continue;
      }
      const row = preferred.get(slot) ?? personal.get(slot) ?? asset.get(slot);
      // 未绑定 → 跳过。平台无法判断哪些槽位是产品的必填项（ES/Nacos 都是"多选一"），
      // 所以不在这里替产品做必填裁决：缺失的槽位不进注入值，由连通性测试/产品进程报真实错误。
      if (!row) continue;
      const plaintext = decryptCredential(this.key, row.credentialId, row.encrypted);
      let values: Record<string, unknown>;
      try {
        values = JSON.parse(plaintext) as Record<string, unknown>;
      } catch {
        throw new Error(`凭证 ${row.credentialId} 解密内容非 JSON`);
      }
      const value = pickSlotValue(values, slot, row.credentialKey);
      if (typeof value !== 'string') {
        const where = row.credentialKey
          ? `凭证 ${row.credentialId} 没有键 "${row.credentialKey}"（绑定为槽位 "${slot}" 指定）`
          : `槽位 "${slot}" 未指定键名，且凭证 ${row.credentialId} 中没有同名键`
            + `（可用：${Object.keys(values).join('、') || '无'}）；请在绑定上指定键名`;
        throw new Error(`${where}（fail-closed）`);
      }
      out.push({
        slotName: slot,
        value,
        credentialId: row.credentialId,
        updatedAtMs: Number(row.updatedAt),
        ...(row.bindingUsername ? { username: row.bindingUsername } : {}),
      });
    }
    return out;
  }
}

/** 归一化键名：去品类前缀（`NACOS_USERNAME` → `username`）+ 小写 + 去下划线（与前端 slotMatches 同规则） */
const normalizeSlotKey = (s: string): string =>
  s.replace(/^[A-Z][A-Z0-9]*_/, '').toLowerCase().replace(/[_-]/g, '');

/**
 * 从凭证的命名值集合里取出某槽位该用的值（ADR-031：**精确匹配，不再猜**）。
 *
 *  - `credentialKey` 有值 → 只取该键，没有就是没有（返回 undefined，由调用方报错）
 *  - `credentialKey` 为 null → 只接受两级**确定性的字符串等价**：
 *      1. 键名与槽位名完全一致（`AUTH` ← `AUTH`）
 *      2. 归一化后一致（`RABBITMQ_PASSWORD` ← `password`、`MINIO_ACCESS_KEY` ← `access_key`）
 *
 * 已删除的两级猜测（ADR-031 §2.2）：
 *  - 「凭证只有 1 个键 → 直接用它」：单键凭证绑多槽位时会把同一个值喂给不同槽位；
 *  - 「唯一敏感别名」：别名表永远追不上下一个产品的命名（`AUTH_PASS` 与 `passphrase` 就是典型）。
 *
 * 归一化保留的理由：它是对键名的确定性变换（去品类前缀 + 大小写 + 下划线），
 * 不是启发式；删掉会无谓打断依赖 `RABBITMQ_PASSWORD` ≡ `password` 的既有配置。
 */
function pickSlotValue(
  values: Record<string, unknown>,
  slot: string,
  credentialKey?: string | null,
): unknown {
  const key = resolveSlotKey(values, slot, credentialKey);
  return key === undefined ? undefined : values[key];
}

/**
 * 该槽位最终会从凭证里读哪个键（与 pickSlotValue 同一规则，独立导出供"删除键影响哪些槽位"使用）。
 * 返回 undefined = 当前键集合下这个槽位取不到值。
 */
export function resolveSlotKey(
  values: Record<string, unknown>,
  slot: string,
  credentialKey?: string | null,
): string | undefined {
  if (credentialKey) {
    const v = values[credentialKey];
    return typeof v === 'string' && v !== '' ? credentialKey : undefined;
  }

  const direct = values[slot];
  if (typeof direct === 'string' && direct !== '') return slot;

  // 前缀/大小写/下划线差异（槽位带品类前缀，凭证键是通用名）
  const target = normalizeSlotKey(slot);
  for (const [k, v] of Object.entries(values)) {
    if (normalizeSlotKey(k) === target && typeof v === 'string' && v !== '') return k;
  }
  return undefined;
}

/**
 * privileges 排序权重（ADR-028 §2.4）：admin/root → rw → wo → ro → 无等级。
 * 仅用于"同槽位多个 asset 绑定时选哪个"，不参与任何授权判定。
 */
export function privilegeRank(privilegesJson: string | null | undefined): number {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(privilegesJson ?? '[]') as unknown;
    if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return 4;
  }
  if (list.includes('admin') || list.includes('root')) return 0;
  if (list.includes('rw')) return 1;
  if (list.includes('wo')) return 2;
  if (list.includes('ro')) return 3;
  return 4;
}

/** 管理类账号的识别（凭证名或绑定用户名） */
const ADMINISH_RE = /(^|[-_. ])(root|admin|administrator|superuser|superadmin)([-_. ]|$)/i;

function isAdminishCredential(credName: string | null | undefined, bindingUsername: string | null | undefined): boolean {
  return ADMINISH_RE.test(credName ?? '') || ADMINISH_RE.test(bindingUsername ?? '');
}

export interface RankedBinding {
  credentialId: string;
  privileges: string;
  credName?: string | null;
  bindingUsername?: string | null;
}

/**
 * 同槽位多凭证的确定性择优（用户 2026-11-19 决策）。
 *
 * 排序键依次为：①权限等级 → ②管理类账号优先 → ③credentialId 字典序。
 * 为什么需要 ②③：迁移后大量资产一槽两三个同为 admin 的账号（如 root 与业务账号），
 * 只按等级排序时同分结果取决于 SQLite 行序 —— 同份数据在不同机器可能取到不同账号。
 * ②③ 让结果可复现，且默认落到权限面符合直觉的管理账号上。
 */
export function pickBestBinding<T extends RankedBinding>(rows: T[]): T | undefined {
  if (rows.length === 0) return undefined;
  return [...rows].sort((a, b) => {
    const byRank = privilegeRank(a.privileges) - privilegeRank(b.privileges);
    if (byRank !== 0) return byRank;
    const aAdmin = isAdminishCredential(a.credName, a.bindingUsername) ? 0 : 1;
    const bAdmin = isAdminishCredential(b.credName, b.bindingUsername) ? 0 : 1;
    if (aAdmin !== bAdmin) return aAdmin - bAdmin;
    return a.credentialId < b.credentialId ? -1 : a.credentialId > b.credentialId ? 1 : 0;
  })[0];
}
