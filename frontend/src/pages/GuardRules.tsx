import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { api, ApiError } from '../api';
import Modal from '../components/Modal';
import Combobox from '../components/Combobox';

type Scope = 'global' | 'asset_type' | 'asset';
type Source = 'builtin' | 'admin' | 'owner';

interface Rule {
  id: string; name: string; kind: string; target: string; pattern: string;
  enabled: boolean; builtin: boolean; description: string | null;
  /** 作用域：对哪些资产生效（与 target 正交） */
  scope: Scope;
  /** scope=asset_type → 品类名；scope=asset → 资产 id；global → null */
  scopeValue: string[] | null;
  source: Source;
  /** 当前登录者能否改/停用/删除（管理员设的策略对成员为 false） */
  canManage: boolean;
  /** 优先级（数值越大越优先） */
  priority?: number;
}
interface Group { id: string; name: string; description: string | null }
interface AssetItem { id: string; name: string; displayName: string | null; category: string; ownerId: string | null }
interface Me { id: string; isAdmin: boolean }

const ASSET_TYPES = ['host', 'mysql', 'k8s', 'other', 'zabbix', 'rocketmq', 'nacos'];
/** 规则表格每页条数：规则数会随资产级策略增长（每个 owner 可给自己的资产建多条），必须分页 */
const PAGE_SIZE = 20;
/** target 是**匹配维度**（拿什么去匹配），与作用域无关 */
const TARGET_LABELS: Record<string, string> = { arg: '参数值', body: '请求体全文', tool: '工具名', group: '所属分组', asset_type: '资产类型' };
const SCOPE_LABELS: Record<Scope, string> = { global: '全局', asset_type: '指定品类', asset: '指定资产' };

/** 正则转义（分组名用于构造 ^(a|b)$） */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 安全策略（guard_rules）：作用域三级（全局 / 指定品类 / 指定资产）× 匹配维度（参数值 / 工具名 / 分组）。
 * 来源锁定：内置与管理员规则归管理员负责，成员只能管理自己创建的资产级策略。
 */
export default function GuardRules() {
  const q = useQuery({ queryKey: ['rules'], queryFn: () => api<Rule[]>('/api/v1/guard-rules') });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<Group[]>('/api/v1/groups') });
  const assets = useQuery({
    queryKey: ['rules-assets'],
    queryFn: () => api<{ items: AssetItem[] }>('/api/v1/servers?page=1&pageSize=500'),
  });
  const me = useQuery({
    queryKey: ['session-me'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { id?: string; isAdmin?: boolean } };
      return { id: j?.user?.id ?? '', isAdmin: Boolean(j?.user?.isAdmin) } as Me;
    },
    staleTime: 60_000,
  });
  const isAdmin = me.data?.isAdmin === true;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', kind: 'mark', target: 'arg', pattern: '', description: '' });
  const [scope, setScope] = useState<Scope>('global');
  const [scopeTypes, setScopeTypes] = useState<string[]>([]);
  const [scopeAssets, setScopeAssets] = useState<string[]>([]);
  const [scopeGroups, setScopeGroups] = useState<string[]>([]);
  const [assetSearch, setAssetSearch] = useState('');
  const [page, setPage] = useState(1);
  const [err, setErr] = useState('');
  const [sample, setSample] = useState('');
  const [testResult, setTestResult] = useState('');

  /** 成员只能选自己拥有的资产（服务端同样校验，这里避免选完才吃 400） */
  const selectableAssets = useMemo(() => {
    const items = assets.data?.items ?? [];
    return isAdmin ? items : items.filter((a) => a.ownerId === me.data?.id);
  }, [assets.data, isAdmin, me.data?.id]);
  const filteredAssets = useMemo(() => {
    const kw = assetSearch.trim().toLowerCase();
    if (!kw) return selectableAssets;
    return selectableAssets.filter((a) => a.name.toLowerCase().includes(kw) || (a.displayName ?? '').toLowerCase().includes(kw));
  }, [selectableAssets, assetSearch]);
  const assetName = (id: string) => {
    const hit = (assets.data?.items ?? []).find((a) => a.id === id);
    return hit ? (hit.displayName ?? hit.name) : id.slice(0, 8);
  };

  const effectivePattern = form.target === 'group'
    ? (scopeGroups.length > 0 ? `^(${scopeGroups.map(esc).join('|')})$` : '')
    : form.pattern;
  const scopeValue = scope === 'asset_type' ? scopeTypes : scope === 'asset' ? scopeAssets : [];
  const scopeValid = scope === 'global' || scopeValue.length > 0;
  const patternValid = form.target === 'group' ? scopeGroups.length > 0 : form.pattern.trim() !== '';
  const canSave = form.name.trim() !== '' && scopeValid && patternValid;

  const resetForm = () => {
    setForm({ name: '', kind: 'mark', target: 'arg', pattern: '', description: '' });
    setScope('global'); setScopeTypes([]); setScopeAssets([]); setScopeGroups([]);
    setAssetSearch(''); setErr('');
  };

  const create = useMutation({
    mutationFn: () => api('/api/v1/guard-rules', {
      method: 'POST',
      body: JSON.stringify({
        ...form,
        pattern: effectivePattern,
        scope,
        scopeValue: scope === 'global' ? null : scopeValue,
      }),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] });
      setOpen(false);
      resetForm();
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ hits: { ruleName: string } | null; customPattern: string | null }>('/api/v1/guard-rules/test', { method: 'POST', body: JSON.stringify({ sample }) }),
    onSuccess: (d) => setTestResult(d.hits ? `命中：${d.hits.ruleName}` : (d.customPattern ?? '未命中任何规则')),
  });
  const toggle = useMutation({
    mutationFn: (r: Rule) => api(`/api/v1/guard-rules/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  // 编辑现有规则：只改 name / pattern / description / priority。
  // kind（mark/block）与 scope 是规则的"形态"，改了等同换一条规则——应删除重建，故不开放编辑。
  const [editing, setEditing] = useState<Rule | null>(null);
  const [editForm, setEditForm] = useState({ name: '', pattern: '', description: '', priority: 500 });
  const [editErr, setEditErr] = useState('');
  const openEdit = (r: Rule) => {
    setEditing(r);
    setEditForm({ name: r.name, pattern: r.pattern, description: r.description ?? '', priority: r.priority ?? 500 });
    setEditErr('');
  };
  const update = useMutation({
    mutationFn: () => api(`/api/v1/guard-rules/${encodeURIComponent(editing!.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: editForm.name.trim(),
        pattern: editForm.pattern,
        description: editForm.description,
        priority: editForm.priority,
      }),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] });
      setEditing(null);
    },
    onError: (e: Error) => setEditErr(e.message),
  });
  const [confirmDel, setConfirmDel] = useState<Rule | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/v1/guard-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  const allRules = q.data ?? [];
  const totalPages = Math.max(1, Math.ceil(allRules.length / PAGE_SIZE));
  // 删除/新增后当前页可能越界：夹回最后一页，避免停在空白页
  const safePage = Math.min(page, totalPages);
  const pageRules = useMemo(
    () => allRules.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [allRules, safePage],
  );

  const scopeText = (r: Rule) => {
    const targets = r.scopeValue ?? [];
    if (r.scope === 'global') return '全局';
    if (r.scope === 'asset_type') return `品类：${targets.join('、') || '无（不生效）'}`;
    if (targets.length === 0) return '资产：无（不生效）';
    const shown = targets.slice(0, 2).map(assetName).join('、');
    return targets.length > 2 ? `资产：${shown} 等 ${targets.length} 个` : `资产：${shown}`;
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">安全策略</h1>
        <button className="btn btn-primary" onClick={() => { resetForm(); setScope(isAdmin ? 'global' : 'asset'); setOpen(true); }}>新增规则</button>
      </div>
      <div style={{ color: 'var(--meta)', fontSize: 12, lineHeight: 1.8 }}>
        <b>作用域</b>决定这条规则对哪些资产生效：<b>全局</b>对所有资产、<b>指定品类</b>对所选品类、<b>指定资产</b>只对选中的资产。
        <b>匹配维度</b>决定拿什么去比对：参数值（只看值的递归匹配）/ 请求体全文（连键名一起匹配）/ 工具名 / 所属分组。
        <br />
        <b>来源</b>决定谁能改：<b>内置</b>与<b>管理员</b>规则只能由管理员修改或关闭；成员可以为自己拥有的资产创建资产级策略并随时开关。
        所有改动都会记入审计。
      </div>
      {open && (
        <Modal title="新增安全规则" onClose={() => setOpen(false)}>
          <input className="input" placeholder="规则名（如 MySQL 写操作拦截）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Combobox
                ariaLabel="规则类型"
                value={form.kind}
                onChange={(v) => setForm({ ...form, kind: v })}
                options={[{ value: 'mark', label: '标记风险（mark）' }, { value: 'block', label: '拦截（block）' }]}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Combobox
                ariaLabel="匹配维度"
                value={form.target}
                onChange={(v) => { setForm({ ...form, target: v, pattern: '' }); setScopeGroups([]); }}
                options={[
                  { value: 'arg', label: '参数值' },
                  { value: 'body', label: '请求体全文' },
                  { value: 'tool', label: '工具名' },
                  { value: 'group', label: '所属分组' },
                ]}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>作用域（对哪些资产生效）</div>
            <div role="radiogroup" aria-label="作用域" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {(isAdmin ? (['global', 'asset_type', 'asset'] as Scope[]) : (['asset'] as Scope[])).map((s) => (
                <label key={s} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
                  <input
                    type="radio"
                    name="rule-scope"
                    checked={scope === s}
                    onChange={() => { setScope(s); setScopeTypes([]); setScopeAssets([]); }}
                  />
                  {SCOPE_LABELS[s]}
                </label>
              ))}
            </div>
            {!isAdmin && (
              <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                成员只能为自己拥有的资产创建策略；全局与品类级策略由管理员统一设置。
              </div>
            )}
          </div>

          {scope === 'asset_type' && (
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>生效品类（可多选）</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {ASSET_TYPES.map((t) => (
                  <label key={t} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={scopeTypes.includes(t)}
                      onChange={(e) => setScopeTypes(e.target.checked ? [...scopeTypes, t] : scopeTypes.filter((x) => x !== t))} />
                    {t}
                  </label>
                ))}
              </div>
            </div>
          )}

          {scope === 'asset' && (
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>生效资产（可多选）</div>
              <input className="input" placeholder="搜索资产名" value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)} />
              <div style={{ maxHeight: 160, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 8, display: 'grid', gap: 4 }}>
                {filteredAssets.length === 0 && (
                  <div style={{ color: 'var(--meta)', fontSize: 12 }}>{selectableAssets.length === 0 ? '你还没有可用的资产' : '无匹配资产'}</div>
                )}
                {filteredAssets.map((a) => (
                  <label key={a.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={scopeAssets.includes(a.id)}
                      onChange={(e) => setScopeAssets(e.target.checked ? [...scopeAssets, a.id] : scopeAssets.filter((x) => x !== a.id))} />
                    <span className="mono">{a.name}</span>
                    <span style={{ color: 'var(--meta)', fontSize: 11 }}>{a.displayName ?? ''} · {a.category}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {form.target === 'group' && (
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>匹配的分组（可多选）</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {(groups.data ?? []).map((g) => (
                  <label key={g.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={scopeGroups.includes(g.name)}
                      onChange={(e) => setScopeGroups(e.target.checked ? [...scopeGroups, g.name] : scopeGroups.filter((x) => x !== g.name))} />
                    {g.name}
                  </label>
                ))}
              </div>
              {effectivePattern && <div className="mono" style={{ color: 'var(--meta)', fontSize: 12 }}>匹配模式：{effectivePattern}</div>}
            </div>
          )}

          {(form.target === 'arg' || form.target === 'body' || form.target === 'tool') && (
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
                {form.target === 'arg'
                  ? '参数值正则（递归匹配所有参数的字符串值，不含键名）'
                  : form.target === 'body'
                    ? '请求体全文正则（JSON 序列化后匹配，含键名与值）'
                    : '工具名正则（如 native:host.execute_command）'}
              </div>
              <input className="input mono" placeholder="正则（须线性无回溯）" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
            </div>
          )}

          <input className="input" placeholder="说明（可选，给管理员看的用途）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setOpen(false)}>取消</button>
            <button
              className="btn btn-primary"
              disabled={!canSave || create.isPending}
              title={canSave ? undefined : '请填写规则名与匹配内容，并为所选作用域至少选一个目标'}
              onClick={() => create.mutate(undefined, { onError: (e) => setErr(e instanceof ApiError ? e.message : '失败') })}
            >
              {create.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </Modal>
      )}
      {isAdmin && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" placeholder="样例文本调试规则" value={sample} onChange={(e) => setSample(e.target.value)} />
            <button className="btn" onClick={() => test.mutate()}>试跑</button>
            {testResult && <span className="badge-warn">{testResult}</span>}
          </div>
        </div>
      )}
      <div className="card" style={{ overflow: 'auto' }}>
        <table className="dt">
          <thead><tr><th>名称</th><th>类型</th><th>作用域</th><th>匹配</th><th>说明</th><th>启用</th><th>来源</th><th /></tr></thead>
          <tbody>
            {pageRules.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.kind === 'block' ? <span className="badge-danger">拦截</span> : <span className="badge-warn">标记风险</span>}</td>
                <td>
                  <span className={r.scope === 'global' ? 'tag' : 'badge-warn'}>{scopeText(r)}</span>
                </td>
                <td>
                  <div style={{ color: 'var(--muted)', fontSize: 11 }}>{TARGET_LABELS[r.target] ?? r.target}</div>
                  <div className="mono" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.pattern}</div>
                </td>
                <td style={{ color: 'var(--meta)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.description || '无'}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={!r.canManage}
                    title={r.canManage ? undefined : '该策略由管理员设置，你不能修改或关闭'}
                    onChange={() => toggle.mutate(r)}
                    aria-label={`启用规则 ${r.name}`}
                  />
                </td>
                <td>
                  {r.source === 'builtin'
                    ? <span className="badge-warn" title="系统播种的安全底线规则：管理员可修改或删除，责任由管理员承担">内置</span>
                    : r.source === 'admin'
                      ? <span title="管理员设置：成员不能修改或关闭">管理员</span>
                      : <span style={{ color: 'var(--meta)' }}>成员自建</span>}
                </td>
                <td>
                  {r.canManage ? (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <button
                        className="btn"
                        style={{ padding: '2px 8px', fontSize: 12 }}
                        onClick={() => openEdit(r)}
                      >
                        编辑
                      </button>
                      <button
                        className="btn btn-danger"
                        style={{ padding: '2px 8px', fontSize: 12 }}
                        onClick={() => setConfirmDel(r)}
                      >
                        删除
                      </button>
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', color: 'var(--meta)', fontSize: 12 }} title="该策略由管理员设置，你不能删除">
                      <Lock size={12} strokeWidth={1.8} /> 不可管理
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {allRules.length === 0 && (
          <div className="empty" style={{ border: 'none', background: 'transparent' }}>
            暂无安全策略
          </div>
        )}
      </div>

      {allRules.length > PAGE_SIZE && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
          <button className="btn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
            <ChevronLeft size={14} /> 上一页
          </button>
          <span className="mono" style={{ fontSize: 'var(--text-sm)', padding: '0 8px' }}>
            {safePage} / {totalPages}（{allRules.length} 条）
          </span>
          <button className="btn" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>
            下一页 <ChevronRight size={14} />
          </button>
        </div>
      )}

      {confirmDel && (
        <Modal title="删除安全规则" onClose={() => setConfirmDel(null)}>
          <div style={{ display: 'grid', gap: 10, fontSize: 'var(--text-sm)' }}>
            <div>确认删除规则「<b>{confirmDel.name}</b>」？</div>
            {confirmDel.builtin && (
              <div style={{ color: 'var(--danger)', lineHeight: 1.7 }}>
                这是<b>系统内置的安全底线规则</b>（{confirmDel.kind === 'block' ? '拦截' : '高风险标记'}）。
                删除后平台将不再执行这条防护，若它拦截的是 SSRF / 凭据读取 / 命令注入类攻击，等于放开对应入口。
                该操作会记入审计，请确认你确实需要删除。
              </div>
            )}
            <div style={{ color: 'var(--meta)' }}>作用域：{scopeText(confirmDel)}</div>
            <div style={{ color: 'var(--meta)' }}>规则模式：<span className="mono">{confirmDel.pattern}</span></div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setConfirmDel(null)}>取消</button>
            <button
              className="btn btn-danger"
              disabled={del.isPending}
              onClick={() => del.mutate(confirmDel.id, { onSuccess: () => setConfirmDel(null) })}
            >
              {del.isPending ? '删除中…' : '确认删除'}
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title="编辑安全规则" onClose={() => setEditing(null)}>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ color: 'var(--meta)', fontSize: 12, lineHeight: 1.7 }}>
              规则「{editing.name}」 · {editing.kind === 'block' ? '拦截' : '标记风险'} · 匹配维度 {TARGET_LABELS[editing.target] ?? editing.target} · 作用域 {scopeText(editing)}
              <br />
              类型、匹配维度、作用域属规则形态，不能就地改（改动等同换一条规则）；如需调整请删除后重建。此处可改名称、正则、说明、优先级。
            </div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>规则名</span>
              <input className="input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>正则（须线性无回溯）</span>
              <input className="input mono" value={editForm.pattern} onChange={(e) => setEditForm({ ...editForm, pattern: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>说明</span>
              <input className="input" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} placeholder="可选" />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>优先级（数值越大越优先）</span>
              <input className="input mono" type="number" value={editForm.priority} onChange={(e) => setEditForm({ ...editForm, priority: Number(e.target.value) || 0 })} />
            </label>
            {editErr && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{editErr}</div>}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" disabled={update.isPending || editForm.name.trim() === '' || editForm.pattern.trim() === ''} onClick={() => update.mutate()}>
              {update.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
