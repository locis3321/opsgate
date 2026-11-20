import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderOpen, ChevronRight, RefreshCw, Search, Loader2 } from 'lucide-react';
import { api, ApiError } from '../api';
import Modal from '../components/Modal';
import Combobox, { type ComboOption } from '../components/Combobox';

interface Group { id: string; name: string; description: string | null; serverIds?: string[] }
interface ServerItem { id: string; name: string; displayName: string | null; category: string; tags?: string[]; executionMode?: string }

const CAT_ALL: ComboOption = { value: '', label: '全部品类' };
const TAG_ALL: ComboOption = { value: '', label: '全部标签' };
const CATEGORY_LABEL: Record<string, string> = {
  host: '主机', mysql: 'MySQL', k8s: 'K8s', other: '其他', zabbix: 'Zabbix', rocketmq: 'RocketMQ',
  nacos: 'Nacos', mq: '消息队列', baota: '宝塔面板', monitor: '监控', elasticsearch: 'Elasticsearch',
};

/**
 * 分组列表：新建后跳转详情页配置描述/KV/资产/成员；删除（解绑后删除）。
 * 分组是自由组织单元（ADR-026）：用于关联资产、授权成员与快速筛选，不与资产品类绑定。
 * 详情与编辑统一由 /groups/:id 子页面承载（不再用弹窗）。
 */
export default function Groups() {
  const q = useQuery({ queryKey: ['groups'], queryFn: () => api<Group[]>('/api/v1/groups') });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { isAdmin?: boolean } };
      return Boolean(j?.user?.isAdmin);
    },
  });
  /** 分组的新建/删除/成员配置都是 admin-only：成员只读浏览自己相关的分组 */
  const isAdmin = me.data === true;
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState<Group | null>(null);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['groups'] }); };
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/api/v1/groups', {
      method: 'POST',
      body: JSON.stringify({ name, description: desc, serverIds: picked }),
    }),
    onSuccess: (row) => {
      refresh();
      setOpen(false);
      setName(''); setDesc(''); setPicked([]);
      nav(`/groups/${row.id}`);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '创建失败'),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/v1/groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => { refresh(); setConfirmDel(null); },
  });

  return (
    <div className="page animate-slide-up">
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, flexShrink: 0 }}>分组</h1>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => { void q.refetch(); }} disabled={q.isFetching} title="重新拉取分组列表">
            <RefreshCw size={14} strokeWidth={1.8} className={q.isFetching ? 'spin' : ''} /> 刷新
          </button>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => { setName(''); setDesc(''); setPicked([]); setErr(''); setOpen(true); }}>
              <Plus size={14} strokeWidth={2} /> 新建分组
            </button>
          )}
        </div>
        <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
          分组用于关联资产、授权成员与快速筛选，不构成业务约束；分组说明通过 opsgate_list_groups / opsgate_view_group 提供给 LLM
        </p>
      </div>
      {open && (
        <CreateGroupModal
          name={name} desc={desc} picked={picked} err={err}
          onName={setName} onDesc={setDesc} onPicked={setPicked}
          onClose={() => setOpen(false)}
          onSubmit={() => { setErr(''); create.mutate(); }}
          submitting={create.isPending}
        />
      )}
      {q.isLoading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
          <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</span>
        </div>
      ) : (
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
          {(q.data ?? []).map((g, i) => (
            <div key={g.id} className="card animate-slide-up" style={{ padding: 'var(--space-4)', display: 'grid', gap: 8, cursor: 'pointer', animationDelay: `${i * 50}ms`, animationFillMode: 'both' }} onClick={() => nav(`/groups/${g.id}`)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: 'var(--accent-soft)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <FolderOpen size={16} style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
                  </div>
                  <div style={{ fontWeight: 600 }} className="mono">{g.name}</div>
                </div>
                <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn" style={{ padding: '5px 10px', minHeight: 30 }} onClick={() => nav(`/groups/${g.id}`)}>{isAdmin ? '管理' : '查看'}</button>
                  {isAdmin && <button className="btn btn-danger" style={{ padding: '5px 10px', minHeight: 30 }} onClick={() => setConfirmDel(g)}>删除</button>}
                </span>
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>{g.description ?? '（无说明）'}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent)', fontSize: 'var(--text-xs)' }}>
                查看详情与配置 <ChevronRight size={12} strokeWidth={2} />
              </div>
            </div>
          ))}
          {q.data && q.data.length === 0 && (
            <div className="empty" style={{ gridColumn: '1 / -1' }}>
              <FolderOpen size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
              <div>暂无分组</div>
              <div className="hint">点击"新建分组"创建</div>
            </div>
          )}
        </div>
      )}
      {confirmDel && (
        <Modal title="删除分组" onClose={() => setConfirmDel(null)}>
          <div style={{ color: 'var(--danger)' }}>
            确认删除分组「{confirmDel.name}」？（将自动解除该组下资产与成员的关联，删除后组内资产仍保留）
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setConfirmDel(null)}>取消</button>
            <button className="btn btn-danger" onClick={() => del.mutate(confirmDel.id, { onError: (e) => setErr(String(e)) })}>确认删除</button>
          </div>
        </Modal>
      )}
      {err && !open && <div style={{ color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

/**
 * 新建分组弹窗：名称 + 说明 + 按品类/标签筛选批量关联资产。
 * 筛选变化**不清空已选**：支持"先按品类勾一批、再按标签补一批"的叠加选择。
 */
function CreateGroupModal({
  name, desc, picked, err, submitting, onName, onDesc, onPicked, onClose, onSubmit,
}: {
  name: string; desc: string; picked: string[]; err: string; submitting: boolean;
  onName: (v: string) => void; onDesc: (v: string) => void; onPicked: (v: string[]) => void;
  onClose: () => void; onSubmit: () => void;
}) {
  const [cat, setCat] = useState('');
  const [tag, setTag] = useState('');
  const [search, setSearch] = useState('');

  // 候选资产：分批拉全量（接口 pageSize 上限 500），仅弹窗打开时请求
  const q = useQuery({
    queryKey: ['group-create-assets'],
    queryFn: async () => {
      const out: ServerItem[] = [];
      let page = 1;
      for (;;) {
        const r = await api<{ items: ServerItem[]; total: number }>(`/api/v1/servers?page=${page}&pageSize=500`);
        out.push(...r.items);
        if (out.length >= r.total || r.items.length === 0) break;
        page += 1;
      }
      return out;
    },
  });

  const all = q.data ?? [];
  const categories = useMemo(() => [...new Set(all.map((s) => s.category))].sort(), [all]);
  const tags = useMemo(() => [...new Set(all.flatMap((s) => s.tags ?? []))].sort(), [all]);
  const kw = search.trim().toLowerCase();
  const matched = useMemo(() => all.filter((s) =>
    (!cat || s.category === cat) &&
    (!tag || (s.tags ?? []).includes(tag)) &&
    (!kw || s.name.toLowerCase().includes(kw) || (s.displayName ?? '').toLowerCase().includes(kw)),
  ), [all, cat, tag, kw]);

  const matchedIds = matched.map((s) => s.id);
  const allMatchedPicked = matchedIds.length > 0 && matchedIds.every((id) => picked.includes(id));

  return (
    <Modal title="新建分组" onClose={onClose} width={720}>
      <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
        填写名称与说明，可直接按品类/标签批量勾选要关联的资产；创建后进入详情页可继续配置元信息与成员。
      </div>
      <input className="input" autoFocus placeholder="分组名（如 prod-db）" value={name} onChange={(e) => onName(e.target.value)} />
      <textarea className="input" rows={2} placeholder="分组说明（LLM 可见；如：生产 MySQL 实例组，禁删数据）" value={desc} onChange={(e) => onDesc(e.target.value)} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span style={{ color: 'var(--fg-2)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>关联资产</span>
        <span className="tag">已选 {picked.length} / 匹配 {matched.length}</span>
        <button
          type="button"
          className="btn"
          style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', padding: '2px 8px' }}
          disabled={matchedIds.length === 0}
          onClick={() => {
            if (allMatchedPicked) onPicked(picked.filter((id) => !matchedIds.includes(id)));
            else onPicked([...new Set([...picked, ...matchedIds])]);
          }}
        >
          {allMatchedPicked ? '取消全选匹配' : '全选匹配'}
        </button>
        {picked.length > 0 && (
          <button type="button" className="btn" style={{ fontSize: 'var(--text-xs)', padding: '2px 8px' }} onClick={() => onPicked([])}>
            清空已选
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--meta)' }} strokeWidth={1.8} />
          <input className="input" style={{ paddingLeft: 30 }} placeholder="搜索资产名…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ minWidth: 130 }}><Combobox
          ariaLabel="品类筛选"
          value={cat}
          onChange={setCat}
          placeholder="全部品类"
          options={[CAT_ALL, ...categories.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))]}
        /></div>
        <div style={{ minWidth: 130 }}><Combobox
          ariaLabel="标签筛选"
          value={tag}
          onChange={setTag}
          placeholder="全部标签"
          options={[TAG_ALL, ...tags.map((t) => ({ value: t, label: t }))]}
        /></div>
      </div>

      <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        {q.isLoading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
            <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        ) : matched.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>没有匹配的资产</div>
        ) : (
          matched.map((s) => (
            <label key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              borderBottom: '1px solid var(--border-soft)', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                onChange={(e) => onPicked(e.target.checked ? [...new Set([...picked, s.id])] : picked.filter((x) => x !== s.id))}
              />
              <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 1 }}>
                <span className="mono" style={{ fontSize: 13, fontWeight: 550, wordBreak: 'break-all' }}>{s.name}</span>
                {s.displayName && s.displayName !== s.name && (
                  <span style={{ fontSize: 12, color: 'var(--meta)', wordBreak: 'break-all' }}>{s.displayName}</span>
                )}
              </span>
              {(s.tags ?? []).map((t) => <span key={t} className="tag">{t}</span>)}
              <span className="tag">{CATEGORY_LABEL[s.category] ?? s.category}</span>
            </label>
          ))
        )}
      </div>

      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!name || submitting} onClick={onSubmit}>
          {submitting ? '创建中…' : `创建${picked.length > 0 ? `并关联 ${picked.length} 个资产` : ''}`}
        </button>
      </div>
    </Modal>
  );
}
