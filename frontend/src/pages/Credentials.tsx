import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, KeyRound, Trash2, Eye, EyeOff, RefreshCw, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, ApiError, fmtTs } from '../api';
import Modal from '../components/Modal';
import Combobox from '../components/Combobox';

/** 列表每页条数（用户要求 20） */
const PAGE_SIZE = 20;

interface Cred {
  id: string; name: string; kind: string; valueHint: string; ownerId: string; ownerName?: string; createdAt: number | null;
  /** ADR-028：权限等级标签（仅展示，不参与授权） */
  privileges?: string[];
  boundServers?: number; actualUsers?: number; usageWarning?: string | null;
}

const PRIV_OPTIONS: Array<{ key: string; label: string; color: string; bg: string }> = [
  { key: 'root', label: 'root', color: 'var(--danger)', bg: 'var(--danger-soft)' },
  { key: 'rw', label: '读写', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  { key: 'wo', label: '只写', color: 'var(--warn)', bg: 'var(--warn-soft)' },
  { key: 'ro', label: '只读', color: 'var(--muted)', bg: 'var(--surface-raise)' },
];

function PrivBadges({ privileges }: { privileges?: string[] }) {
  if (!privileges || privileges.length === 0) return <span style={{ color: 'var(--meta)', fontSize: 12 }}>—</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {privileges.map((p) => {
        const m = PRIV_OPTIONS.find((o) => o.key === p) ?? { label: p, color: 'var(--muted)', bg: 'var(--surface-raise)' };
        return (
          <span key={p} style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, color: m.color, background: m.bg, fontWeight: 600 }}>
            {m.label}
          </span>
        );
      })}
    </span>
  );
}

interface TypeField {
  key: string; label: string; placeholder?: string; textarea?: boolean; optional?: boolean; hint?: string; secret?: boolean;
}
interface CredType {
  kind: string; label: string; description: string; fields: TypeField[]; keys?: string[];
}

/**
 * 凭证类型从后端字典读取（T5 数据驱动）：`GET /credentials/types`。
 * 新增形态只改后端 `src/config/constants.ts` 的 CREDENTIAL_TYPES，前端零改动。
 * 拉取失败时回退到最小可用集合（保证创建入口不塌）。
 */
const FALLBACK_TYPES: CredType[] = [
  { kind: 'env-values', label: '自定义键值对（JSON）', description: '任意命名值集合', fields: [] },
];

/** 凭证（创建者私有，可按分组共享给成员使用，ADR-028；按类型弹窗表单——用户偏好"单按钮+弹窗"，勿改回平铺）。 */
export default function Credentials() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['credentials'], queryFn: () => api<Cred[]>('/api/v1/credentials') });
  // 类型字典来自后端（T5）：拉取失败回退最小集合，不让创建入口塌
  const typesQ = useQuery({
    queryKey: ['credential-types'],
    queryFn: () => api<CredType[]>('/api/v1/credentials/types'),
    staleTime: 5 * 60_000,
  });
  const CRED_TYPES = typesQ.data && typesQ.data.length > 0 ? typesQ.data : FALLBACK_TYPES;
  const KIND_LABELS = new Map(CRED_TYPES.map((t) => [t.kind, t.label] as const));
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('user_password');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [customJson, setCustomJson] = useState('');
  const [err, setErr] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<Array<{ key: string; value: string }>>([]);
  const [privileges, setPrivileges] = useState<string[]>([]);
  /** 敏感字段明/密文切换（默认密文，仅当次会话记忆） */
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/v1/credentials/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['credentials'] }); setConfirming(null); },
  });

  // 搜索防抖 300ms：输入只更新 searchInput，稳定后才过滤（与资产页同节奏）
  useEffect(() => {
    const t = window.setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const all = q.data ?? [];
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return all;
    return all.filter((c) =>
      c.name.toLowerCase().includes(kw) ||
      (c.ownerName ?? c.ownerId).toLowerCase().includes(kw) ||
      c.kind.toLowerCase().includes(kw),
    );
  }, [all, search]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);
  // 删除后当前页可能越界：跟随总数收敛，避免停留在空白页
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  const cur = CRED_TYPES.find((t) => t.kind === kind)!;
  const create = useMutation({
    mutationFn: () => {
      let values: Record<string, string>;
      if (kind === 'env-values') {
        const parsed: unknown = JSON.parse(customJson || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('自定义值需要 JSON 对象');
        values = parsed as Record<string, string>;
      } else {
        values = {};
        for (const f of cur.fields) {
          const v = (vals[f.key] ?? '').trim();
          if (!v && !f.optional) throw new Error(`${f.label} 必填`);
          if (v) values[f.key] = v;
        }
        for (const cf of customFields) {
          const k = cf.key.trim();
          const v = cf.value.trim();
          if (k && v) values[k] = v;
        }
      }
      if (Object.keys(values).length === 0) throw new Error('至少一个值');
      return api('/api/v1/credentials', { method: 'POST', body: JSON.stringify({ name, kind, values, privileges }) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credentials'] });
      setOpen(false);
      setName(''); setVals({}); setCustomJson(''); setErr(''); setCustomFields([]); setPrivileges([]);
    },
  });

  return (
    <div className="page animate-slide-up">
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, flexShrink: 0 }}>凭证</h1>
          <span style={{ flex: 1 }} />
          <div style={{ position: 'relative', flex: '0 1 280px', minWidth: 160 }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--meta)', pointerEvents: 'none' }} strokeWidth={1.8} />
            <input
              className="input"
              style={{ paddingLeft: 34 }}
              placeholder="搜索名称 / 归属人 / 类型"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="搜索凭证"
            />
          </div>
          <button className="btn" onClick={() => { void q.refetch(); }} disabled={q.isFetching} title="重新拉取凭证列表">
            <RefreshCw size={14} strokeWidth={1.8} className={q.isFetching ? 'spin' : ''} /> 刷新
          </button>
          <button className="btn btn-primary" onClick={() => { setOpen(true); setErr(''); }}>
            <Plus size={14} strokeWidth={2} /> 新建凭证
          </button>
        </div>
        <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
          管理运维凭证：归属人可修改与按分组共享，成员可使用共享凭证但不能绑定
        </p>
      </div>
      {open && (
        <Modal title="新建凭证" onClose={() => setOpen(false)}>
          <input className="input" placeholder="凭证名（如 prod-mysql-ro）" value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>类型</label>
            <Combobox
              ariaLabel="凭证类型"
              value={kind}
              onChange={(v) => { setKind(v); setVals({}); setCustomFields([]); }}
              options={CRED_TYPES.map((t) => ({ value: t.kind, label: t.label }))}
            />
            <div style={{ color: 'var(--meta)', fontSize: 12 }}>{cur.description}</div>
          </div>
          {kind !== 'env-values' ? (
            cur.fields.map((f) => {
              const isSecret = f.secret ?? /pass|secret|token|api|key|private/i.test(f.key);
              const revealed = !!reveal[f.key];
              return (
                <div key={f.key} style={{ display: 'grid', gap: 4 }}>
                  <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
                    {f.label}{f.optional ? '（可选）' : ''}
                  </label>
                  {f.textarea
                    ? <textarea className="input" rows={4} placeholder={f.placeholder} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
                    : isSecret
                      ? (
                        <div style={{ position: 'relative' }}>
                          <input
                            className="input"
                            style={{ width: '100%', paddingRight: 36, boxSizing: 'border-box' }}
                            type={revealed ? 'text' : 'password'}
                            autoComplete="new-password"
                            placeholder={f.placeholder}
                            value={vals[f.key] ?? ''}
                            onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
                          />
                          <button
                            type="button"
                            className="icon-btn"
                            style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28 }}
                            onClick={() => setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))}
                            aria-label={revealed ? `隐藏 ${f.label}` : `显示 ${f.label}`}
                            title={revealed ? '隐藏' : '显示'}
                          >
                            {revealed ? <EyeOff size={14} strokeWidth={1.8} /> : <Eye size={14} strokeWidth={1.8} />}
                          </button>
                        </div>
                      )
                      : <input className="input" placeholder={f.placeholder} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />}
                  {f.hint && <div style={{ color: 'var(--meta)', fontSize: 12 }}>{f.hint}</div>}
                </div>
              );
            })
          ) : (
            <textarea className="input" rows={4} placeholder='{"MYSQL_PASSWORD":"…","USER":"…"}' value={customJson} onChange={(e) => setCustomJson(e.target.value)} />
          )}
          {/* ADR-028：等级标签仅作展示元信息，供 LLM/人快速判断凭证权限范围 */}
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
              权限等级（可选，仅展示不参与授权）
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {PRIV_OPTIONS.map((o) => {
                const on = privileges.includes(o.key);
                return (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => setPrivileges(on ? privileges.filter((x) => x !== o.key) : [...privileges, o.key])}
                    style={{
                      fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                      border: `1px solid ${on ? o.color : 'var(--border)'}`,
                      color: on ? o.color : 'var(--muted)',
                      background: on ? o.bg : 'transparent',
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
          {kind !== 'env-values' && (
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>自定义扩展字段</span>
                <button type="button" className="btn" style={{ fontSize: 'var(--text-xs)', gap: 4, padding: '2px 8px' }} onClick={() => setCustomFields([...customFields, { key: '', value: '' }])}>
                  <Plus size={12} strokeWidth={2} /> 添加
                </button>
              </div>
              {customFields.map((cf, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input className="input" style={{ flex: 2, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }} placeholder="键名（如 host）" value={cf.key} onChange={(e) => { const next = [...customFields]; next[i] = { ...next[i]!, key: e.target.value }; setCustomFields(next); }} />
                  <input className="input" style={{ flex: 3, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }} placeholder="值" value={cf.value} onChange={(e) => { const next = [...customFields]; next[i] = { ...next[i]!, value: e.target.value }; setCustomFields(next); }} />
                  <button type="button" className="btn" style={{ padding: '4px 8px', flexShrink: 0 }} onClick={() => setCustomFields(customFields.filter((_, j) => j !== i))}>
                    <Trash2 size={14} strokeWidth={1.8} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setOpen(false)}>取消</button>
            <button className="btn btn-primary" onClick={() => create.mutate(undefined, { onError: (e) => setErr(e instanceof ApiError ? e.message : String(e)) })}>
              创建
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
      ) : all.length === 0 ? (
        <div className="empty">
          <KeyRound size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
          <div>暂无凭证</div>
          <div className="hint">点击"新建凭证"创建；创建后可在详情页按分组共享</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <Search size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
          <div>无匹配凭证</div>
          <div className="hint">没有名称 / 归属人 / 类型匹配「{search}」的凭证</div>
        </div>
      ) : (
      <div className="card" style={{ overflow: 'auto' }}>
        <table className="dt">
          <thead><tr><th>名称</th><th>类型</th><th>等级</th><th>值提示</th><th>被引用数</th><th>实际使用者</th><th>创建时间</th><th>归属</th><th>操作</th></tr></thead>
          <tbody>
            {pageRows.map((c) => (
              <tr key={c.id}>
                <td className="mono" style={{ cursor: 'pointer' }} onClick={() => nav(`/credentials/${c.id}`)}>{c.name}</td>
                <td>{KIND_LABELS.get(c.kind) ?? c.kind}</td>
                <td><PrivBadges privileges={c.privileges} /></td>
                <td className="mono">{c.valueHint}</td>
                <td>{c.boundServers !== undefined && c.boundServers > 0 ? <span className="badge-warn">{c.boundServers}</span> : '0'}</td>
                <td>{c.actualUsers ?? '无'}</td>
                <td>{fmtTs(c.createdAt)}</td><td>{c.ownerName ?? c.ownerId.slice(0, 8)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {confirming !== c.id ? (
                    <>
                      <button className="btn" style={{ marginRight: 6 }} onClick={() => nav(`/credentials/${c.id}`)}>查看</button>
                      <button className="btn btn-danger" onClick={() => setConfirming(c.id)}>删除</button>
                    </>
                  ) : (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ color: 'var(--danger)', fontSize: 12 }}>确认删除「{c.name}」？将断开 {c.boundServers ?? 0} 个绑定资产</span>
                      <button className="btn btn-danger" onClick={() => del.mutate(c.id, { onError: (e) => setErr(e instanceof ApiError ? e.message : '删除失败') })}>确认</button>
                      <button className="btn" onClick={() => setConfirming(null)}>取消</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {filtered.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
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
      )}
    </div>
  );
}
