import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Trash2, Eye, EyeOff, Pencil, AlertTriangle } from 'lucide-react';
import { api, ApiError, fmtTs } from '../api';

interface Detail {
  id: string; name: string; kind: string; valueHint: string; ownerId: string; ownerName?: string; updatedAt: number | null;
  privileges?: string[];
  actualUsers?: number;
  boundServers: Array<{ serverId: string; name: string; category: string; slots: string[] }>;
  /** ADR-028：已共享到的分组 */
  sharedGroups?: Array<{ groupId: string; name: string }>;
  /** 后端判定：当前用户是否可管理（false = 只读查看共享凭证） */
  canManage?: boolean;
}

interface GroupRow { id: string; name: string }

const PRIV_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  root: { label: 'root', color: 'var(--danger)', bg: 'var(--danger-soft)' },
  rw: { label: '读写', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  wo: { label: '只写', color: 'var(--warn)', bg: 'var(--warn-soft)' },
  ro: { label: '只读', color: 'var(--muted)', bg: 'var(--surface-raise)' },
};

/** 凭证详情（Spec §8.5 `/credentials/:id`）：概要 + 引用资产列表 + 删除前名单（§8.8 列对象清单）。 */
export default function CredentialDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['credential', id], queryFn: () => api<Detail>(`/api/v1/credentials/${id}`) });
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string> | null>(null);
  const del = useMutation({
    mutationFn: () => api(`/api/v1/credentials/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credentials'] });
      nav('/credentials');
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '删除失败'),
  });
  const reveal = useMutation({
    mutationFn: () => api<{ id: string; values: Record<string, string> }>(`/api/v1/credentials/${id}/reveal`),
    onSuccess: (d) => { setRevealed(d.values); setErr(''); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '查看明文失败'),
  });
  const d = q.data;
  if (!d) return (
    <div className="page animate-slide-up">
      <div className="card" style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </div>
        <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</span>
      </div>
    </div>
  );
  return (
    <div className="page animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn" onClick={() => nav(-1)} style={{ padding: '7px 10px', minHeight: 34 }}>
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent-soft)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <KeyRound size={18} style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
          </div>
          <div>
            <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }} className="mono">{d.name}</h1>
            <p style={{ color: 'var(--muted)', margin: '2px 0 0', fontSize: 'var(--text-sm)' }}>
              {d.kind} · 归属 {d.ownerName ?? d.ownerId.slice(0, 8)}
            </p>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 20, display: 'grid', gap: 10, maxWidth: 640 }}>
        <Row k="类型" v={d.kind} />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ width: 100, color: 'var(--meta)', fontSize: 'var(--text-sm)', flexShrink: 0 }}>值提示</div>
          {revealed ? (
            <div style={{ display: 'grid', gap: 2, flex: 1 }}>
              {Object.entries(revealed).map(([k, v]) => (
                <div key={k} className="mono" style={{ fontSize: 12, color: 'var(--fg-2)', wordBreak: 'break-all' }}>
                  <span style={{ color: 'var(--meta)' }}>{k}</span>: {v}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 'var(--text-sm)' }}>{d.valueHint}</div>
          )}
          <button
            className="btn"
            style={{ padding: '2px 8px', minHeight: 26 }}
            title={revealed ? '隐藏明文' : '查看明文（仅归属人可见，操作留审计）'}
            disabled={reveal.isPending}
            onClick={() => {
              if (revealed) { setRevealed(null); return; }
              reveal.mutate();
            }}
          >
            {revealed ? <EyeOff size={14} strokeWidth={1.8} /> : <Eye size={14} strokeWidth={1.8} />}
          </button>
        </div>
        <Row k="归属" v={d.ownerName ?? d.ownerId} />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ width: 100, color: 'var(--meta)', fontSize: 'var(--text-sm)', flexShrink: 0 }}>等级</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(d.privileges ?? []).length === 0
              ? <span style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>无（仅展示性标签，不影响授权）</span>
              : (d.privileges ?? []).map((p) => {
                  const m = PRIV_LABEL[p] ?? { label: p, color: 'var(--muted)', bg: 'var(--surface-raise)' };
                  return (
                    <span key={p} style={{
                      fontSize: 11, padding: '1px 7px', borderRadius: 4,
                      color: m.color, background: m.bg, fontWeight: 600,
                    }}>{m.label}</span>
                  );
                })}
          </div>
        </div>
        <Row k="实际使用者" v={String(d.actualUsers ?? '无')} />
        <Row k="更新" v={fmtTs(d.updatedAt)} />
      </div>

      <SharePanel credentialId={d.id} ownerId={d.ownerId} canManage={d.canManage} sharedGroups={d.sharedGroups ?? []} />

      <div className="card" style={{ padding: 20 }}>
        <div style={{ color: 'var(--fg-2)', fontWeight: 600, marginBottom: 12, fontSize: 'var(--text-sm)' }}>
          引用资产（{d.boundServers.length}）
        </div>
        {d.boundServers.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>未被任何资产引用</div>
        ) : (
          <table className="dt">
            <thead><tr><th>资产</th><th>类别</th><th>绑定槽位</th><th>ID</th></tr></thead>
            <tbody>
              {d.boundServers.map((s) => (
                <tr key={s.serverId}>
                  <td className="mono">{s.name}</td><td>{s.category}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{s.slots.join('、')}</td>
                  <td className="mono">{s.serverId.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', padding: '10px 14px', background: 'var(--danger-soft)', borderRadius: 'var(--radius)' }}>{err}</div>}

      {d.canManage !== false && (
        <EditValuesPanel
          credentialId={d.id}
          boundCount={d.boundServers.length}
          onSaved={() => { setErr(''); void qc.invalidateQueries({ queryKey: ['credential', id] }); }}
          onError={(m: string) => setErr(m)}
        />
      )}

      {!confirming ? (
        <div>
          <button className="btn btn-danger" onClick={() => setConfirming(true)} style={{ gap: 6 }}>
            <Trash2 size={14} strokeWidth={1.8} /> 删除凭证
          </button>
        </div>
      ) : (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 10, maxWidth: 640, borderColor: 'var(--danger)' }}>
          <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
            确认删除「{d.name}」？以下 {d.boundServers.length} 个资产将断开该凭证：
          </div>
          <div style={{ fontSize: 'var(--text-sm)' }}>{d.boundServers.map((s) => s.name).join('、') || '（无）'}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-danger" onClick={() => del.mutate()}>确认删除</button>
            <button className="btn" onClick={() => setConfirming(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline' }}>
      <div style={{ width: 100, color: 'var(--meta)', fontSize: 'var(--text-sm)', flexShrink: 0 }}>{k}</div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: 'var(--text-sm)' }}>{v || '无'}</div>
    </div>
  );
}

/**
 * 共享至分组面板（ADR-028 / T11）：owner 逐个开关；非 owner 只读。
 * 为什么非 owner 也显示面板：让用户知道"这个凭证对我所在分组是否可见"，
 * 隐藏面板反而让人以为凭证没共享。
 */
function SharePanel({
  credentialId, ownerId, canManage, sharedGroups,
}: {
  credentialId: string;
  ownerId: string;
  /** 后端给出的管理权限；缺省时退回前端会话比对 */
  canManage?: boolean;
  sharedGroups: Array<{ groupId: string; name: string }>;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<GroupRow[]>('/api/v1/groups') });
  const me = useQuery({
    queryKey: ['session-me'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { id?: string; isAdmin?: boolean } };
      return { id: j?.user?.id ?? '', isAdmin: Boolean(j?.user?.isAdmin) };
    },
    staleTime: 60_000,
  });
  // 只有归属人或管理员能改共享开关（后端同样校验，这里只是体验层）
  const canEdit = canManage !== undefined
    ? canManage
    : (me.data ? (me.data.isAdmin || me.data.id === ownerId) : false);
  const sharedSet = new Set(sharedGroups.map((s) => s.groupId));

  const toggle = useMutation({
    mutationFn: (v: { groupId: string; shared: boolean }) =>
      api(`/api/v1/credentials/${credentialId}/shares/${v.groupId}`, { method: v.shared ? 'DELETE' : 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credential', credentialId] });
      void qc.invalidateQueries({ queryKey: ['credentials'] });
      setErr('');
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '操作失败'),
  });

  const rows = groups.data ?? [];

  return (
    <div className="card" style={{ padding: 20, maxWidth: 640 }}>
      <div style={{ color: 'var(--fg-2)', fontWeight: 600, marginBottom: 4, fontSize: 'var(--text-sm)' }}>
        共享至分组
      </div>
      <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', marginBottom: 12 }}>
        {canEdit
          ? '共享后，该分组成员可在资产中"使用"此凭证，但不能把它绑定到自己的资产上；未共享的分组看不到它'
          : '仅凭证归属人可修改共享范围'}
      </div>
      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', marginBottom: 8 }}>{err}</div>}
      {rows.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
          无可用分组（分组由管理员按需创建）
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((g) => {
            const shared = sharedSet.has(g.id);
            return (
              <div
                key={g.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 12px', background: 'var(--surface-raise)', borderRadius: 'var(--radius)',
                }}
              >
                <span style={{ fontSize: 'var(--text-sm)' }}>{g.name}</span>
                {canEdit ? (
                  <button
                    className={shared ? 'btn btn-primary' : 'btn'}
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ groupId: g.id, shared })}
                    style={{ fontSize: 'var(--text-xs)', padding: '3px 10px', minHeight: 26 }}
                    title={shared ? '点击取消共享' : '点击共享给该分组'}
                  >
                    {shared ? '已共享' : '未共享'}
                  </button>
                ) : (
                  <span className={shared ? 'badge-success' : 'tag'} style={{ fontSize: 11 }}>
                    {shared ? '已共享' : '未共享'}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 编辑凭证值（轮换）。改动值会让**所有绑定资产**的实例键失效并重建（后端 credential_rotate 副作用）。
 * 为什么不去凭证列表页做：这里能直接看到"会影响哪些资产"，避免误改。
 */
function EditValuesPanel({
  credentialId, boundCount, onSaved, onError,
}: {
  credentialId: string;
  boundCount: number;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const loadCurrent = async () => {
    setLoading(true);
    try {
      const d = await api<{ values: Record<string, string> }>(`/api/v1/credentials/${credentialId}/reveal`);
      setVals(d.values);
      setOpen(true);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : '读取当前值失败');
    } finally {
      setLoading(false);
    }
  };

  const save = useMutation({
    mutationFn: (values: Record<string, string>) =>
      api(`/api/v1/credentials/${credentialId}`, { method: 'PATCH', body: JSON.stringify({ values }) }),
    onSuccess: () => { setOpen(false); setConfirming(false); onSaved(); },
    onError: (e) => onError(e instanceof ApiError ? e.message : '保存失败'),
  });

  if (!open) {
    return (
      <button className="btn" onClick={() => void loadCurrent()} disabled={loading} style={{ gap: 6 }}>
        <Pencil size={14} strokeWidth={1.8} /> {loading ? '读取中…' : '编辑凭证值'}
      </button>
    );
  }

  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 12, maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Pencil size={15} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>编辑凭证值</span>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => { setOpen(false); setConfirming(false); }}>取消</button>
      </div>

      {Object.keys(vals).length === 0 && (
        <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>该凭证没有可编辑的键。</div>
      )}

      {Object.entries(vals).map(([k, v]) => {
        const secret = /pass|secret|token|api|key|private|credential|kubeconfig/i.test(k);
        const shown = reveal[k];
        // 多行内容（kubeconfig / 私钥 / JSON）必须用 textarea：单行 input 会把换行压掉，
        // 用户改一个字符就可能把整份 YAML 压成一行、彻底失效。
        const isMultiline = /kubeconfig|private|key|pem|cert|json|yaml/i.test(k) || /\n/.test(v);
        return (
          <div key={k} style={{ display: 'grid', gap: 4 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }} className="mono">{k}</label>
            <div style={{ position: 'relative' }}>
              {isMultiline ? (
                <textarea
                  className="input mono"
                  rows={Math.min(18, Math.max(6, v.split('\n').length + 1))}
                  style={{ width: '100%', paddingRight: secret ? 36 : 12, boxSizing: 'border-box', resize: 'vertical' }}
                  spellCheck={false}
                  value={v}
                  onChange={(e) => setVals((p) => ({ ...p, [k]: e.target.value }))}
                />
              ) : (
                <input
                  className="input mono"
                  style={{ width: '100%', paddingRight: secret ? 36 : 12, boxSizing: 'border-box' }}
                  type={secret && !shown ? 'password' : 'text'}
                  value={v}
                  onChange={(e) => setVals((p) => ({ ...p, [k]: e.target.value }))}
                  autoComplete="new-password"
                />
              )}
              {secret && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ position: 'absolute', right: 2, top: 4, width: 28, height: 28 }}
                  onClick={() => setReveal((r) => ({ ...r, [k]: !r[k] }))}
                  aria-label={shown ? `隐藏 ${k}` : `显示 ${k}`}
                >
                  {shown ? <EyeOff size={14} strokeWidth={1.8} /> : <Eye size={14} strokeWidth={1.8} />}
                </button>
              )}
            </div>
            {isMultiline && !shown && (
              <span style={{ color: 'var(--meta)', fontSize: 12 }}>
                多行内容：请用上方文本框编辑（会保留换行与缩进）。
              </span>
            )}
          </div>
        );
      })}

      {!confirming ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => setConfirming(true)} disabled={save.isPending}>保存并轮换</button>
          {boundCount > 0 && (
            <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
              保存后将重建 {boundCount} 个绑定资产的实例
            </span>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)', borderRadius: 'var(--r-md)' }}>
          <AlertTriangle size={15} strokeWidth={2} style={{ color: 'var(--warn)', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 200, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
            确认修改？现有 {boundCount} 个已启动的资产实例会被回收并在下次调用时用新凭证重建。
          </span>
          <button className="btn btn-primary" onClick={() => save.mutate(vals)} disabled={save.isPending}>
            {save.isPending ? '保存中…' : '确认修改'}
          </button>
          <button className="btn" onClick={() => setConfirming(false)}>取消</button>
        </div>
      )}
    </div>
  );
}
