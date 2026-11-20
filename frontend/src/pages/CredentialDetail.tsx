import { useParams, useNavigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Trash2, Eye, EyeOff, Pencil, AlertTriangle, Plus, Search, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
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
  /** 被资产槽位实际取用的键（删除/改名这些键会让对应槽位取不到值） */
  referencedKeys?: Array<{ key: string; servers: Array<{ serverId: string; name: string; slots: string[] }> }>;
}

interface GroupRow { id: string; name: string }

const PRIV_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  root: { label: 'root', color: 'var(--danger)', bg: 'var(--danger-soft)' },
  rw: { label: '读写', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  wo: { label: '只写', color: 'var(--warn)', bg: 'var(--warn-soft)' },
  ro: { label: '只读', color: 'var(--muted)', bg: 'var(--surface-raise)' },
};
/** 等级选择顺序（与创建弹窗一致） */
const PRIV_ORDER = ['root', 'rw', 'wo', 'ro'] as const;

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

      {/* 各卡片统一全宽：此前 640/680/全宽混用，表格与编辑区左右边缘对不齐 */}
      <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
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

      <BoundServersCard servers={d.boundServers} />

      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', padding: '10px 14px', background: 'var(--danger-soft)', borderRadius: 'var(--radius)' }}>{err}</div>}

      {d.canManage !== false && (
        <EditValuesPanel
          credentialId={d.id}
          name={d.name}
          privileges={d.privileges ?? []}
          referencedKeys={d.referencedKeys ?? []}
          boundCount={d.boundServers.length}
          onSaved={() => { setErr(''); void qc.invalidateQueries({ queryKey: ['credential', id] }); void qc.invalidateQueries({ queryKey: ['credentials'] }); }}
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

const BOUND_PAGE_SIZE = 15;

/**
 * 引用资产列表：一个 SSH 密钥常被上百台主机共用，全量平铺会把页面撑到几千像素。
 * 这里做客户端分页 + 名称搜索（数据已在详情响应里，不额外请求）。
 */
function BoundServersCard({ servers }: { servers: Array<{ serverId: string; name: string; category: string; slots: string[] }> }) {
  const [page, setPage] = useState(1);
  const [kw, setKw] = useState('');

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter((s) => s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q));
  }, [servers, kw]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / BOUND_PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const rows = filtered.slice((curPage - 1) * BOUND_PAGE_SIZE, curPage * BOUND_PAGE_SIZE);

  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ color: 'var(--fg-2)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>
          引用资产（{servers.length}）
        </span>
        {servers.length > 0 && (
          <div style={{ position: 'relative', marginLeft: 'auto', flex: '0 1 260px', minWidth: 160 }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--meta)', pointerEvents: 'none' }} strokeWidth={1.8} />
            <input
              className="input"
              style={{ paddingLeft: 30 }}
              placeholder="搜索资产名 / 类别"
              value={kw}
              onChange={(e) => { setKw(e.target.value); setPage(1); }}
              aria-label="搜索引用资产"
            />
          </div>
        )}
      </div>

      {servers.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>未被任何资产引用</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>无匹配资产</div>
      ) : (
        <>
          <table className="dt">
            <thead><tr><th>资产</th><th>类别</th><th>绑定槽位</th><th>ID</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.serverId}>
                  <td className="mono">{s.name}</td><td>{s.category}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{s.slots.join('、')}</td>
                  <td className="mono">{s.serverId.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', marginTop: 12 }}>
            <button className="btn" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>
              <ChevronLeft size={14} /> 上一页
            </button>
            <span className="mono" style={{ fontSize: 'var(--text-sm)', padding: '0 8px' }}>
              {curPage} / {totalPages}（{filtered.length} 项）
            </span>
            <button className="btn" disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>
              下一页 <ChevronRight size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {  return (
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
  const sharedCount = rows.filter((g) => sharedSet.has(g.id)).length;
  // 默认折叠：共享是低频操作，展开的开关列表会占掉首屏大量纵向空间
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card" style={{ padding: 20 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ color: 'var(--fg-2)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>共享至分组</span>
        <span className="tag" style={{ fontSize: 11 }}>
          {sharedCount > 0 ? `已共享 ${sharedCount}` : '未共享'}
        </span>
        <span style={{ flex: 1 }} />
        <ChevronDown
          size={15}
          strokeWidth={1.8}
          style={{ color: 'var(--meta)', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}
        />
      </button>
      {!expanded && (
        <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', marginTop: 4 }}>
          共享后，分组成员可在资产中使用此凭证（不能绑定到自己的资产）
        </div>
      )}
      {expanded && (
        <>
      <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', margin: '8px 0 12px' }}>
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
        </>
      )}
    </div>
  );
}

/**
 * 编辑凭证（名称 / 等级 / 键集合）。键可以新增、删除、改名（改名 = 删旧键 + 加新键），保存时整份集合提交。
 * 改动值会让**所有绑定资产**的实例键失效并重建（后端 credential_rotate 副作用）。
 * 为什么不去凭证列表页做：这里能直接看到"会影响哪些资产"，避免误改。
 */
function EditValuesPanel({
  credentialId, name, privileges, referencedKeys, boundCount, onSaved, onError,
}: {
  credentialId: string;
  name: string;
  privileges: string[];
  referencedKeys: Array<{ key: string; servers: Array<{ serverId: string; name: string; slots: string[] }> }>;
  boundCount: number;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>([]);
  const [origKeys, setOrigKeys] = useState<string[]>([]);
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [draftName, setDraftName] = useState(name);
  const [draftPriv, setDraftPriv] = useState<string[]>(privileges);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [localErr, setLocalErr] = useState('');

  const refMap = new Map(referencedKeys.map((r) => [r.key, r.servers]));

  const loadCurrent = async () => {
    setLoading(true);
    try {
      const d = await api<{ values: Record<string, string> }>(`/api/v1/credentials/${credentialId}/reveal`);
      const list = Object.entries(d.values).map(([key, value]) => ({ key, value }));
      setRows(list);
      setOrigKeys(list.map((x) => x.key));
      setDraftName(name);
      setDraftPriv(privileges);
      setReveal({});
      setLocalErr('');
      setOpen(true);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : '读取当前值失败');
    } finally {
      setLoading(false);
    }
  };

  const dupKeys = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    if (seen.has(k)) dupKeys.add(k);
    seen.add(k);
  }
  const emptyKeyRow = rows.some((r) => r.key.trim() === '');
  const noValue = rows.every((r) => r.value.trim() === '');
  const canSave = !dupKeys.size && !emptyKeyRow && !noValue;

  /** 已删除或改名的原键（这些键不再存在于提交集合中） */
  const removingKeys = origKeys.filter((k) => !seen.has(k));

  const save = useMutation({
    mutationFn: () => {
      const values: Record<string, string> = {};
      for (const r of rows) {
        const k = r.key.trim();
        if (k) values[k] = r.value;
      }
      const body: Record<string, unknown> = { values };
      if (draftName.trim() && draftName.trim() !== name) body.name = draftName.trim();
      if (JSON.stringify([...draftPriv].sort()) !== JSON.stringify([...privileges].sort())) body.privileges = draftPriv;
      return api(`/api/v1/credentials/${credentialId}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => { setOpen(false); setConfirming(false); onSaved(); },
    onError: (e) => onError(e instanceof ApiError ? e.message : '保存失败'),
  });

  if (!open) {
    return (
      <button className="btn" onClick={() => void loadCurrent()} disabled={loading} style={{ gap: 6 }}>
        <Pencil size={14} strokeWidth={1.8} /> {loading ? '读取中…' : '编辑凭证'}
      </button>
    );
  }

  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 12, maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Pencil size={15} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>编辑凭证</span>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => { setOpen(false); setConfirming(false); }}>取消</button>
      </div>

      <div style={{ display: 'grid', gap: 4 }}>
        <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>名称</label>
        <input className="input mono" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
      </div>

      <div style={{ display: 'grid', gap: 4 }}>
        <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>权限等级（可选，仅展示不参与授权）</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PRIV_ORDER.map((key) => {
            const m = PRIV_LABEL[key]!;
            const on = draftPriv.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setDraftPriv(on ? draftPriv.filter((x) => x !== key) : [...draftPriv, key])}
                style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                  border: `1px solid ${on ? m.color : 'var(--border)'}`,
                  color: on ? m.color : 'var(--muted)',
                  background: on ? m.bg : 'transparent',
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--fg-2)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>键值</span>
        <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>共 {rows.length} 个键</span>
        <button
          type="button"
          className="btn"
          style={{ marginLeft: 'auto', gap: 4, fontSize: 'var(--text-xs)', padding: '2px 8px' }}
          onClick={() => setRows([...rows, { key: '', value: '' }])}
        >
          <Plus size={12} strokeWidth={2} /> 添加键
        </button>
      </div>

      {rows.length === 0 && (
        <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>该凭证没有键；点击「添加键」新建。</div>
      )}

      {rows.map((r, i) => {
        const k = r.key.trim();
        const secret = /pass|secret|token|api|key|private|credential|kubeconfig/i.test(k);
        const shown = reveal[i];
        const isMultiline = /kubeconfig|private|key|pem|cert|json|yaml/i.test(k) || /\n/.test(r.value);
        const refs = refMap.get(k);
        const dup = k !== '' && dupKeys.has(k);
        return (
          <div key={i} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                className="input mono"
                style={{ flex: 1, ...(dup ? { borderColor: 'var(--danger)' } : {}) }}
                placeholder="键名"
                value={r.key}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              />
              <button
                type="button"
                className="btn btn-danger"
                style={{ padding: '4px 8px', flexShrink: 0 }}
                title="删除该键"
                aria-label={`删除键 ${k || i + 1}`}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} strokeWidth={1.8} />
              </button>
            </div>
            <div style={{ position: 'relative' }}>
              {isMultiline ? (
                <textarea
                  className="input mono"
                  rows={Math.min(18, Math.max(4, r.value.split('\n').length + 1))}
                  style={{ width: '100%', paddingRight: secret ? 36 : 12, boxSizing: 'border-box', resize: 'vertical' }}
                  spellCheck={false}
                  placeholder="值"
                  value={r.value}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
              ) : (
                <input
                  className="input mono"
                  style={{ width: '100%', paddingRight: secret ? 36 : 12, boxSizing: 'border-box' }}
                  type={secret && !shown ? 'password' : 'text'}
                  placeholder="值"
                  value={r.value}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  autoComplete="new-password"
                />
              )}
              {secret && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ position: 'absolute', right: 2, top: 4, width: 28, height: 28 }}
                  onClick={() => setReveal((p) => ({ ...p, [i]: !p[i] }))}
                  aria-label={shown ? `隐藏 ${k}` : `显示 ${k}`}
                >
                  {shown ? <EyeOff size={14} strokeWidth={1.8} /> : <Eye size={14} strokeWidth={1.8} />}
                </button>
              )}
            </div>
            {dup && <span style={{ color: 'var(--danger)', fontSize: 12 }}>键名重复</span>}
            {refs && (
              // 只给一行通用提示：完整清单在下方的「引用资产」卡片里（已分页），
              // 这里展开列出 115 条资产名会把编辑区撑到几千像素（用户反馈）。
              <span style={{ color: 'var(--warn)', fontSize: 12 }}>
                该键正被 {refs.length} 个资产的槽位取用，删除或改名后这些槽位将取不到值
              </span>
            )}
          </div>
        );
      })}

      {removingKeys.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 12px',
          background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)', borderRadius: 'var(--r-md)',
        }}>
          <AlertTriangle size={15} strokeWidth={2} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
            将删除键：{removingKeys.map((k) => <span key={k} className="mono" style={{ marginRight: 6 }}>{k}</span>)}
            {removingKeys.some((k) => refMap.has(k)) && (
              <><br /><span style={{ color: 'var(--warn)' }}>
                其中 {removingKeys.filter((k) => refMap.has(k)).join('、')} 正被资产槽位取用，删除后这些槽位将在调用时报错。
              </span></>
            )}
          </span>
        </div>
      )}

      {localErr && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{localErr}</div>}

      {!confirming ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!canSave) { setLocalErr(emptyKeyRow ? '存在空键名' : dupKeys.size ? '键名重复' : '至少一个非空值'); return; }
              setLocalErr('');
              setConfirming(true);
            }}
          >
            保存并轮换
          </button>
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
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? '保存中…' : '确认修改'}
          </button>
          <button className="btn" onClick={() => setConfirming(false)}>取消</button>
        </div>
      )}
    </div>
  );
}
