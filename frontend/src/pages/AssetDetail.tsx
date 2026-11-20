import { useParams, useNavigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Fingerprint, Zap, Wrench, BarChart3, ScrollText,
  KeyRound, RefreshCw, Eye, Users2, ExternalLink, Trash2,
} from 'lucide-react';
import { api, ApiError, fmtTs } from '../api';
import SlotBinder from '../components/SlotBinder';
import StatusBadge from '../components/StatusBadge';
import Tabs from '../components/Tabs';
import { useToast } from '../components/Toast';
import Combobox from '../components/Combobox';
import TagEditor from '../components/TagEditor';

interface SlotRow { slotName: string; label: string; target: string; file: boolean; optional?: boolean; credentialId: string | null; credentialName: string | null; inlineValue: string | null; hasInline?: boolean }
interface ToolRow { name: string; description: string }
interface InstanceRow { key: string; state: string; refs: number; spawnedAt: number; lastUsed: number; error?: string }

type TabKey = 'credentials' | 'tools' | 'visibility' | 'stats';

const TABS = [
  { value: 'credentials' as TabKey, label: '凭证绑定', icon: <KeyRound size={14} strokeWidth={1.8} /> },
  { value: 'tools' as TabKey, label: '工具', icon: <Wrench size={14} strokeWidth={1.8} /> },
  { value: 'visibility' as TabKey, label: '可见性', icon: <Users2 size={14} strokeWidth={1.8} /> },
  { value: 'stats' as TabKey, label: '调用与审计', icon: <BarChart3 size={14} strokeWidth={1.8} /> },
];

/** 可见范围：图标+文字双通道（Spec §8.6 V1/V2），public 走琥珀警示 */
const VISIBILITY: Record<string, { label: string; kind: 'success' | 'info' | 'warn'; hint: string }> = {
  owner: { label: '仅归属人', kind: 'info', hint: '只有创建者本人可查看与调用' },
  group: { label: '分组共享', kind: 'success', hint: '所在分组的成员可查看与调用' },
  public: { label: '公开', kind: 'warn', hint: '所有成员都可查看与调用（高风险）' },
};

/**
 * 资产可信闭环详情（T2）：四 Tab —— 凭证绑定 / 工具 / 可见性 / 调用与审计。
 * 工具与实例状态是运行时事实，实时拉取（自适应轮询），失败显式展示不假绿。
 */
export default function AssetDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<TabKey>('credentials');
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 连接地址编辑草稿（null = 未编辑，显示服务端值） */
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [allowPrivateDraft, setAllowPrivateDraft] = useState<boolean | null>(null);
  const [insecureTlsDraft, setInsecureTlsDraft] = useState<boolean | null>(null);

  const asset = useQuery({ queryKey: ['asset', id], queryFn: () => api<Record<string, unknown>>(`/api/v1/servers/${id}`) });
  // 与 SlotBinder 共用 ['slots', id] 缓存：绑定/解绑后此条同步刷新
  const slots = useQuery({ queryKey: ['slots', id], queryFn: () => api<SlotRow[]>(`/api/v1/servers/${id}/slots`) });
  // 当前身份：只有归属人/管理员能把凭证共享给组内成员（服务端同口径校验）
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { id?: string; isAdmin?: boolean } };
      return { id: j?.user?.id ?? '', isAdmin: Boolean(j?.user?.isAdmin) };
    },
  });
  const canShare = Boolean(asset.data && me.data && (me.data.isAdmin || String(asset.data.ownerId ?? '') === me.data.id));

  const isNative = String(asset.data?.executionMode) === 'native';
  /** native 有两种：host=SSH 直连；其余品类=网关内建 HTTP 工具（无主机、无指纹、无实例） */
  const isSshNative = isNative && String(asset.data?.category) === 'host';
  const isMcp = !isNative;

  // 实例列表：有 spawning/draining 时 2s 快轮询，稳定后 30s（自适应，省资源）
  const instances = useQuery({
    queryKey: ['instances', id],
    queryFn: () => api<{ instances: InstanceRow[] }>(`/api/v1/servers/${id}/instances`),
    enabled: isMcp,
    refetchInterval: (query) => {
      const rows = query.state.data?.instances ?? [];
      return rows.some((r) => r.state === 'spawning' || r.state === 'draining') ? 2000 : 30_000;
    },
  });

  const toolFilters = useQuery({
    queryKey: ['tool-filters', id],
    queryFn: () => api<{ enabledTools: string[]; disabledTools: string[] }>(`/api/v1/servers/${id}/tools`),
    enabled: isMcp,
  });

  const rawTools = useQuery({
    queryKey: ['tools-raw', id],
    queryFn: () => api<{ tools: ToolRow[] }>(`/api/v1/servers/${id}/tools/raw`),
    // 内建 HTTP 资产也展示工具清单（平台固定，无需拉起实例）
    enabled: !isSshNative && tab === 'tools',
    retry: false,
  });

  const patchTools = useMutation({
    mutationFn: (v: { enabledTools: string[]; disabledTools: string[] }) =>
      api(`/api/v1/servers/${id}/tools`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tool-filters', id] });
      toast.success('工具启用状态已保存');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '保存失败'),
  });

  const testConn = useMutation({
    mutationFn: () => api<Record<string, unknown>>(`/api/v1/servers/${id}/test`, { method: 'POST' }),
    onSuccess: (d) => {
      // 三种形态的"成功"证据不同：MCP=工具数、SSH=探测输出、内建 HTTP=接口返回的说明
      const detail = d.tools !== undefined
        ? `${String(d.tools)} 个工具`
        : d.stdout !== undefined
          ? String(d.stdout)
          : String(d.detail ?? '');
      const text = `成功（${String(d.mode)}${detail ? `，${detail}` : ''}）`;
      setTestResult({ ok: true, text });
      toast.success(`连通测试通过：${text}`);
      void qc.invalidateQueries({ queryKey: ['instances', id] });
    },
    onError: (e) => {
      const text = e instanceof ApiError ? e.message : '连通失败';
      setTestResult({ ok: false, text });
      toast.error(`连通测试失败：${text}`);
      void qc.invalidateQueries({ queryKey: ['instances', id] });
    },
  });

  const trust = useMutation({
    mutationFn: () => api<{ fingerprint: string }>(`/api/v1/servers/${id}/ssh/trust-fingerprint`, { method: 'POST' }),
    onSuccess: (d) => { setTestResult({ ok: true, text: `已信任指纹：${d.fingerprint.slice(0, 24)}…` }); toast.success('主机指纹已信任'); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '信任失败'),
  });

  const del = useMutation({
    mutationFn: () => api(`/api/v1/servers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assets'] });
      toast.success('资产已删除');
      nav('/assets');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '删除失败'),
  });

  /** 改连接地址（后端会做 SSRF 校验；同批可同时开私网，见 PATCH 的最终值判定） */
  const patchUrl = useMutation({
    mutationFn: (v: { url: string }) =>
      api(`/api/v1/servers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          url: v.url.trim(),
          ...(allowPrivateDraft !== null ? { allowPrivateNetwork: allowPrivateDraft } : {}),
        }),
      }),
    onSuccess: () => {
      setUrlDraft(null);
      toast.success('连接地址已保存');
      void qc.invalidateQueries({ queryKey: ['asset', id] });
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '保存失败'),
  });

  /** 允许不安全 TLS（自签证书）：关闭证书校验，变更写治理审计并回收实例 */
  const patchInsecureTls = useMutation({
    mutationFn: (v: { allowInsecureTls: boolean }) =>
      api(`/api/v1/servers/${id}`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => {
      toast.success('TLS 校验设置已保存');
      void qc.invalidateQueries({ queryKey: ['asset', id] });
      void qc.invalidateQueries({ queryKey: ['instances', id] });
    },
    onError: (e) => {
      setInsecureTlsDraft(null);
      toast.error(e instanceof ApiError ? e.message : '保存失败');
    },
  });

  const patchPrivate = useMutation({
    mutationFn: (v: { allowPrivateNetwork: boolean }) =>
      api(`/api/v1/servers/${id}`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => {
      toast.success('私网访问设置已保存');
      void qc.invalidateQueries({ queryKey: ['asset', id] });
    },
    onError: (e) => {
      setAllowPrivateDraft(null);
      toast.error(e instanceof ApiError ? e.message : '保存失败');
    },
  });

  /**
   * 标签保存（整体替换）。标签影响 `?tag=` 收窄与分组筛选，所以每次增删都立刻落库，
   * 不做"批量编辑后统一保存"——否则用户以为改完了、实际没生效。
   */
  const patchTags = useMutation({
    mutationFn: (tags: string[]) =>
      api(`/api/v1/servers/${id}`, { method: 'PATCH', body: JSON.stringify({ tags }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['asset', id] });
      void qc.invalidateQueries({ queryKey: ['assets'] });
      void qc.invalidateQueries({ queryKey: ['server-tags'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '标签保存失败'),
  });

  const a = asset.data;

  const boundCount = (slots.data ?? []).reduce((acc, r) => acc + ((r as { bindings?: unknown[] }).bindings?.length ?? (r.credentialId ? 1 : 0)), 0);
  const slotInlineCount = (slots.data ?? []).filter((r) => r.inlineValue !== null || r.hasInline).length;

  /** 实例状态点：failed 优先 → 启动中 → 就绪 → 空闲 */
  const instState = useMemo(() => {
    const rows = instances.data?.instances ?? [];
    if (rows.some((r) => r.state === 'failed')) return { kind: 'error' as const, label: '实例失败' };
    if (rows.some((r) => r.state === 'spawning' || r.state === 'draining')) return { kind: 'running' as const, label: '启动中' };
    const ready = rows.filter((r) => r.state === 'ready').length;
    if (ready > 0) return { kind: 'success' as const, label: ready > 1 ? `就绪 ×${ready}` : '就绪' };
    return { kind: 'disabled' as const, label: '空闲' };
  }, [instances.data]);

  if (!a) {
    return (
      <div className="page animate-fade-in">
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
          <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</span>
        </div>
      </div>
    );
  }

  const visibility = String(a.visibility);
  const vis = VISIBILITY[visibility] ?? { label: visibility, kind: 'info' as const, hint: '' };
  const enabledTools = toolFilters.data?.enabledTools ?? [];
  const disabledTools = toolFilters.data?.disabledTools ?? [];
  /** 工具是否启用：disabledTools 优先，其次 enabledTools 白名单（空=全开） */
  const toolEnabled = (name: string) => !disabledTools.includes(name) && (enabledTools.length === 0 || enabledTools.includes(name));

  const toggleTool = (name: string, next: boolean) => {
    const disabled = new Set(disabledTools);
    if (next) disabled.delete(name);
    else disabled.add(name);
    patchTools.mutate({ enabledTools, disabledTools: [...disabled] });
  };

  return (
    <div className="page animate-fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="icon-btn" onClick={() => nav(-1)} aria-label="返回">
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }} className="mono">{String(a.name)}</h1>
            {isMcp && <StatusBadge kind={instState.kind} label={instState.label} pulse={instState.kind === 'running'} />}
            <span className="tag">{String(a.type)}</span>
            <StatusBadge kind={vis.kind} label={vis.label} title={vis.hint} />
          </div>
          <p style={{ color: 'var(--muted)', margin: '2px 0 0', fontSize: 'var(--text-sm)' }}>
            {String(a.category)} · {String(a.executionMode)}（{isSshNative ? 'SSH 直连' : isNative ? '内建 HTTP 工具' : 'MCP 实例'}）· 更新于 {fmtTs(a.updatedAt as number)}
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isSshNative && (
            <button className="btn" onClick={() => trust.mutate()} disabled={trust.isPending} style={{ gap: 6 }} title="采集主机公钥并记录 SHA256 指纹；之后连接时指纹不一致将被拒绝（防中间人）">
              <Fingerprint size={14} strokeWidth={1.8} /> 信任主机指纹
            </button>
          )}
          <button className="btn btn-primary" onClick={() => testConn.mutate()} disabled={testConn.isPending} style={{ gap: 6 }} title={isSshNative ? 'SSH 连接并执行一条探测命令' : isNative ? '按品类探测内建 HTTP API（只读端点）' : '拉起 MCP 实例并列出工具'}>
            {testConn.isPending ? <RefreshCw size={14} strokeWidth={2} className="spin" /> : <Zap size={14} strokeWidth={1.8} />}
            {testConn.isPending ? '测试中…' : '连通性测试'}
          </button>
        </div>
      </div>

      {testResult && (
        <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusBadge kind={testResult.ok ? 'success' : 'error'} label={testResult.ok ? '测试通过' : '测试失败'} />
          <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)', wordBreak: 'break-all' }}>{testResult.text}</span>
        </div>
      )}

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'credentials' && (
        <div className="card" style={{ padding: 20 }}>
          <SlotBinder assetId={id!} canShare={canShare} authSlot={isSshNative ? String((asset.data?.hostConn as Record<string, unknown> | null | undefined)?.authSlot ?? '') || null : null} />
        </div>
      )}

      {tab === 'tools' && (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
          {isSshNative ? (
            <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
              原生 SSH 主机不暴露 MCP 工具清单；其能力由原生工具（host_execute_command / 文件传输）提供。
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Wrench size={15} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
                <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>工具清单</span>
                {rawTools.isSuccess && <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>共 {rawTools.data!.tools.length} 个</span>}
                {isNative ? (
                  <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                    平台内建（{String(a.category)}）· 清单固定，由网关直接实现
                  </span>
                ) : (
                  <button
                    className="btn"
                    style={{ marginLeft: 'auto', gap: 6 }}
                    onClick={async () => {
                      // refetch() 在数据未变化时不改变界面，用户会以为"点了没反应"——
                      // 显式给出进行中/完成/失败三态反馈。
                      const r = await rawTools.refetch();
                      if (r.status === 'error') {
                        toast.error(`重新拉取失败：${r.error instanceof Error ? r.error.message : String(r.error)}`);
                      } else {
                        toast.success(`已重新拉取，共 ${r.data?.tools.length ?? 0} 个工具`);
                      }
                    }}
                    disabled={rawTools.isFetching}
                  >
                    <RefreshCw size={13} strokeWidth={1.8} className={rawTools.isFetching ? 'spin' : ''} /> {rawTools.isFetching ? '拉取中…' : '重新拉取'}
                  </button>
                )}
              </div>

              {rawTools.isLoading && <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{isNative ? '加载内建工具清单…' : '正在拉起实例并读取工具…'}</div>}

              {rawTools.isError && (
                <div style={{ display: 'grid', gap: 6 }}>
                  <StatusBadge kind="error" label="工具拉取失败" />
                  <div className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--danger)', wordBreak: 'break-all' }}>
                    {rawTools.error instanceof ApiError ? rawTools.error.message : String(rawTools.error)}
                  </div>
                  <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                    常见原因：凭证未绑定 / 下游不可达 / 启动命令或版本错误。先在「凭证绑定」补齐槽位，再点「重新拉取」。
                  </div>
                </div>
              )}

              {rawTools.isSuccess && (
                <div className="card" style={{ overflow: 'auto', boxShadow: 'none' }}>
                  <table className="dt dt-sticky">
                    <thead>
                      <tr>
                        <th style={{ width: 240 }}>工具名</th>
                        <th>描述</th>
                        {/* 内建工具清单固定：不提供逐条启停（要停用请到「原生工具」页做平台级停用） */}
                        {!isNative && <th style={{ width: 130 }}>启用</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rawTools.data!.tools.map((t) => {
                        const on = toolEnabled(t.name);
                        return (
                          <tr key={t.name}>
                            <td className="mono" style={{ fontWeight: 550 }}>{t.name}</td>
                            <td style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>{t.description || '—'}</td>
                            {!isNative && (
                              <td>
                                <button
                                  className="btn"
                                  onClick={() => toggleTool(t.name, !on)}
                                  disabled={patchTools.isPending}
                                  style={{ gap: 6, minHeight: 28, padding: '3px 8px' }}
                                  aria-pressed={on}
                                  aria-label={`${on ? '禁用' : '启用'}工具 ${t.name}`}
                                >
                                  <StatusBadge kind={on ? 'success' : 'disabled'} label={on ? '已启用' : '已禁用'} />
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                      {rawTools.data!.tools.length === 0 && (
                        <tr><td colSpan={isNative ? 2 : 3} style={{ textAlign: 'center', color: 'var(--meta)' }}>该资产未暴露任何工具</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {disabledTools.length > 0 && (
                <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                  已禁用 {disabledTools.length} 个工具：<span className="mono">{disabledTools.join('、')}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'visibility' && (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 14, alignContent: 'start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Eye size={15} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
            <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>可见范围</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StatusBadge kind={vis.kind} label={vis.label} />
            <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{vis.hint}</span>
          </div>
          <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
            可见 ≡ 可调用（AC-6）：同组成员看见该资产即可调用其工具，无需二次授权。
            {visibility === 'public' && ' 公开资产对所有成员可见，请确认其中不包含超出共享范围的主机或数据库。'}
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <Row k="归属人" v={String(a.ownerId ?? '（无主）')} mono />
            <Row k="协议" v={String(a.type)} mono />
            <Row k="品类" v={String(a.category)} />
            <Row k="执行模式" v={String(a.executionMode)} />
            <div style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--border-soft)', paddingTop: 10 }}>
              <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>标签</div>
              <TagEditor
                inputId="asset-tags-input"
                value={(a.tags as string[] | null) ?? []}
                onChange={(tags) => patchTags.mutate(tags)}
              />
              <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                标签用于 MCP 端点 <span className="mono">?tag=</span> 收窄与资产筛选，按精确值匹配；优先从已有标签中选，避免近义重复。
              </div>
            </div>
            <Row k="主机" v={a.hostConn ? `${(a.hostConn as Record<string, unknown>).host}:${(a.hostConn as Record<string, unknown>).port ?? 22}` : '无'} />
            <Row k="配置哈希" v={String(a.configHash).slice(0, 12)} mono />
            <Row k="创建" v={fmtTs(a.createdAt as number)} />
          </div>

          {/* 连接地址：可编辑（建错地址、或条目升级后要指向真实地址时不必删了重建）。
              SSH 主机用 host_conn（另有"主机"行），stdio 资产无地址——只有 HTTP 类才显示。 */}
          {!isSshNative && String(a.type) !== 'stdio' ? (
            <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 12, display: 'grid', gap: 8 }}>
              <span style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>连接地址</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input
                  className="input mono"
                  style={{ flex: 1, minWidth: 260 }}
                  placeholder="http://host:port（留空表示 stdio 型资产不需要地址）"
                  value={urlDraft ?? String(a.url ?? '')}
                  onChange={(e) => setUrlDraft(e.target.value)}
                />
                <button
                  className="btn btn-primary"
                  disabled={patchUrl.isPending || (urlDraft ?? String(a.url ?? '')) === String(a.url ?? '')}
                  onClick={() => patchUrl.mutate({ url: urlDraft ?? String(a.url ?? '') })}
                >
                  {patchUrl.isPending ? '保存中…' : '保存地址'}
                </button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                <input
                  type="checkbox"
                  checked={allowPrivateDraft ?? Boolean(a.allowPrivateNetwork)}
                  onChange={(e) => {
                    setAllowPrivateDraft(e.target.checked);
                    patchPrivate.mutate({ allowPrivateNetwork: e.target.checked });
                  }}
                />
                允许私网访问（内网地址必须开启；变更写治理审计）
              </label>
              <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                地址变更会立即回收该资产的运行实例，下次调用按新地址重建。
              </div>
            </div>
          ) : null}

          {/* TLS 校验开关：独立于"连接地址"——stdio 型资产（如 kubernetes-mcp-server）同样需要
              （它自己连集群 API），只是没有可编辑的 url。SSH 主机不适用（ssh2 走主机指纹）。 */}
          {!isSshNative && (
            <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 12, display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>TLS 校验</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                <input
                  type="checkbox"
                  checked={insecureTlsDraft ?? Boolean(a.allowInsecureTls)}
                  onChange={(e) => {
                    setInsecureTlsDraft(e.target.checked);
                    patchInsecureTls.mutate({ allowInsecureTls: e.target.checked });
                  }}
                />
                允许不安全 TLS（目标用自签证书时勾选；关闭校验会失去中间人防护）
              </label>
              <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                {String(a.type) === 'stdio'
                  ? '对本资产启动的 MCP 子进程生效（仅该进程注入 NODE_TLS_REJECT_UNAUTHORIZED=0）。'
                  : '对本资产的 HTTP 请求生效（不校验证书链与主机名）。'}
                变更立即回收实例，下次调用按新设置重建；变更写治理审计。
              </div>
            </div>
          )}

          {/* 删除资产：先列影响清单（凭证绑定条数 + 分组归属），确认后才执行 */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            {!confirmDelete ? (
              <button className="btn btn-danger" onClick={() => setConfirmDelete(true)} style={{ gap: 6 }}>
                <Trash2 size={14} strokeWidth={1.8} /> 删除资产
              </button>
            ) : (
              <div style={{ display: 'grid', gap: 8, padding: '12px 14px', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-md)' }}>
                <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                  确认删除「{String(a.name)}」？此操作不可恢复。
                </div>
                <div style={{ color: 'var(--fg-2)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
                  将一并删除：{boundCount} 条凭证绑定
                  {slotInlineCount > 0 ? `、${slotInlineCount} 个直填值` : ''}
                  {' '}与全部分组归属；该资产的实例会被立即回收。
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-danger" onClick={() => del.mutate()} disabled={del.isPending}>
                    {del.isPending ? '删除中…' : '确认删除'}
                  </button>
                  <button className="btn" onClick={() => setConfirmDelete(false)}>取消</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'stats' && <StatsTab assetId={id!} name={String(a.name)} nav={nav} />}
    </div>
  );
}

/** 调用与审计：统计来自现有 /audit/stats，明细直达 /audit?serverId= */
function StatsTab({ assetId, name, nav }: { assetId: string; name: string; nav: ReturnType<typeof useNavigate> }) {
  const [statWindow, setStatWindow] = useState<'24h' | '7d' | '30d'>('7d');
  const stats = useQuery({
    queryKey: ['asset-stats', assetId, statWindow],
    queryFn: () => api<{ rows: Array<Record<string, unknown>> }>(`/api/v1/audit/stats?groupBy=asset&window=${statWindow}&assetId=${assetId}`),
  });
  const rows = stats.data?.rows ?? [];
  const sum = (k: string) => rows.reduce((acc, r) => acc + Number(r[k] ?? 0), 0);
  const callCount = sum('call_count');
  const okCount = sum('ok_count');
  const errorCount = sum('error_count');
  const blockedCount = sum('blocked_count');
  const avgMs = callCount > 0 ? Math.round(sum('total_duration_ms') / callCount) : 0;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChart3 size={15} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>调用统计</span>
          <div style={{ marginLeft: 'auto', minWidth: 130 }}>
            <Combobox
              ariaLabel="统计窗口"
              value={statWindow}
              onChange={(v) => setStatWindow(v as '24h' | '7d' | '30d')}
              options={[{ value: '24h', label: '近 24 小时' }, { value: '7d', label: '近 7 天' }, { value: '30d', label: '近 30 天' }]}
            />
          </div>
        </div>
        {stats.isError && <StatusBadge kind="error" label="统计加载失败" />}
        {callCount === 0 && !stats.isLoading ? (
          <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>该窗口内暂无调用记录。</div>
        ) : (
          <div className="card-grid">
            <StatCard label="调用次数" value={String(callCount)} />
            <StatCard label="成功" value={String(okCount)} kind="success" />
            <StatCard label="失败" value={String(errorCount)} kind={errorCount > 0 ? 'error' : undefined} />
            <StatCard label="被拦截" value={String(blockedCount)} kind={blockedCount > 0 ? 'warn' : undefined} />
            <StatCard label="平均耗时" value={`${avgMs} ms`} />
          </div>
        )}
        <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
          统计按小时桶预聚合（audit_stats_hourly）；明细请见下方审计记录。
        </div>
      </div>

      <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ScrollText size={15} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>审计记录</span>
          <span className="mono" style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>{name}</span>
          <button className="btn" style={{ marginLeft: 'auto', gap: 6 }} onClick={() => nav(`/audit?serverId=${assetId}`)}>
            查看全部 <ExternalLink size={13} strokeWidth={1.8} />
          </button>
        </div>
        <RecentAudit assetId={assetId} nav={nav} />
      </div>
    </div>
  );
}

function RecentAudit({ assetId, nav }: { assetId: string; nav: ReturnType<typeof useNavigate> }) {
  const q = useQuery({
    queryKey: ['asset-audit', assetId],
    queryFn: () => api<{ items: Array<Record<string, unknown>> }>(`/api/v1/audit?serverId=${assetId}&page=1`),
  });
  const items = (q.data?.items ?? []).slice(0, 8);
  if (q.isLoading) return <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</div>;
  if (q.isError) return <StatusBadge kind="error" label="审计加载失败" />;
  if (items.length === 0) return <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>暂无审计记录。</div>;
  return (
    <div className="card" style={{ overflow: 'auto', boxShadow: 'none' }}>
      <table className="dt">
        <thead><tr><th>时间</th><th>用户</th><th>工具/动作</th><th>状态</th></tr></thead>
        <tbody>
          {items.map((r, i) => (
            <tr key={String(r.id ?? i)} style={{ cursor: 'pointer' }} onClick={() => nav(`/audit?serverId=${assetId}`)}>
              <td className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{fmtTs(r.ts as number)}</td>
              <td style={{ fontSize: 'var(--text-sm)' }}>{String(r.username ?? '—')}</td>
              <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{String(r.action ?? r.tool ?? '')}</td>
              <td>
                <StatusBadge
                  kind={r.status === 'success' ? 'success' : r.status === 'blocked' ? 'warn' : r.status === 'error' ? 'error' : 'info'}
                  label={String(r.status ?? '')}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value, kind }: { label: string; value: string; kind?: 'success' | 'error' | 'warn' }) {
  const color = kind === 'success' ? 'var(--success)' : kind === 'error' ? 'var(--danger)' : kind === 'warn' ? 'var(--warn)' : 'var(--fg)';
  return (
    <div className="card" style={{ padding: 14, display: 'grid', gap: 4, boxShadow: 'none' }}>
      <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 'var(--text-2xl)', fontWeight: 650, color }}>{value}</div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline' }}>
      <div style={{ width: 100, color: 'var(--meta)', fontSize: 'var(--text-sm)', flexShrink: 0 }}>{k}</div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: 'var(--text-sm)', wordBreak: 'break-all' }}>{v || '无'}</div>
    </div>
  );
}
