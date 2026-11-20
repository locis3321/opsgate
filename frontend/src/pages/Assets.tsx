import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, ChevronLeft, ChevronRight, Server, Upload, Power, Trash2, Globe, ShieldOff, X, RefreshCw, Fingerprint, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../api';
import AssetCreateModal from '../components/AssetCreateModal';
import ImportMcpServersModal from '../components/ImportMcpServersModal';
import Combobox, { type ComboOption } from '../components/Combobox';
import StatusBadge from '../components/StatusBadge';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

/** 筛选下拉的"全部"项（value 为空表示不过滤） */
const PROTO_ALL: ComboOption = { value: '', label: '全部协议' };
const CAT_ALL: ComboOption = { value: '', label: '全部品类' };
const EXEC_ALL: ComboOption = { value: '', label: '执行模式全部' };
const STATUS_ALL: ComboOption = { value: '', label: '状态全部' };
const VIS_ALL: ComboOption = { value: '', label: '可见范围全部' };

/** 枚举中文标签（技术值保留原样，运维需与配置/日志对照） */
const TYPE_LABEL: Record<string, string> = { stdio: '本地进程', http: 'HTTP 服务', sse: 'SSE 服务', native: '原生直连' };
const EXEC_LABEL: Record<string, string> = { native: '原生执行', mcp: 'MCP 实例' };
const CATEGORY_LABEL: Record<string, string> = { host: '主机', mysql: 'MySQL', k8s: 'K8s', other: '其他', zabbix: 'Zabbix', rocketmq: 'RocketMQ', nacos: 'Nacos', mq: '消息队列', baota: '宝塔面板', monitor: '监控', elasticsearch: 'Elasticsearch' };

/** 技术值 + 中文说明（mono 保留原值，便于对照配置） */
function EnumTag({ value, labels }: { value: string; labels: Record<string, string> }) {
  return (
    <span className="tag" title={value}>
      {labels[value] ?? value}
      {labels[value] && <span className="mono" style={{ marginLeft: 5, opacity: 0.65 }}>{value}</span>}
    </span>
  );
}

/** 可见范围：图标+文字双通道；public 走琥珀警示（Spec §8.6 V1/V2） */
function VisibilityBadge({ value }: { value: string }) {
  if (value === 'public') return <StatusBadge kind="warn" label="公开" title="所有成员可见并可调用" />;
  if (value === 'group') return <StatusBadge kind="success" label="分组共享" title="所在分组成员可见并可调用" />;
  return <StatusBadge kind="info" label="仅归属人" title="仅创建者本人可见" />;
}

interface Asset {
  id: string; name: string; displayName: string | null; type: string; category: string;
  executionMode: 'native' | 'mcp'; visibility: string; enabled: boolean; tags: string[];
}

/** 批量信任指纹的结果分类（服务端口径：skipped = 非目标类型，failed = 真失败） */
interface TrustBatchResult {
  succeeded: Array<{ id: string; name: string; fingerprint: string }>;
  failed: Array<{ id: string; name: string; reason: string }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
}
interface SlotAgg { total: number; missing: number }

/** 槽位状态徽章：由批量端点返回的聚合状态渲染（T7 去 N+1，不再每行请求 /slots）
 *  未绑槽位不再代表"不可用"，只提示还剩几个没配置（2026-11-17 取消必填拦截）。 */
function CredState({ agg }: { agg: SlotAgg | undefined }) {
  if (!agg) return <span style={{ color: 'var(--meta)' }}>…</span>;
  if (agg.total === 0) return <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>无需认证</span>;
  if (agg.missing === 0) return <StatusBadge kind="success" label="已绑定" />;
  return <StatusBadge kind="warn" label={`未绑 ${agg.missing}/${agg.total}`} />;
}

/** 资产列表（§8.5）：平铺 + 分页 50/页 + 筛选 + 搜索；协议（type）与品类（category）分列。 */
export default function Assets() {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [type, setType] = useState('');
  const [exec, setExec] = useState('');
  const [enabled, setEnabled] = useState('');
  const [tag, setTag] = useState('');
  const [visibility, setVisibility] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  /** 勾选的资产 id（翻页/改筛选后清空，避免对不可见行执行操作） */
  const [selected, setSelected] = useState<string[]>([]);
  /** 批量删除二次确认 */
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);

  // 搜索防抖 300ms（T7）：输入只更新 searchInput，稳定后才触发列表请求
  useEffect(() => {
    const t = window.setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const q = useQuery({
    queryKey: ['assets', page, search, cat, type, exec, enabled, tag, visibility],
    queryFn: () => api<{ items: Asset[]; total: number }>(
      `/api/v1/servers?page=${page}&search=${encodeURIComponent(search)}` +
      (cat ? `&category=${cat}` : '') + (type ? `&type=${type}` : '') + (exec ? `&executionMode=${exec}` : '') +
      (enabled ? `&enabled=${enabled}` : '') + (visibility ? `&visibility=${visibility}` : '') +
      (tag ? `&tag=${encodeURIComponent(tag)}` : ''),
    ),
  });

  const items = q.data?.items ?? [];
  /** 品类筛选项从当页数据派生（加上当前选中的值，避免翻页后选中项消失） */
  const categories = useMemo(() => {
    const set = new Set(items.map((a) => a.category).filter(Boolean));
    if (cat) set.add(cat);
    return [...set].sort();
  }, [items, cat]);

  /** 当页槽位状态（一次批量请求，替代每行 /slots 的 N+1） */
  const slotStatus = useQuery({
    queryKey: ['slot-status', items.map((a) => a.id).join(',')],
    queryFn: () => api<Record<string, SlotAgg>>(`/api/v1/servers/slot-status?ids=${items.map((a) => a.id).join(',')}`),
    enabled: items.length > 0,
    staleTime: 30_000,
  });

  // 换页/改筛选后清空勾选：勾选的语义是"当前列表里可见的行"，跨页保留会误伤看不到的资产
  useEffect(() => {
    setSelected([]);
    setConfirmBatchDelete(false);
  }, [page, search, cat, type, exec, enabled, tag, visibility]);

  const totalPages = Math.ceil((q.data?.total ?? 0) / 50);

  /** 单个资产启停（行内开关）：停用即从 MCP tools/list 移除，实例立即回收 */
  const toggleEnabled = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api(`/api/v1/servers/${v.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: v.enabled }) }),
    onSuccess: (_d, v) => {
      toast.success(v.enabled ? '资产已启用' : '资产已停用');
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '操作失败'),
  });

  /** 批量操作：逐条由后端校验权限，返回成功/失败明细（前端如实展示，不吞失败） */
  const batch = useMutation({
    mutationFn: (v: { action: string }) =>
      api<{ action: string; succeeded: string[]; failed: Array<{ id: string; reason: string }> }>(
        '/api/v1/servers/batch',
        { method: 'POST', body: JSON.stringify({ ids: selected, action: v.action }) },
      ),
    onSuccess: (d) => {
      const n = d.succeeded.length;
      if (d.failed.length === 0) {
        toast.success(`已处理 ${n} 个资产`);
      } else {
        toast.error(`成功 ${n} 个，失败 ${d.failed.length} 个：${d.failed.map((f) => f.reason).join('；')}`);
      }
      setSelected([]);
      setConfirmBatchDelete(false);
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '批量操作失败'),
  });

  const pageIds = useMemo(() => items.map((a) => a.id), [items]);
  const allChecked = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const toggleRow = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleAll = () => setSelected(allChecked ? [] : pageIds);

  /** 所选资产里可信任指纹的台数（原生 host）；为 0 时禁用批量信任按钮 */
  const trustableCount = useMemo(
    () => items.filter((a) => selected.includes(a.id) && a.category === 'host' && a.executionMode === 'native').length,
    [items, selected],
  );
  /** 批量信任结果（完成后弹窗展示失败项的主机名与 id） */
  const [trustResult, setTrustResult] = useState<TrustBatchResult | null>(null);
  const trustBatch = useMutation({
    mutationFn: () =>
      api<TrustBatchResult>('/api/v1/servers/ssh/trust-fingerprint-batch', {
        method: 'POST',
        body: JSON.stringify({ ids: selected }),
      }),
    onSuccess: (d) => {
      setTrustResult(d);
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '批量信任失败'),
  });

  return (
    <div className="page animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, marginBottom: 4 }}>资产</h1>
          <p style={{ color: 'var(--muted)', margin: 0, fontSize: 'var(--text-sm)' }}>管理主机、数据库、K8s 等运维资产及其凭证绑定</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            onClick={() => { void q.refetch(); void slotStatus.refetch(); }}
            disabled={q.isFetching}
            title="重新拉取列表与凭证状态"
          >
            <RefreshCw size={15} strokeWidth={1.8} className={q.isFetching ? 'spin' : ''} /> 刷新
          </button>
          <button className="btn" onClick={() => setShowImport(true)} title="粘贴标准 mcpServers JSON 批量创建">
            < Upload size={15} strokeWidth={2} /> 批量导入
          </button>
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            <Plus size={15} strokeWidth={2} /> 新建资产
          </button>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', padding: 16,
        background: 'var(--surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--meta)', pointerEvents: 'none' }} strokeWidth={1.8} />
          <input className="input" style={{ paddingLeft: 34 }} placeholder="搜索名称/显示名" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
        <input className="input" style={{ maxWidth: 120 }} placeholder="标签" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }} />
        <div style={{ minWidth: 130 }}><Combobox
          ariaLabel="协议筛选"
          value={type}
          onChange={(v) => { setType(v); setPage(1); }}
          placeholder="全部协议"
          options={[PROTO_ALL, { value: 'stdio', label: 'stdio' }, { value: 'http', label: 'http' }, { value: 'sse', label: 'sse' }, { value: 'native', label: 'native' }]}
        /></div>
        <div style={{ minWidth: 130 }}><Combobox
          ariaLabel="品类筛选"
          value={cat}
          onChange={(v) => { setCat(v); setPage(1); }}
          placeholder="全部品类"
          // 品类是条目自定义字符串（market.categories[0]）：选项从现有资产派生，
          // 新增品类无需改前端（写死枚举时每加一类都会出现「筛选里没有」的缺口）。
          options={[CAT_ALL, ...categories.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))]}
        /></div>
        <div style={{ minWidth: 140 }}><Combobox
          ariaLabel="执行模式筛选"
          value={exec}
          onChange={(v) => { setExec(v); setPage(1); }}
          placeholder="执行模式全部"
          options={[EXEC_ALL, { value: 'native', label: 'native' }, { value: 'mcp', label: 'mcp' }]}
        /></div>
        <div style={{ minWidth: 130 }}><Combobox
          ariaLabel="状态筛选"
          value={enabled}
          onChange={(v) => { setEnabled(v); setPage(1); }}
          placeholder="状态全部"
          options={[STATUS_ALL, { value: 'true', label: '启用' }, { value: 'false', label: '停用' }]}
        /></div>
        <div style={{ minWidth: 150 }}><Combobox
          ariaLabel="可见范围筛选"
          value={visibility}
          onChange={(v) => { setVisibility(v); setPage(1); }}
          placeholder="可见范围全部"
          options={[VIS_ALL, { value: 'owner', label: '仅归属人' }, { value: 'group', label: '分组共享' }, { value: 'public', label: '公开' }]}
        /></div>
      </div>

      {selected.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px',
          background: 'var(--accent-soft)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 550 }}>已选 {selected.length} 项</span>
          <button className="btn" style={{ gap: 5, minHeight: 30 }} onClick={() => batch.mutate({ action: 'disable' })} disabled={batch.isPending}>
            <Power size={13} strokeWidth={2} /> 停用
          </button>
          <button className="btn" style={{ gap: 5, minHeight: 30 }} onClick={() => batch.mutate({ action: 'enable' })} disabled={batch.isPending}>
            <Power size={13} strokeWidth={2} /> 启用
          </button>
          <button className="btn" style={{ gap: 5, minHeight: 30 }} onClick={() => batch.mutate({ action: 'allow-private-network' })} disabled={batch.isPending}>
            <Globe size={13} strokeWidth={2} /> 允许私网访问
          </button>
          <button className="btn" style={{ gap: 5, minHeight: 30 }} onClick={() => batch.mutate({ action: 'deny-private-network' })} disabled={batch.isPending}>
            <ShieldOff size={13} strokeWidth={2} /> 禁止私网访问
          </button>
          <button
            className="btn"
            style={{ gap: 5, minHeight: 30 }}
            onClick={() => trustBatch.mutate()}
            disabled={batch.isPending || trustBatch.isPending || trustableCount === 0}
            title={trustableCount === 0 ? '所选资产里没有可信任指纹的原生主机' : `对所选 ${trustableCount} 台原生主机采集并信任 SSH 指纹`}
          >
            <Fingerprint size={13} strokeWidth={2} /> {trustBatch.isPending ? '信任中…' : `信任指纹${trustableCount > 0 ? `（${trustableCount}）` : ''}`}
          </button>
          <button className="btn btn-danger" style={{ gap: 5, minHeight: 30 }} onClick={() => setConfirmBatchDelete(true)} disabled={batch.isPending}>
            <Trash2 size={13} strokeWidth={2} /> 删除
          </button>
          <button className="btn" style={{ gap: 4, minHeight: 30, marginLeft: 'auto' }} onClick={() => { setSelected([]); setConfirmBatchDelete(false); }}>
            <X size={12} strokeWidth={2} /> 取消选择
          </button>

          {confirmBatchDelete && (
            <div style={{
              flexBasis: '100%', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
              padding: '10px 12px', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-md)',
            }} role="alertdialog" aria-label="确认批量删除">
              <span style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                确认删除选中的 {selected.length} 个资产？凭证绑定与分组归属将一并删除，且不可恢复。
              </span>
              <button className="btn btn-danger" onClick={() => batch.mutate({ action: 'delete' })} disabled={batch.isPending}>确认删除</button>
              <button className="btn" onClick={() => setConfirmBatchDelete(false)}>取消</button>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ overflow: 'auto' }}>
        {items.length === 0 ? (
          <div className="empty" style={{ border: 'none', borderRadius: 0 }}>
            <Server size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
            <div>暂无资产</div>
            <div className="hint">点击“新建资产”创建第一个 —— 可从 Market 目录一键添加，也可自定义 MCP 协议</div>
          </div>
        ) : (
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label="全选本页"
                    checked={allChecked}
                    onChange={toggleAll}
                  />
                </th>
                <th>名称</th><th>显示名</th><th>协议</th><th>品类</th><th>执行模式</th><th>可见范围</th><th>标签</th><th>凭证</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/assets/${a.id}`)}>
                  {/* 勾选列：阻止冒泡，避免点复选框时跳转详情 */}
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${a.name}`}
                      checked={selected.includes(a.id)}
                      onChange={() => toggleRow(a.id)}
                    />
                  </td>
                  <td className="mono" style={{ fontWeight: 550 }}>{a.name}</td>
                  <td style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.displayName ?? undefined}>
                    {a.displayName || '—'}
                  </td>
                  <td><EnumTag value={a.type} labels={TYPE_LABEL} /></td>
                  <td style={{ fontSize: 'var(--text-sm)' }}>{CATEGORY_LABEL[a.category] ?? a.category}</td>
                  <td><EnumTag value={a.executionMode} labels={EXEC_LABEL} /></td>
                  <td><VisibilityBadge value={a.visibility} /></td>
                  <td>{(a.tags ?? []).map((t) => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>)}</td>
                  <td><CredState agg={slotStatus.data?.[a.id]} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {a.enabled
                        ? <StatusBadge kind="success" label="启用" />
                        : <StatusBadge kind="disabled" label="停用" />}
                      <button
                        className="btn"
                        style={{ padding: '2px 8px', minHeight: 26, fontSize: 'var(--text-xs)', gap: 4 }}
                        onClick={() => toggleEnabled.mutate({ id: a.id, enabled: !a.enabled })}
                        disabled={toggleEnabled.isPending}
                        title={a.enabled ? '停用：该资产的工具立即从 MCP tools/list 移除' : '启用：恢复工具暴露'}
                        aria-label={`${a.enabled ? '停用' : '启用'}资产 ${a.name}`}
                      >
                        <Power size={12} strokeWidth={2} /> {a.enabled ? '停用' : '启用'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
        <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          <ChevronLeft size={14} /> 上一页
        </button>
        <span className="mono" style={{ fontSize: 'var(--text-sm)', padding: '0 8px' }}>
          {page} / {totalPages || 1}（{q.data?.total ?? 0} 项）
        </span>
        <button className="btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
          下一页 <ChevronRight size={14} />
        </button>
      </div>

      {showForm && (
        <AssetCreateModal
          onClose={() => setShowForm(false)}
          onCreated={(id) => { setShowForm(false); nav(`/assets/${id}`); }}
        />
      )}

      {showImport && (
        <ImportMcpServersModal
          onClose={() => setShowImport(false)}
          onImported={() => { void q.refetch(); }}
        />
      )}

      {trustResult && (
        <Modal title="批量信任主机指纹 · 结果" onClose={() => setTrustResult(null)} width={720}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <StatusBadge kind="success" label={`成功 ${trustResult.succeeded.length}`} />
            <StatusBadge kind="error" label={`失败 ${trustResult.failed.length}`} />
            <StatusBadge kind="warn" label={`跳过 ${trustResult.skipped.length}`} />
          </div>

          {trustResult.succeeded.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ color: 'var(--fg-2)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>已信任</div>
              {trustResult.succeeded.map((s) => (
                <div key={s.id} className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {s.name} <span style={{ color: 'var(--accent)' }}>{s.fingerprint.slice(0, 24)}…</span>
                </div>
              ))}
            </div>
          )}

          {trustResult.failed.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--danger)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                <AlertTriangle size={14} strokeWidth={2} /> 失败（{trustResult.failed.length}）
              </div>
              <div style={{
                display: 'grid', gap: 6, maxHeight: 240, overflowY: 'auto', padding: '8px 10px',
                border: '1px solid var(--danger)', borderRadius: 'var(--r-md)', background: 'var(--danger-soft)',
              }}>
                {trustResult.failed.map((f) => (
                  <div key={f.id} style={{ display: 'grid', gap: 1 }}>
                    <span className="mono" style={{ fontSize: 13, fontWeight: 550 }}>{f.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{f.id}</span>
                    <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{f.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {trustResult.skipped.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ color: 'var(--warn)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>跳过（{trustResult.skipped.length}）</div>
              <div style={{ maxHeight: 180, overflowY: 'auto', display: 'grid', gap: 3 }}>
                {trustResult.skipped.map((s) => (
                  <div key={s.id} style={{ fontSize: 12, color: 'var(--muted)' }}>
                    <span className="mono" style={{ color: 'var(--fg-2)' }}>{s.name}</span>
                    <span className="mono" style={{ marginLeft: 8, opacity: 0.7 }}>{s.id}</span>
                    <div style={{ color: 'var(--meta)' }}>{s.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={() => setTrustResult(null)}>关闭</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
