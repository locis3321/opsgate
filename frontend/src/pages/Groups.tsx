import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderOpen, ChevronRight, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../api';
import Modal from '../components/Modal';

interface Group { id: string; name: string; description: string | null; serverIds?: string[] }

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
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState<Group | null>(null);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['groups'] }); };
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/api/v1/groups', { method: 'POST', body: JSON.stringify({ name, description: desc }) }),
    onSuccess: (row) => {
      refresh();
      setOpen(false);
      setName(''); setDesc('');
      nav(`/groups/${row.id}`);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/v1/groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => { refresh(); setConfirmDel(null); },
  });

  return (
    <div className="page animate-slide-up">
      <div>
        <div className="page-header">
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>分组</h1>
          <button className="btn" onClick={() => { void q.refetch(); }} disabled={q.isFetching} title="重新拉取分组列表">
            <RefreshCw size={14} strokeWidth={1.8} className={q.isFetching ? 'spin' : ''} /> 刷新
          </button>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => { setName(''); setDesc(''); setErr(''); setOpen(true); }}>
              <Plus size={14} strokeWidth={2} /> 新建分组
            </button>
          )}
        </div>
        <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
          分组用于关联资产、授权成员与快速筛选，不构成业务约束；分组说明通过 opsgate_list_groups / opsgate_view_group 提供给 LLM
        </p>
      </div>
      {open && (
        <Modal title="新建分组" onClose={() => setOpen(false)}>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
            先命名并填写说明，创建后进入详情页配置元信息、关联资产与授权成员。
          </div>
          <input className="input" autoFocus placeholder="分组名（如 prod-db）" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className="input" rows={3} placeholder="分组说明（LLM 可见；如：生产 MySQL 实例组，禁删数据）" value={desc} onChange={(e) => setDesc(e.target.value)} />
          {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setOpen(false)}>取消</button>
            <button className="btn btn-primary" disabled={!name || create.isPending}
              onClick={() => create.mutate(undefined, { onError: (e) => setErr(e instanceof ApiError ? e.message : '创建失败') })}>
              创建并配置
            </button>
          </div>
        </Modal>
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
      {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}
