import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiError } from '../api';
import SlotValueEditor, { slotMatches } from './SlotValueEditor';
import Combobox from './Combobox';

interface Binding {
  credentialId: string;
  credentialName: string;
  valueHint: string;
  userId: string;
  scope: 'asset' | 'personal';
  label: string | null;
  /** 该条绑定使用的 SSH 登录用户名（未设置 = 回落凭证/资产上的用户名） */
  username?: string | null;
  /**
   * 该条绑定从凭证里取哪个键（ADR-031）。
   * null/未设置 = 按槽位名匹配（键名完全一致或归一化后一致）；有值 = 精确取该键。
   */
  credentialKey?: string | null;
  /** 是否当前用户添加的（只有自己的绑定能删） */
  mine: boolean;
}

interface SlotRow {
  slotName: string; label: string; target: string; file: boolean;
  credentialId: string | null; credentialName: string | null;
  /** 资产自带直填值（ADR-027，非凭证）；非归属人/管理员为 null（只给 hasInline） */
  inlineValue: string | null;
  /** 是否已设置直填值（无明文权限时也能判定"已设置"） */
  hasInline?: boolean;
  /** ADR-028：一个槽位可有多条绑定 */
  bindings?: Binding[];
}
interface Candidate { id: string; name: string; kind: string; valueHint: string; boundSlots: string[]; keys?: string[] }

const SCOPE_META: Record<Binding['scope'], { label: string; cls: string; title: string }> = {
  asset: { label: '共享', cls: 'tag', title: '已共享：该资产的使用者（同组成员）都能用这条凭证' },
  personal: { label: '私有', cls: 'badge-warn', title: '仅本人可用，其他使用者取不到这条凭证' },
};

/** 凭证槽位绑定器（ADR-028）：一槽多绑定，候选=仅本人凭证；每条绑定只能由添加者本人删除。
 *  取值两种方式二选一：直接输入值（资产自带直填值，ADR-027）或从 + 下拉选择已有凭证。
 *  「共享给组内成员」复选框由归属人/管理员勾选（2026-11-17 用户决策）：勾上 = scope asset。
 *  `authSlot` 给出时，该槽位的绑定行额外提供 SSH 登录用户名编辑（绑定级用户名）。 */
export default function SlotBinder({ assetId, canShare = false, authSlot = null }: { assetId: string; canShare?: boolean; authSlot?: string | null }) {
  const qc = useQueryClient();
  const slots = useQuery({
    queryKey: ['slots', assetId],
    queryFn: () => api<SlotRow[]>(`/api/v1/servers/${assetId}/slots`),
  });
  const cands = useQuery({
    queryKey: ['candidates', assetId],
    queryFn: () => api<Candidate[]>(`/api/v1/credentials/candidates?assetId=${assetId}`),
  });
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addTarget, setAddTarget] = useState('env');
  /** 解绑确认：按 (槽位, 凭证) 定位到具体那条绑定 */
  const [confirming, setConfirming] = useState<{ slot: string; cred: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const bind = useMutation({
    mutationFn: (v: { slotName: string; credentialId: string }) =>
      api(`/api/v1/servers/${assetId}/slots`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['slots', assetId] }); void qc.invalidateQueries({ queryKey: ['candidates', assetId] }); setDraft({}); setErr(''); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '绑定失败'),
  });
  const unbind = useMutation({
    mutationFn: (v: { slotName: string; credentialId: string }) =>
      api(`/api/v1/servers/${assetId}/slots/${encodeURIComponent(v.slotName)}?credentialId=${encodeURIComponent(v.credentialId)}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['slots', assetId] }); void qc.invalidateQueries({ queryKey: ['candidates', assetId] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '解绑失败'),
  });
  /** 切换共享范围（asset ⇄ personal）：不重选凭证，只改这条绑定的可见范围 */
  const setShared = useMutation({
    mutationFn: (v: { slotName: string; credentialId: string; shared: boolean }) =>
      api(`/api/v1/servers/${assetId}/slots/${encodeURIComponent(v.slotName)}`, {
        method: 'PATCH',
        body: JSON.stringify({ shared: v.shared, credentialId: v.credentialId }),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['slots', assetId] }); setErr(''); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '切换共享失败'),
  });
  /** 改某条绑定的 SSH 登录用户名（空串 = 清除，回落凭证/资产上的用户名） */
  const setUsername = useMutation({
    mutationFn: (v: { slotName: string; credentialId: string; username: string }) =>
      api(`/api/v1/servers/${assetId}/slots/${encodeURIComponent(v.slotName)}`, {
        method: 'PATCH',
        body: JSON.stringify({ username: v.username, credentialId: v.credentialId }),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['slots', assetId] }); setErr(''); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '保存用户名失败'),
  });
  /** 改某条绑定的凭证键（ADR-031）：空 = 回到"按槽位名匹配" */
  const setCredentialKey = useMutation({
    mutationFn: (v: { slotName: string; credentialId: string; credentialKey: string | null }) =>
      api(`/api/v1/servers/${assetId}/slots/${encodeURIComponent(v.slotName)}`, {
        method: 'PATCH',
        body: JSON.stringify({ credentialKey: v.credentialKey, credentialId: v.credentialId }),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['slots', assetId] }); setErr(''); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '保存键名失败'),
  });
  /** 正在编辑的用户名草稿：键 = slotName + credentialId */
  const [userDraft, setUserDraft] = useState<Record<string, string>>({});
  const addSlot = useMutation({
    mutationFn: (v: { target: string; name: string; label: string; file: boolean }) =>
      api(`/api/v1/servers/${assetId}`, { method: 'PATCH', body: JSON.stringify({ credentialSlots: [...(slots.data ?? []).map((s) => ({ target: s.target, name: s.slotName, label: s.label, file: s.file })), v] }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['slots', assetId] }); setShowAdd(false); setAddName(''); },
  });
  /** 直填值写入资产（ADR-027）：非凭证，不进凭证列表；空串视为清除 */
  const saveValue = useMutation({
    mutationFn: (v: { slotName: string; value: string }) => {
      const url = `/api/v1/servers/${assetId}/slots/${encodeURIComponent(v.slotName)}/value`;
      return v.value.trim()
        ? api(url, { method: 'PUT', body: JSON.stringify({ value: v.value }) })
        : api(url, { method: 'DELETE' });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['slots', assetId] }); setDraft({}); setErr(''); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '保存失败'),
  });

  const rows = slots.data ?? [];
  const hintOf = (id: string) => (cands.data ?? []).find((c) => c.id === id)?.valueHint ?? '****';
  const shownValue = (slotName: string, inline: string | null) => draft[slotName] ?? inline ?? '';
  const isDirty = (slotName: string, inline: string | null) =>
    draft[slotName] !== undefined && draft[slotName] !== (inline ?? '');

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
      <table className="dt">
        <thead><tr><th>槽位</th><th>目标</th><th>绑定与取值</th></tr></thead>
        <tbody>
          {rows.map((s) => {
            const binds = s.bindings ?? (s.credentialId
              ? [{ credentialId: s.credentialId, credentialName: s.credentialName ?? '—', valueHint: hintOf(s.credentialId), userId: '', scope: 'asset' as const, label: null, mine: true }]
              : []);
            const hasBinding = binds.length > 0;
            return (
              <tr key={s.slotName}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {s.label || s.slotName}
                  <br />
                  <span style={{ color: 'var(--meta)', fontSize: 12 }}>{s.slotName}{s.file ? '（文件）' : ''}</span>
                </td>
                <td><span className="tag">{s.target}</span></td>
                <td>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {/* 绑定列表：他人绑定只读，自己的可解绑（ADR-028 §2.2） */}
                    {binds.map((b) => (
                      <div key={`${b.userId}:${b.credentialId}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className="mono" style={{ fontSize: 'var(--text-sm)' }}>{b.credentialName}</span>
                        <span className="mono" style={{ color: 'var(--meta)', fontSize: 12 }}>{b.valueHint}</span>
                        {/* 共享开关：自己的绑定可勾（仅归属人/管理员），他人的绑定只显示当前状态 */}
                        {b.mine && canShare ? (
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', cursor: setShared.isPending ? 'wait' : 'pointer' }}
                            title={SCOPE_META[b.scope].title}>
                            <input
                              type="checkbox"
                              checked={b.scope === 'asset'}
                              disabled={setShared.isPending}
                              onChange={(e) => setShared.mutate({ slotName: s.slotName, credentialId: b.credentialId, shared: e.target.checked })}
                            />
                            共享给组内成员
                          </label>
                        ) : (
                          <span className={SCOPE_META[b.scope].cls} title={SCOPE_META[b.scope].title}>
                            {SCOPE_META[b.scope].label}
                          </span>
                        )}
                        {b.label && <span style={{ color: 'var(--meta)', fontSize: 12 }}>{b.label}</span>}
                        {/* 凭证键（ADR-031）：自己的绑定可改；他人绑定只显示当前取值方式 */}
                        {b.mine ? (
                          <CredentialKeyEditor
                            key={`${s.slotName}:${b.credentialId}:key`}
                            slotName={s.slotName}
                            keys={(cands.data ?? []).find((c) => c.id === b.credentialId)?.keys ?? []}
                            current={b.credentialKey}
                            pending={setCredentialKey.isPending}
                            onCommit={(next) => setCredentialKey.mutate({ slotName: s.slotName, credentialId: b.credentialId, credentialKey: next })}
                          />
                        ) : (
                          <span className="mono" style={{ color: 'var(--meta)', fontSize: 11 }}>
                            {b.credentialKey ? `键: ${b.credentialKey}` : '键: 按槽位名匹配'}
                          </span>
                        )}
                        {/* SSH 登录用户名：仅认证槽位可见；自己的绑定可直接改（空 = 回落凭证/资产上的用户名） */}
                        {s.slotName === authSlot && (
                          b.mine ? (
                            <UsernameEditor
                              key={`${s.slotName}:${b.credentialId}`}
                              initial={b.username ?? ''}
                              draft={userDraft[`${s.slotName}:${b.credentialId}`]}
                              pending={setUsername.isPending}
                              onChange={(next) => setUserDraft((p) => ({ ...p, [`${s.slotName}:${b.credentialId}`]: next }))}
                              onCommit={(next) => {
                                setUsername.mutate({ slotName: s.slotName, credentialId: b.credentialId, username: next });
                                setUserDraft((p) => { const n = { ...p }; delete n[`${s.slotName}:${b.credentialId}`]; return n; });
                              }}
                            />
                          ) : (
                            <span className="mono" style={{ color: 'var(--meta)', fontSize: 11 }}>
                              {b.username ? `user: ${b.username}` : ''}
                            </span>
                          )
                        )}
                        {b.mine ? (
                          confirming?.slot === s.slotName && confirming.cred === b.credentialId ? (
                            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                              <span style={{ color: 'var(--danger)', fontSize: 11 }}>确认解绑？</span>
                              <button className="btn btn-danger" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => { unbind.mutate({ slotName: s.slotName, credentialId: b.credentialId }); setConfirming(null); }}>确认</button>
                              <button className="btn" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => setConfirming(null)}>取消</button>
                            </span>
                          ) : (
                            <button className="btn" style={{ padding: '1px 6px', fontSize: 11, gap: 2 }} onClick={() => setConfirming({ slot: s.slotName, cred: b.credentialId })}>
                              <X size={10} strokeWidth={2} /> 解绑
                            </button>
                          )
                        ) : (
                          <span style={{ color: 'var(--meta)', fontSize: 11 }}>（他人绑定）</span>
                        )}
                      </div>
                    ))}

                    {/* 直填值与绑定互斥（ADR-027）；非归属人只看到"已设置"，明文仅归属人/管理员可见 */}
                    {!hasBinding && (s.inlineValue === null && s.hasInline) && (
                      <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                        已设置直填值（仅资产归属人与管理员可见明文）
                      </div>
                    )}
                    {!hasBinding && !(s.inlineValue === null && s.hasInline) && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          className="input"
                          style={{ flex: 1 }}
                          placeholder="直接填值（资产自带，不生成凭证）"
                          value={shownValue(s.slotName, s.inlineValue)}
                          onChange={(e) => setDraft((p) => ({ ...p, [s.slotName]: e.target.value }))}
                          onKeyDown={(e) => {
                            const v = shownValue(s.slotName, s.inlineValue);
                            if (e.key === 'Enter' && v.trim()) saveValue.mutate({ slotName: s.slotName, value: v.trim() });
                          }}
                        />
                        {isDirty(s.slotName, s.inlineValue) && (
                          <button className="btn btn-primary" onClick={() => saveValue.mutate({ slotName: s.slotName, value: shownValue(s.slotName, s.inlineValue) })}>保存</button>
                        )}
                      </div>
                    )}
                    {hasBinding && (
                      <div style={{ color: 'var(--meta)', fontSize: 11 }}>已绑定凭证，直填值不可用（两者互斥）</div>
                    )}

                    {/* 添加绑定：一槽可追加多条；候选只有自己创建的凭证（匹配规则与创建弹窗同源） */}
                    <AddBindingButton
                      slotName={s.slotName}
                      isFile={s.file}
                      candidates={(cands.data ?? []).filter((c) => slotMatches(c, s.slotName, s.file))}
                      onPick={(credentialId) => bind.mutate({ slotName: s.slotName, credentialId })}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>
        <button className="btn" onClick={() => setShowAdd(!showAdd)}>手动补槽位</button>
        {showAdd && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <input className="input" placeholder="占位符名（如 MY_TOKEN）" value={addName} onChange={(e) => setAddName(e.target.value)} />
            <div style={{ minWidth: 110 }}><Combobox
              ariaLabel="目标维度"
              value={addTarget}
              onChange={setAddTarget}
              options={[{ value: 'env', label: 'env' }, { value: 'args', label: 'args' }, { value: 'headers', label: 'headers' }]}
            /></div>
            <button className="btn btn-primary" onClick={() => addSlot.mutate({ target: addTarget, name: addName, label: addName, file: /key|cert|pem|private/i.test(addName) })}>添加</button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 绑定级凭证键编辑器（ADR-031）：显示"用凭证的哪个键"，点「改」就地选择。
 *
 * 默认值按 ADR-031 口径推荐：与槽位同名或归一化同名的键（用户多数情况不用改）；
 * 选「按槽位名匹配」= 存 null。候选项来自 /credentials/candidates 的 keys（只有键名，无值）。
 */
function CredentialKeyEditor({
  slotName, keys, current, pending, onCommit,
}: {
  slotName: string;
  keys: string[];
  current: string | null | undefined;
  pending: boolean;
  onCommit: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const norm = (s: string) => s.replace(/^[A-Z][A-Z0-9]*_/, '').toLowerCase().replace(/[_-]/g, '');
  const recommended = keys.find((k) => k === slotName || norm(k) === norm(slotName)) ?? null;
  const effective = current ?? null;

  // 未指定且存在同名键 → 实际会命中；未指定且无同名键 → 运行期会报错，这里提前标出来
  const willFail = effective === null && recommended === null;
  const shown = effective ?? (recommended ? `按槽位名匹配 → ${recommended}` : '按槽位名匹配');

  if (!editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
        <span
          className="mono"
          style={{ color: willFail ? 'var(--danger)' : 'var(--meta)' }}
          title={willFail ? '该槽位名与凭证没有任何键同名，运行时会报错；请指定一个键' : '从凭证里取哪个键'}
        >
          键: {shown}{willFail ? '（无同名键，需指定）' : ''}
        </span>
        <button
          type="button"
          className="btn"
          style={{ padding: '0 6px', fontSize: 11 }}
          disabled={pending}
          onClick={() => setEditing(true)}
          title="指定这条绑定从凭证里取哪个键"
        >
          改键
        </button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
      <div style={{ minWidth: 160 }}>
        <Combobox
          ariaLabel="凭证键"
          value={effective ?? ''}
          onChange={(v) => { onCommit(v === '' ? null : v); setEditing(false); }}
          placeholder="按槽位名匹配"
          searchPlaceholder="搜索键名…"
          options={[
            { value: '', label: recommended ? `按槽位名匹配（→ ${recommended}）` : '按槽位名匹配' },
            ...keys.map((k) => ({ value: k, label: k === recommended ? `${k}（推荐）` : k })),
          ]}
        />
      </div>
      <button type="button" className="btn" style={{ padding: '0 6px', fontSize: 11 }} onClick={() => setEditing(false)}>取消</button>
    </span>
  );
}

/**
 * 绑定级用户名编辑器（SSH 专用）：显示当前值，点「改」就地编辑，回车/失焦提交。
 * 空串 = 清除覆盖，解析时回落到凭证 `username` 键或资产上的用户名。
 */
function UsernameEditor({
  initial, draft, pending, onChange, onCommit,
}: {
  initial: string;
  draft?: string;
  pending: boolean;
  onChange: (next: string) => void;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const current = draft ?? initial;
  if (!editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--meta)' }}>
        <span className="mono">{current ? `user: ${current}` : '用户名沿用凭证/资产'}</span>
        <button type="button" className="btn" style={{ padding: '0 6px', fontSize: 11 }} onClick={() => setEditing(true)} title="指定这条绑定使用的 SSH 登录用户名">
          改用户名
        </button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        className="input mono"
        style={{ width: 120, height: 24, fontSize: 11, padding: '0 6px', flexShrink: 0 }}
        placeholder="如 root / deploy"
        value={current}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { onCommit(current.trim()); setEditing(false); }
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button type="button" className="btn btn-primary" style={{ height: 24, padding: '0 8px', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }} disabled={pending}
        onClick={() => { onCommit(current.trim()); setEditing(false); }}>
        保存
      </button>
      <button type="button" className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}
        onClick={() => setEditing(false)}>
        取消
      </button>
    </span>
  );
}

/** 「添加绑定」：点击用 SlotValueEditor 的候选下拉选凭证（复用键名匹配逻辑） */
function AddBindingButton({
  slotName, isFile, candidates, onPick,
}: {
  slotName: string;
  isFile?: boolean;
  candidates: Candidate[];
  onPick: (credentialId: string) => void;
}) {
  return (
    <SlotValueEditor
      slotName={slotName}
      isFile={isFile}
      label=""
      // 候选已在上层按同一规则过滤过；这里传全量，由 SlotValueEditor 用 isFile 再算一次
      candidates={candidates}
      value=""
      onValueChange={() => {}}
      onPick={onPick}
      onUnbind={() => {}}
      mode="pick-only"
    />
  );
}
