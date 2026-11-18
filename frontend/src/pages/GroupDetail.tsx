import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft, FolderOpen, Trash2, Plus, Server, Users2, Braces,
  Pencil, Search, Loader2,
} from 'lucide-react';
import { api, ApiError, fmtTs } from '../api';
import Modal from '../components/Modal';

interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  serverIds?: string[];
  userIds?: string[];
  members: Array<{ id: string; username: string }>;
  /** 成员数（成员视角也能看，用于替代隐藏的成员名单） */
  memberCount?: number;
  assets: Array<{ id: string; name: string; category: string }>;
  metadata: Array<{ key: string; value: string }>;
}

interface ServerItem {
  id: string; name: string; displayName: string | null; category: string;
}
interface UserItem { id: string; username: string; name: string | null; isAdmin: boolean }

/** 分组详情子页面：描述 / KV 元信息 / 关联资产 / 授权成员。 */
export default function GroupDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['group', id],
    queryFn: () => api<GroupDetail>(`/api/v1/groups/${id}`),
    // 404 是确定结论，不重试（否则详情页要等 ~7s 才落到"分组不存在"）
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 2,
  });
  const g = q.data;

  // 分组的新建/删除/关联资产/授权成员都是 admin-only（后端 accessMode='admin'）：
  // 成员只能浏览自己所在分组的资产并点进详情页绑定自己的凭证。
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { isAdmin?: boolean } };
      return Boolean(j?.user?.isAdmin);
    },
  });
  const isAdmin = me.data === true;

  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<
    | { kind: 'asset'; serverId: string; name: string }
    | { kind: 'member'; userId: string; name: string }
    | { kind: 'kv'; key: string }
    | null
  >(null);
  const [picker, setPicker] = useState<'assets' | 'members' | null>(null);
  const [kvOpen, setKvOpen] = useState(false);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['group', id] }); };

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/v1/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { setErr(''); refresh(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '保存失败'),
  });

  const del = useMutation({
    mutationFn: () => api(`/api/v1/groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['groups'] }); nav('/groups'); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '删除失败'),
  });

  const removeAsset = useMutation({
    mutationFn: (serverId: string) => api(`/api/v1/groups/${id}/servers/${serverId}`, { method: 'DELETE' }),
    onSuccess: () => { setErr(''); refresh(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '移除失败'),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`/api/v1/groups/${id}/users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => { setErr(''); refresh(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '移除失败'),
  });

  const removeKv = useMutation({
    mutationFn: (key: string) =>
      api(`/api/v1/groups/${id}/metadata?key=${encodeURIComponent(key)}`, { method: 'DELETE' }),
    onSuccess: () => { setErr(''); refresh(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '删除失败'),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !g) {
    return (
      <div className="page animate-slide-up">
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <FolderOpen size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
          <div style={{ fontWeight: 600 }}>分组不存在</div>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => nav('/groups')}>返回分组列表</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn" onClick={() => nav('/groups')} style={{ padding: '7px 10px', minHeight: 34 }} title="返回分组列表">
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          {isAdmin ? <GroupNameEditor name={g.name} onSave={(name) => patch.mutate({ name })} />
            : <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }} className="mono">{g.name}</div>}
          <p style={{ color: 'var(--muted)', margin: '2px 0 0', fontSize: 'var(--text-sm)' }}>
            资产 {g.assets.length} · 成员 {isAdmin ? g.members.length : (g.memberCount ?? g.members.length)} · 元信息 {g.metadata.length} · 创建 {fmtTs(g.createdAt)}
          </p>
        </div>
        {isAdmin && (
          <button className="btn btn-danger" onClick={() => setConfirmDel(true)} style={{ gap: 6 }}>
            <Trash2 size={14} strokeWidth={1.8} /> 删除分组
          </button>
        )}
      </div>

      {err && (
        <div className="card" style={{ padding: '10px 14px', borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
          {err}
        </div>
      )}

      <DescriptionCard description={g.description} onSave={(description) => patch.mutate({ description })} readOnly={!isAdmin} />

      <div className="card" style={{ padding: 20 }}>
        <SectionHeader icon={<Braces size={15} strokeWidth={1.8} />} title="元信息" count={g.metadata.length}
          action={isAdmin ? <button className="btn" onClick={() => setKvOpen(true)} style={{ gap: 6 }}><Plus size={14} strokeWidth={2} /> 添加</button> : undefined} />
        {g.metadata.length === 0 ? (
          <div className="empty" style={{ padding: '24px 0' }}>
            <Braces size={28} style={{ color: 'var(--meta)', marginBottom: 6 }} strokeWidth={1.5} />
            <div>暂无元信息</div>
            <div className="hint">可添加自定义 key-value（如 env、region、tier）</div>
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <RowGrid cols="220px 1fr 90px" header={['键', '值', '操作']} />
            <div style={{ border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 var(--radius-md) var(--radius-md)', overflow: 'hidden' }}>
              {g.metadata.map((m) => (
                <div key={m.key} style={{ ...rowGridStyle('220px 1fr 90px'), borderBottom: '1px solid var(--border-soft)', minHeight: 40 }}>
                  <div className="mono" style={{ fontSize: 13, color: 'var(--fg)', wordBreak: 'break-all' }}>{m.key}</div>
                  <div className="mono" style={{ fontSize: 13, color: 'var(--muted)', wordBreak: 'break-all' }}>{m.value}</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    {isAdmin && <RemoveBtn onClick={() => setConfirmTarget({ kind: 'kv', key: m.key })} label={`删除元信息 ${m.key}`} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AssetSection assets={g.assets} onAdd={() => setPicker('assets')} canManage={isAdmin}
        onRemove={(serverId, name) => setConfirmTarget({ kind: 'asset', serverId, name })}
        onOpen={(serverId) => nav(`/assets/${serverId}`)} />

      {/* 成员名单仅管理员可见：接口对成员返回 members=[] + memberCount */}
      {isAdmin && (
        <MemberSection members={g.members} onAdd={() => setPicker('members')}
          onRemove={(userId, name) => setConfirmTarget({ kind: 'member', userId, name })} />
      )}

      {kvOpen && (
        <KvModal groupId={id!} existing={g.metadata.map((m) => m.key)} onClose={() => setKvOpen(false)}
          onSaved={() => { setKvOpen(false); refresh(); }} />
      )}
      {picker === 'assets' && (
        <AssetPickerModal groupId={id!} bound={g.serverIds ?? g.assets.map((a) => a.id)} onClose={() => setPicker(null)}
          onSaved={() => { setPicker(null); refresh(); }} />
      )}
      {picker === 'members' && (
        <MemberPickerModal groupId={id!} bound={g.members.map((m) => m.id)} onClose={() => setPicker(null)}
          onSaved={() => { setPicker(null); refresh(); }} />
      )}
      {confirmDel && (
        <Modal title="删除分组" onClose={() => setConfirmDel(false)}>
          <div style={{ color: 'var(--danger)' }}>
            确认删除分组「{g.name}」？（将自动解除该组下资产与成员的关联，删除后组内资产仍保留）
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={() => del.mutate()}>确认删除</button>
          </div>
        </Modal>
      )}
      {confirmTarget?.kind === 'asset' && (
        <ConfirmDialog
          title="移除关联资产"
          message={<>确认将资产「{confirmTarget.name}」移出分组「{g.name}」？<br />（仅解除关联，资产本身保留）</>}
          confirmLabel="确认移除"
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => { removeAsset.mutate(confirmTarget.serverId); setConfirmTarget(null); }}
        />
      )}
      {confirmTarget?.kind === 'member' && (
        <ConfirmDialog
          title="移除授权成员"
          message={<>确认将成员「{confirmTarget.name}」移出分组「{g.name}」？<br />（仅解除授权，用户账号保留）</>}
          confirmLabel="确认移除"
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => { removeMember.mutate(confirmTarget.userId); setConfirmTarget(null); }}
        />
      )}
      {confirmTarget?.kind === 'kv' && (
        <ConfirmDialog
          title="删除元信息"
          message={<>确认删除元信息「{confirmTarget.key}」？</>}
          confirmLabel="确认删除"
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => { removeKv.mutate(confirmTarget.key); setConfirmTarget(null); }}
        />
      )}
    </div>
  );
}

/* ---------- 子组件 ---------- */

function GroupNameEditor({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => { setDraft(name); }, [name]);

  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h1 className="mono" style={{ fontSize: 'var(--text-xl)', fontWeight: 650, margin: 0 }}>{name}</h1>
        <button className="btn" style={{ padding: '4px 7px', minHeight: 26 }} title="重命名" onClick={() => setEditing(true)}>
          <Pencil size={12} strokeWidth={1.8} />
        </button>
      </div>
    );
  }
  return (
    <input
      className="input mono"
      autoFocus
      value={draft}
      style={{ fontSize: 'var(--text-xl)', fontWeight: 650, padding: '4px 10px' }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); if (draft && draft !== name) onSave(draft); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setDraft(name); setEditing(false); }
      }}
    />
  );
}

function DescriptionCard({ description, onSave, readOnly }: { description: string | null; onSave: (d: string) => void; readOnly?: boolean }) {
  const [draft, setDraft] = useState(description ?? '');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setDraft(description ?? ''); setDirty(false); }, [description]);

  return (
    <div className="card" style={{ padding: 20 }}>
      <SectionHeader icon={<FolderOpen size={15} strokeWidth={1.8} />} title="分组描述" />
      <p style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', margin: '0 0 10px' }}>
        描述会注入 MCP 连接的 instructions，LLM 连接该组即可读取管理员维护的业务背景
      </p>
      <textarea
        className="input"
        rows={3}
        placeholder="分组说明（如：生产 MySQL 实例组，禁删数据）"
        value={draft}
        readOnly={readOnly}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
        onBlur={() => { if (dirty && !readOnly) { setDirty(false); onSave(draft); } }}
        style={{ resize: 'vertical', fontFamily: 'inherit', width: '100%', display: 'block', ...(readOnly ? { opacity: 0.8 } : {}) }}
      />
    </div>
  );
}

function AssetSection({
  assets, onAdd, onRemove, onOpen, canManage,
}: {
  assets: GroupDetail['assets'];
  onAdd: () => void;
  onRemove: (id: string, name: string) => void;
  onOpen: (id: string) => void;
  canManage: boolean;
}) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <SectionHeader icon={<Server size={15} strokeWidth={1.8} />} title="关联资产" count={assets.length}
        action={canManage ? <button className="btn" onClick={onAdd} style={{ gap: 6 }}><Plus size={14} strokeWidth={2} /> 添加资产</button> : undefined} />
      {assets.length === 0 ? (
        <div className="empty" style={{ padding: '24px 0' }}>
          <Server size={28} style={{ color: 'var(--meta)', marginBottom: 6 }} strokeWidth={1.5} />
          <div>暂无关联资产</div>
          <div className="hint">{canManage ? '点击"添加资产"关联已有资产' : '该分组暂无你可见的资产'}</div>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <RowGrid cols="1fr 140px 90px" header={['资产', '类型', '操作']} />
          <VirtualRows count={assets.length} rowHeight={44}>
            {(i) => {
              const a = assets[i]!;
              return (
                <div style={{ ...rowGridStyle('1fr 140px 90px'), height: 44, borderBottom: '1px solid var(--border-soft)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span className="mono" style={{ fontSize: 13, color: 'var(--accent)', cursor: 'pointer', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      onClick={() => onOpen(a.id)} title="查看资产详情">
                      {a.name}
                    </span>
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{a.category}</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    {canManage && <RemoveBtn onClick={() => onRemove(a.id, a.name)} label={`移除资产 ${a.name}`} />}
                  </div>
                </div>
              );
            }}
          </VirtualRows>
        </div>
      )}
    </div>
  );
}

function MemberSection({
  members, onAdd, onRemove,
}: {
  members: GroupDetail['members'];
  onAdd: () => void;
  onRemove: (id: string, name: string) => void;
}) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <SectionHeader icon={<Users2 size={15} strokeWidth={1.8} />} title="授权成员" count={members.length}
        action={<button className="btn" onClick={onAdd} style={{ gap: 6 }}><Plus size={14} strokeWidth={2} /> 添加成员</button>} />
      {members.length === 0 ? (
        <div className="empty" style={{ padding: '24px 0' }}>
          <Users2 size={28} style={{ color: 'var(--meta)', marginBottom: 6 }} strokeWidth={1.5} />
          <div>暂无授权成员</div>
          <div className="hint">点击"添加成员"授权用户访问该组</div>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <RowGrid cols="1fr 90px" header={['成员', '操作']} />
          <VirtualRows count={members.length} rowHeight={44}>
            {(i) => {
              const m = members[i]!;
              return (
                <div style={{ ...rowGridStyle('1fr 90px'), height: 44, borderBottom: '1px solid var(--border-soft)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>{m.username}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <RemoveBtn onClick={() => onRemove(m.id, m.username)} label={`移除成员 ${m.username}`} />
                  </div>
                </div>
              );
            }}
          </VirtualRows>
        </div>
      )}
    </div>
  );
}

/* ---------- 弹窗 ---------- */

function KvModal({
  groupId, existing, onClose, onSaved,
}: {
  groupId: string; existing: string[]; onClose: () => void; onSaved: () => void;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/api/v1/groups/${groupId}/metadata`, {
      method: 'PUT',
      body: JSON.stringify({ items: [{ key, value }] }),
    }),
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : '保存失败'),
  });
  const dup = key.length > 0 && existing.includes(key);

  return (
    <Modal title="添加元信息" onClose={onClose}>
      <label style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>键</label>
      <input className="input mono" autoFocus placeholder="如 env / region / tier" value={key}
        onChange={(e) => { setKey(e.target.value); setErr(''); }} />
      {dup && <div style={{ color: 'var(--warn)', fontSize: 'var(--text-xs)' }}>该键已存在，保存将覆盖原值</div>}
      <label style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>值</label>
      <input className="input mono" placeholder="值" value={value}
        onChange={(e) => { setValue(e.target.value); setErr(''); }} />
      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!key || save.isPending}
          onClick={() => save.mutate()}>保存</button>
      </div>
    </Modal>
  );
}

function AssetPickerModal({
  groupId, bound, onClose, onSaved,
}: {
  groupId: string; bound: string[]; onClose: () => void; onSaved: () => void;
}) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const q = useQuery({
    queryKey: ['group-picker-assets', search],
    queryFn: async () => {
      const out: ServerItem[] = [];
      let page = 1;
      for (;;) {
        const r = await api<{ items: ServerItem[]; total: number }>(`/api/v1/servers?page=${page}&search=${encodeURIComponent(search)}`);
        out.push(...r.items);
        if (out.length >= r.total || r.items.length === 0) break;
        page += 1;
      }
      return out;
    },
  });
  const save = useMutation({
    mutationFn: () => api(`/api/v1/groups/${groupId}/servers`, {
      method: 'POST', body: JSON.stringify({ serverIds: picked }),
    }),
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : '添加失败'),
  });
  const available = (q.data ?? []).filter((s) => !bound.includes(s.id));

  return (
    <Modal title="添加关联资产" onClose={onClose} width={620}>
      <div style={{ position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--meta)' }} strokeWidth={1.8} />
        <input className="input" placeholder="搜索资产名…" style={{ paddingLeft: 30 }} value={search}
          onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        {q.isLoading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
            <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        ) : available.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>没有可添加的资产</div>
        ) : (
          available.map((s) => (
            <label key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
              borderBottom: '1px solid var(--border-soft)', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={picked.includes(s.id)}
                onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))} />
              {/* 主行显示真实资产名；displayName 若与 name 不同（如从 Market 创建时带入的条目标题）
                  作为次要说明——否则两条不同机器都显示成同一个模板名，无法区分。 */}
              <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 1 }}>
                <span className="mono" style={{ fontSize: 13, fontWeight: 550, wordBreak: 'break-all' }}>{s.name}</span>
                {s.displayName && s.displayName !== s.name && (
                  <span style={{ fontSize: 12, color: 'var(--meta)', wordBreak: 'break-all' }}>{s.displayName}</span>
                )}
              </span>
              <span className="tag">{s.category}</span>
            </label>
          ))
        )}
      </div>
      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>已选 {picked.length} 项</span>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={picked.length === 0 || save.isPending} onClick={() => save.mutate()}>
          确认添加
        </button>
      </div>
    </Modal>
  );
}

function MemberPickerModal({
  groupId, bound, onClose, onSaved,
}: {
  groupId: string; bound: string[]; onClose: () => void; onSaved: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<UserItem[]>('/api/v1/users') });
  const save = useMutation({
    mutationFn: () => api(`/api/v1/groups/${groupId}/users`, {
      method: 'POST', body: JSON.stringify({ userIds: picked }),
    }),
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : '添加失败'),
  });
  const available = (q.data ?? []).filter((u) => !bound.includes(u.id));

  return (
    <Modal title="添加授权成员" onClose={onClose} width={520}>
      <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        {q.isLoading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
            <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        ) : available.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>没有可添加的成员</div>
        ) : (
          available.map((u) => (
            <label key={u.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
              borderBottom: '1px solid var(--border-soft)', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={picked.includes(u.id)}
                onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, u.id] : prev.filter((x) => x !== u.id)))} />
              <span className="mono" style={{ fontSize: 13, flex: 1 }}>{u.username}</span>
              {u.isAdmin && <span className="badge-success">管理员</span>}
            </label>
          ))
        )}
      </div>
      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>已选 {picked.length} 项</span>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={picked.length === 0 || save.isPending} onClick={() => save.mutate()}>
          确认添加
        </button>
      </div>
    </Modal>
  );
}

/* ---------- 基础件 ---------- */

function Loading() {
  return (
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
}

function SectionHeader({
  icon, title, count, action,
}: {
  icon: ReactNode; title: string; count?: number; action?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{
        width: 26, height: 26, borderRadius: 7, background: 'var(--accent-soft)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)',
      }}>{icon}</span>
      <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{title}</span>
      {count !== undefined && <span className="tag">{count}</span>}
      <span style={{ flex: 1 }} />
      {action}
    </div>
  );
}

function RowGrid({ cols, header }: { cols: string; header: string[] }) {
  return (
    <div style={{ ...rowGridStyle(cols), padding: '8px 12px', background: 'var(--surface-raise)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md) var(--radius-md) 0 0' }}>
      {header.map((h) => (
        <div key={h} style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)', fontWeight: 550 }}>{h}</div>
      ))}
    </div>
  );
}

function rowGridStyle(cols: string): React.CSSProperties {
  return { display: 'grid', gridTemplateColumns: cols, alignItems: 'center', padding: '0 12px', boxSizing: 'border-box' };
}

function RemoveBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="btn" title={label} aria-label={label} onClick={onClick}
      style={{ padding: '4px 7px', minHeight: 26, border: 'none', background: 'transparent', color: 'var(--muted)' }}>
      <Trash2 size={13} strokeWidth={1.8} />
    </button>
  );
}

/** 二次确认弹窗：破坏性操作统一走这里（资产/成员/元信息移除）。 */
function ConfirmDialog({
  title, message, confirmLabel, onConfirm, onCancel,
}: {
  title: string; message: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div style={{ color: 'var(--danger)', lineHeight: 1.6 }}>{message}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel}>取消</button>
        <button className="btn btn-danger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

/** 虚拟滚动列表容器：只渲染可视区域的行。外层壳负责边框，内层不设边框（避免 1px 溢出导致滚动条常驻）。 */
function VirtualRows({
  count, rowHeight, children,
}: {
  count: number; rowHeight: number; children: (index: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => ref.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  const maxH = Math.min(count, 10) * rowHeight;
  return (
    <div style={{
      border: '1px solid var(--border)', borderTop: 'none',
      borderRadius: '0 0 var(--radius-md) var(--radius-md)', overflow: 'hidden',
    }}>
      <div ref={ref} style={{ height: maxH, overflowY: 'auto' }}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => (
            <div key={vi.key} style={{
              position: 'absolute', top: 0, left: 0, width: '100%',
              height: vi.size, transform: `translateY(${vi.start}px)`,
            }}>
              {children(vi.index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
