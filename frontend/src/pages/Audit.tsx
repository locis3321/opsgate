import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ShieldCheck, Download, AlertTriangle, Copy, RefreshCw, Trash2 } from 'lucide-react';import { api, ApiError, fmtTs } from '../api';
import Combobox from '../components/Combobox';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../components/Toast';

/** 治理类动作集合（管理后台操作；与后端 src/config/constants.ts 的 GOVERNANCE_ACTIONS 保持一致） */
const AUTH_ACTIONS = [
  'visibility_change', 'credential_bind', 'credential_unbind', 'credential_rotate', 'credential_reveal',
  'group_change', 'update_group', 'delete_group', 'set_metadata', 'delete_metadata', 'remove_member',
  'guard_rule_change', 'native_tool_toggle', 'system_setting',
  'asset_create', 'asset_prewarm', 'asset_tool_filters', 'asset_enabled_change', 'remove_asset',
];

/** 动作/状态/风险中文展示映射 */
const ACTION_LABELS: Record<string, string> = {
  tool_call: '工具调用', blocked: '规则拦截', auth_fail: '认证失败',
  system_setting: '系统设置', guard_rule_change: '规则库变更',
  visibility_change: '可见性变更', credential_bind: '凭证绑定', credential_unbind: '凭证解绑',
  credential_rotate: '凭证轮换', credential_reveal: '凭证明文查看', group_change: '分组变更',
  update_group: '分组修改', delete_group: '分组删除', set_metadata: '分组元信息设置',
  delete_metadata: '分组元信息删除', remove_member: '移除成员',
  native_tool_toggle: '原生工具开关',
  asset_create: '资产创建', asset_prewarm: '资产预热', asset_tool_filters: '资产工具过滤',
  asset_enabled_change: '资产启停', remove_asset: '资产删除',
  transfer_upload: '传输上传', transfer_landed: '传输落位', audit_archive: '审计归档',
};
const ACTION_OPTIONS = Object.entries(ACTION_LABELS).map(([v, label]) => ({ v, label }));
const STATUS_LABELS: Record<string, string> = { pending: '待处理', success: '成功', error: '失败', blocked: '已被拦截', unknown: '未知' };
/** 状态 → StatusBadge 语义（颜色+图标+文字三通道） */
const AUDIT_STATUS_KIND: Record<string, 'info' | 'success' | 'error' | 'warn' | 'disabled'> = {
  pending: 'info', success: 'success', error: 'error', blocked: 'warn', unknown: 'disabled',
};
const RISK_LABELS: Record<string, string> = { normal: '普通', high: '高风险' };

/** 每页条数（与后端 src/routes/audit.ts 的 pageSize 保持一致） */
const PAGE_SIZE = 20;

/** 治理事件的主体占位符 → 中文（资产列展示；真实资产直接用写入时快照的 server_name） */
const SUBJECT_LABELS: Record<string, string> = {
  management: '管理后台',
  groups: '分组管理',
  guard_rules: '规则库',
  settings: '系统设置',
  system_settings: '系统设置',
};

/** 审计：筛选 + 分页 + 详情展开 + 删除。 */
export default function Audit() {
  const toast = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState('');
  const [serverId, setServerId] = useState('');
  const [tool, setTool] = useState('');
  const [status, setStatus] = useState('');
  const [action, setAction] = useState('');
  const [scope, setScope] = useState('');
  const [risk, setRisk] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [authOnly, setAuthOnly] = useState(false);
  /** 详情弹窗（2026-11-18：原为行内平铺展开，撑高表格且看不清；改为独立弹窗） */
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  /** 导出确认（数据出域提示）：动作时确认，不用原生 confirm */
  const [confirmExport, setConfirmExport] = useState(false);
  /** 单条删除确认（行内） */
  const [confirmingRow, setConfirmingRow] = useState<string | null>(null);
  /** 批量删除确认（按筛选条件，显示将删行数） */
  const [confirmBulk, setConfirmBulk] = useState(false);

  // 名称化筛选：用户与资产用可搜索下拉（值用 id，展示用名称）
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { id?: string; isAdmin?: boolean } };
      return { id: j?.user?.id ?? '', isAdmin: Boolean(j?.user?.isAdmin) };
    },
  });
  const isAdmin = me.data?.isAdmin === true;
  // 成员只能看自己的审计（后端强制按 user_id 过滤），用户筛选对成员没有意义且 /users 会 403
  const usersQ = useQuery({
    queryKey: ['audit-users'],
    queryFn: () => api<Array<{ id: string; username: string }>>('/api/v1/users'),
    enabled: isAdmin,
  });
  const assetsQ = useQuery({ queryKey: ['audit-assets'], queryFn: () => api<{ items: Array<{ id: string; name: string; displayName: string | null }> }>('/api/v1/servers?page=1&pageSize=500') });

  const q = useQuery({
    queryKey: ['audit', page, userId, serverId, tool, status, action, scope, risk, from, to, authOnly],
    queryFn: () => api<{ items: Array<Record<string, unknown>>; total: number }>(
      `/api/v1/audit?page=${page}` +
      (userId ? `&userId=${encodeURIComponent(userId)}` : '') + (serverId ? `&serverId=${encodeURIComponent(serverId)}` : '') +
      (tool ? `&tool=${encodeURIComponent(tool)}` : '') + (status ? `&status=${status}` : '') +
      (risk ? `&risk=${risk}` : '') +
      (from ? `&from=${Date.parse(from)}` : '') + (to ? `&to=${Date.parse(to) + 86_400_000 - 1}` : '') +
      (scope ? `&scope=${scope}` : '') +
      (authOnly ? `&actions=${AUTH_ACTIONS.join(',')}` : (action ? `&action=${action}` : '')),
    ),
  });

  const totalPages = Math.ceil((q.data?.total ?? 0) / PAGE_SIZE);
  const rows = q.data?.items ?? [];

  /** 批量删除的筛选条件（与导出同口径；是 body 不是 query） */
  const bulkFilterBody = () => ({
    ...(userId ? { userId } : {}),
    ...(serverId ? { serverId } : {}),
    ...(tool ? { tool } : {}),
    ...(status ? { status } : {}),
    ...(risk ? { risk } : {}),
    ...(action ? { action } : {}),
    ...(from ? { from: String(Date.parse(from)) } : {}),
    ...(to ? { to: String(Date.parse(to) + 86_400_000 - 1) } : {}),
    ...(scope ? { scope } : {}),
  });
  const hasBulkFilter = Object.keys(bulkFilterBody()).length > 0;

  const del = useMutation({
    mutationFn: (id: string) => api<{ deleted: number }>(`/api/v1/audit/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (d) => {
      toast.success(`已删除 ${d.deleted} 条审计记录`);
      setConfirmingRow(null);
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '删除失败'),
  });

  const bulkDel = useMutation({
    mutationFn: () => api<{ deleted: number }>('/api/v1/audit/bulk-delete', {
      method: 'POST',
      body: JSON.stringify(bulkFilterBody()),
    }),
    onSuccess: (d) => {
      toast.success(`已按当前筛选删除 ${d.deleted} 条审计记录`);
      setConfirmBulk(false);
      setPage(1);
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '批量删除失败'),
  });

  /** 导出当前筛选结果（沿用同一查询条件，分页拉到上限）；敏感字段已在服务端脱敏为 *** */
  const exportCsv = async () => {
    const all: Array<Record<string, unknown>> = [];
    for (let p = 1; p <= Math.max(1, totalPages); p++) {
      const r = await api<{ items: Array<Record<string, unknown>> }>(
        `/api/v1/audit?page=${p}` +
        (userId ? `&userId=${encodeURIComponent(userId)}` : '') + (serverId ? `&serverId=${encodeURIComponent(serverId)}` : '') +
        (tool ? `&tool=${encodeURIComponent(tool)}` : '') + (status ? `&status=${status}` : '') +
        (risk ? `&risk=${risk}` : '') +
        (from ? `&from=${Date.parse(from)}` : '') + (to ? `&to=${Date.parse(to) + 86_400_000 - 1}` : '') +
        (scope ? `&scope=${scope}` : '') +
        (authOnly ? `&actions=${AUTH_ACTIONS.join(',')}` : (action ? `&action=${action}` : '')),
      );
      all.push(...r.items);
      if (r.items.length < PAGE_SIZE) break;
    }
    const cols = ['ts', 'username', 'server_name', 'tool', 'action', 'risk', 'status', 'credential_id'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...all.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `opsgate-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, marginBottom: 4 }}>审计日志</h1>
          <p style={{ color: 'var(--muted)', margin: 0, fontSize: 'var(--text-sm)' }}>
            write-ahead 全量审计，人 / 时间 / 凭证 / 资产 / 工具五要素留痕
          </p>
        </div>
      </div>

      {/* 筛选栏 */}
      <div style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        padding: 16,
        background: 'var(--surface)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border)',
      }}>
        {isAdmin && (
          <div style={{ minWidth: 170 }}><Combobox
            ariaLabel="用户筛选"
            value={userId}
            onChange={(v) => { setUserId(v); setPage(1); }}
            placeholder="全部用户"
            searchPlaceholder="搜索用户名…"
            options={[
              { value: '', label: '全部用户' },
              ...(usersQ.data ?? []).map((u) => ({ value: u.id, label: u.username })),
            ]}
          /></div>
        )}
        <div style={{ minWidth: 180 }}><Combobox
          ariaLabel="资产筛选"
          value={serverId}
          onChange={(v) => { setServerId(v); setPage(1); }}
          placeholder="全部资产"
          searchPlaceholder="搜索资产…"
          options={[
            { value: '', label: '全部资产' },
            // 以真实资产名为主（displayName 可能只是创建时带入的模板标题，同名资产无法区分）
            ...(assetsQ.data?.items ?? []).map((a) => ({
              value: a.id,
              label: a.displayName && a.displayName !== a.name ? `${a.name}（${a.displayName}）` : a.name,
            })),
          ]}
        /></div>
        <input className="input" style={{ maxWidth: 150 }} placeholder="工具名" value={tool} onChange={(e) => { setTool(e.target.value); setPage(1); }} />
        <div style={{ minWidth: 120 }}><Combobox
          ariaLabel="风险筛选"
          value={risk}
          onChange={(v) => { setRisk(v); setPage(1); }}
          placeholder="风险全部"
          options={[{ value: '', label: '风险全部' }, { value: 'high', label: '高风险' }, { value: 'normal', label: '普通' }]}
        /></div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
          从 <input className="input" type="date" style={{ maxWidth: 140 }} value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
          到 <input className="input" type="date" style={{ maxWidth: 140 }} value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
        </label>
        <div style={{ minWidth: 140 }}><Combobox
          ariaLabel="状态筛选"
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          placeholder="状态全部"
          options={[{ value: '', label: '状态全部' }, ...Object.entries(STATUS_LABELS).map(([v, label]) => ({ value: v, label }))]}
        /></div>
        <div style={{ minWidth: 160 }}><Combobox
          ariaLabel="日志范围筛选"
          value={scope}
          onChange={(v) => { setScope(v); setPage(1); }}
          placeholder="日志范围全部"
          options={[
            { value: '', label: '日志范围全部' },
            { value: 'management', label: 'UI 操作日志' },
            { value: 'asset', label: 'MCP 调用日志' },
          ]}
        /></div>
        <div style={{ minWidth: 150 }}><Combobox
          ariaLabel="动作筛选"
          value={action}
          onChange={(v) => { setAction(v); setAuthOnly(false); setPage(1); }}
          placeholder="动作全部"
          searchPlaceholder="搜索动作…"
          options={[{ value: '', label: '动作全部' }, ...ACTION_OPTIONS.map(({ v, label }) => ({ value: v, label }))]}
        /></div>
        <button
          className="btn"
          title="筛选授权类变更"
          onClick={() => { setAuthOnly(!authOnly); setAction(''); setPage(1); }}
          style={authOnly ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}
        >
          <ShieldCheck size={14} strokeWidth={1.8} /> 授权变更
        </button>
        <button
          className="btn"
          onClick={() => setConfirmExport(true)}
          disabled={rows.length === 0}
          style={{ gap: 6 }}
          title="导出当前筛选结果为 CSV（敏感值已由服务端脱敏）"
        >
          <Download size={14} strokeWidth={1.8} /> 导出 CSV
        </button>
        {isAdmin && (
          <button
            className="btn btn-danger"
            onClick={() => setConfirmBulk(true)}
            disabled={!hasBulkFilter || (q.data?.total ?? 0) === 0}
            style={{ gap: 6 }}
            title={hasBulkFilter ? '按当前筛选条件删除审计记录（不可恢复）' : '请先选择至少一个筛选条件'}
          >
            <Trash2 size={14} strokeWidth={1.8} /> 删除筛选结果
          </button>
        )}
        <button className="btn" onClick={() => { void q.refetch(); }} disabled={q.isFetching} style={{ gap: 6 }} title="按当前筛选重新拉取">
          <RefreshCw size={14} strokeWidth={1.8} className={q.isFetching ? 'spin' : ''} /> 刷新
        </button>
      </div>

      {/* 导出即数据出域：动作时显式确认（inline，不用原生 confirm） */}
      {confirmExport && (
        <div
          role="alertdialog"
          aria-label="确认导出"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 14px', borderRadius: 'var(--r-md)',
            background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)',
          }}
        >
          <AlertTriangle size={15} strokeWidth={2} style={{ color: 'var(--warn)', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 220, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
            将导出当前筛选结果共 <b>{q.data?.total ?? 0}</b> 行。文件离开系统边界后不再受本平台审计与访问控制约束，请确认接收方与存放位置安全。
          </span>
          <button className="btn btn-primary" onClick={() => { setConfirmExport(false); void exportCsv(); }}>确认导出</button>
          <button className="btn" onClick={() => setConfirmExport(false)}>取消</button>
        </div>
      )}

      {/* 批量删除确认：硬删除不可恢复，必须显式确认行数 */}
      {confirmBulk && (
        <div
          role="alertdialog"
          aria-label="确认批量删除"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 14px', borderRadius: 'var(--r-md)',
            background: 'var(--danger-soft)', border: '1px solid var(--danger)',
          }}
        >
          <AlertTriangle size={15} strokeWidth={2} style={{ color: 'var(--danger)', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 220, fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
            将按当前筛选条件永久删除 <b>{q.data?.total ?? 0}</b> 条审计记录，<b>不可恢复</b>。这是不可逆的数据删除，请确认筛选条件无误。
          </span>
          <button className="btn btn-danger" disabled={bulkDel.isPending} onClick={() => bulkDel.mutate()}>
            {bulkDel.isPending ? '删除中…' : '确认删除'}
          </button>
          <button className="btn" onClick={() => setConfirmBulk(false)}>取消</button>
        </div>
      )}

      {/* 数据表 */}
      <div className="card" style={{ overflow: 'auto' }}>
        {q.isLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <div className="spin" style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} />
            </div>
            加载中…
          </div>
        ) : (
          <table className="dt">
            <thead>
              <tr>
                <th>时间</th><th>用户</th><th>资产</th><th>工具</th><th>动作</th><th>风险</th><th>状态</th>
                {isAdmin && <th style={{ width: 90 }}>操作</th>}
              </tr>
            </thead>
            <tbody>
              {(q.data?.items ?? []).map((r) => {
                const rowId = String(r.id);
                return (
                  <tr key={rowId} style={{ cursor: 'pointer' }} onClick={() => setDetail(r)}>
                    <td className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{fmtTs(r.ts as number)}</td>
                    <td style={{ fontSize: 'var(--text-sm)' }}>{String(r.username || String(r.user_id).slice(0, 8))}</td>
                    <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>
                      {SUBJECT_LABELS[String(r.server_name)] ?? String(r.server_name || String(r.server_id).slice(0, 8))}
                    </td>
                    <td className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>{String(r.tool)}</td>
                    <td style={{ fontSize: 'var(--text-sm)' }}>{ACTION_LABELS[String(r.action)] ?? String(r.action)}</td>
                    <td>
                      {r.risk === 'high'
                        ? <StatusBadge kind="error" label="高风险" />
                        : <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{RISK_LABELS[String(r.risk)] ?? String(r.risk)}</span>}
                    </td>
                    <td>
                      <StatusBadge
                        kind={AUDIT_STATUS_KIND[String(r.status)] ?? 'disabled'}
                        label={STATUS_LABELS[String(r.status)] ?? String(r.status)}
                      />
                    </td>
                    {isAdmin && (
                      <td onClick={(e) => e.stopPropagation()}>
                        {confirmingRow === rowId ? (
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
                            <span style={{ color: 'var(--danger)', fontSize: 11 }}>永久删除？</span>
                            <button className="btn btn-danger" style={{ padding: '1px 6px', fontSize: 11 }} disabled={del.isPending} onClick={() => del.mutate(rowId)}>确认</button>
                            <button className="btn" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => setConfirmingRow(null)}>取消</button>
                          </span>
                        ) : (
                          <button className="btn" style={{ padding: '1px 6px', fontSize: 11, gap: 2 }} title="删除这条审计记录（不可恢复）" onClick={() => setConfirmingRow(rowId)}>
                            <Trash2 size={11} strokeWidth={2} /> 删除
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!q.isLoading && (q.data?.items ?? []).length === 0 && (
          <div className="empty" style={{ border: 'none', background: 'transparent' }}>
            暂无审计记录
          </div>
        )}
      </div>

      {/* 分页 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
        <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          <ChevronLeft size={14} /> 上一页
        </button>
        <span className="mono" style={{ fontSize: 'var(--text-sm)', padding: '0 8px' }}>
          {page} / {totalPages || 1}（{q.data?.total ?? 0} 行）
        </span>
        <button className="btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
          下一页 <ChevronRight size={14} />
        </button>
      </div>

      {detail && <AuditDetailModal row={detail} onClose={() => setDetail(null)} onCopied={() => toast.success('已复制到剪贴板')} />}
    </div>
  );
}

/**
 * 审计详情弹窗（2026-11-18 用户决策：原来行内平铺）。
 *
 * 字段来源必须与后端列名一致：参数存的是 `input_summary`（服务端已脱敏 + 截断），
 * 不是 `args`——早期版本读 `args` 导致"参数永远是（无参数）"。
 * 凭证列存 `credential_id`，展示用后端补的 `credential_name`。
 */
function AuditDetailModal({
  row,
  onClose,
  onCopied,
}: {
  row: Record<string, unknown>;
  onClose: () => void;
  onCopied: () => void;
}) {
  const credential = typeof row.credential_name === 'string' && row.credential_name
    ? `${row.credential_name}（${String(row.credential_id)}）`
    : String(row.credential_id ?? '—');
  const argsText = prettyArgs(row.input_summary);
  const output = typeof row.output_summary === 'string' && row.output_summary ? prettyArgs(row.output_summary) : '';
  const error = typeof row.error_message === 'string' ? row.error_message : '';

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(onCopied, () => { /* 剪贴板不可用时静默（http 环境常见） */ });
  };

  return (
    <Modal title="审计详情" onClose={onClose} width={720}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>五要素</div>
        <DetailRow k="谁（用户）" v={String(row.username ?? row.user_id ?? '—')} />
        <DetailRow k="何时" v={fmtTs(row.ts as number)} />
        <DetailRow k="用哪个凭证" v={credential} mono />
        <DetailRow k="对哪台机器" v={String(row.server_name || row.server_id || '—')} mono />
        <DetailRow
          k="执行什么"
          v={`${String(row.tool ?? '')} · ${ACTION_LABELS[String(row.action)] ?? String(row.action ?? '')}`}
          mono
        />
        <DetailRow k="结果" v={`${STATUS_LABELS[String(row.status)] ?? String(row.status)}${row.duration_ms != null ? ` · ${String(row.duration_ms)} ms` : ''}`} />
        {row.source_ip ? <DetailRow k="来源 IP" v={String(row.source_ip)} mono /> : null}
        {row.api_key_id ? <DetailRow k="API Key" v={`${String(row.client_name ?? '')}（${String(row.api_key_id)}）`} mono /> : null}

        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>参数（服务端已脱敏并截断）</span>
            <button className="btn" style={{ padding: '1px 6px', fontSize: 11, gap: 3 }} onClick={() => copy(argsText)}>
              <Copy size={11} strokeWidth={2} /> 复制
            </button>
          </div>
          <pre className="mono" style={{ margin: 0, padding: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 12, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {argsText}
          </pre>
        </div>

        {output && (
          <div>
            <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', marginBottom: 4 }}>输出摘要（已截断）</div>
            <pre className="mono" style={{ margin: 0, padding: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 12, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {output}
            </pre>
          </div>
        )}

        {error && (
          <div>
            <div style={{ color: 'var(--danger)', fontSize: 'var(--text-xs)', marginBottom: 4 }}>错误</div>
            <pre className="mono" style={{ margin: 0, padding: 10, background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)', fontSize: 12, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {error}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 参数摘要：字符串直出，对象美化；服务端已把敏感键值替换为 *** */
function prettyArgs(raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '（无参数）';
  if (typeof raw !== 'string') {
    try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function DetailRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 'var(--text-sm)' }}>
      <span style={{ width: 96, color: 'var(--meta)', flexShrink: 0 }}>{k}</span>
      <span className={mono ? 'mono' : ''} style={{ color: 'var(--fg-2)', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}
