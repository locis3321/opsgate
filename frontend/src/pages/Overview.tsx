import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ShieldBan, Server, ShieldAlert, Copy, Check, ArrowRight,
  Globe, KeyRound, Flame, Radio,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, fmtTs } from '../api';
import StatusBadge from '../components/StatusBadge';

interface AssetRow {
  id: string; name: string; displayName: string | null; visibility: string; enabled: boolean;
  executionMode: string; category: string;
}

/** 概览（T6）：安全状态条 + 实例健康 + 热资产 Top5 + 最近高危事件流 + MCP 端点复制。
 *  成员降级：实例池与全局统计是 admin 端点，非管理员不查（避免 403 白屏），改为展示可见范围内的安全条。 */
export default function Overview() {
  const nav = useNavigate();
  const [copied, setCopied] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    // 首帧可能早于会话建立（与 SessionGuard 竞态）：会话缺失时短暂重试，避免把管理员误判为成员
    const load = async (attempt: number): Promise<void> => {
      const j = await fetch('/api/v1/auth/get-session', { credentials: 'include' })
        .then((r) => r.json())
        .catch(() => null);
      if (!alive) return;
      if (j?.user) { setIsAdmin(Boolean(j.user.isAdmin)); return; }
      if (attempt > 0) { window.setTimeout(() => void load(attempt - 1), 400); return; }
      setIsAdmin(false);
    };
    void load(2);
    return () => { alive = false; };
  }, []);

  const assets = useQuery({
    queryKey: ['ov-assets'],
    queryFn: () => api<{ items: AssetRow[]; total: number }>('/api/v1/servers?page=1'),
  });
  // admin-only 端点：成员不查（403 会白屏）
  const stats = useQuery({
    queryKey: ['ov-stats'],
    queryFn: () => api<{ rows: Array<Record<string, unknown>> }>('/api/v1/audit/stats?groupBy=global&window=24h'),
    enabled: isAdmin === true,
  });
  const hot = useQuery({
    queryKey: ['ov-hot-assets'],
    queryFn: () => api<{ rows: Array<Record<string, unknown>> }>('/api/v1/audit/stats?groupBy=asset&window=24h'),
    enabled: isAdmin === true,
  });
  const runtime = useQuery({
    queryKey: ['ov-runtime'],
    queryFn: () => api<{ stats: Record<string, number> }>('/api/v1/runtime/instances'),
    enabled: isAdmin === true,
  });
  const highRisk = useQuery({
    queryKey: ['ov-high-risk'],
    queryFn: () => api<{ items: Array<Record<string, unknown>> }>('/api/v1/audit?risk=high&page=1'),
  });

  const list = assets.data?.items ?? [];
  const s = stats.data?.rows?.[0];
  const callCount = Number(s?.call_count ?? 0);
  const errorCount = Number(s?.error_count ?? 0);
  const blockedCount = Number(s?.blocked_count ?? 0);
  const ready = Number(runtime.data?.stats?.ready ?? 0);
  const failing = Number(runtime.data?.stats?.failing ?? 0);
  const spawning = Number(runtime.data?.stats?.spawning ?? 0);

  // 安全摘要：服务端全量聚合（覆盖全部可见资产，不是分页前 50 条）。
  // 失败时显式展示"统计不可用"，绝不吞错假报 0（安全语义）。
  const summary = useQuery({
    queryKey: ['ov-security-summary'],
    queryFn: () => api<{ totalAssets: number; publicCount: number; missingCredAssets: number }>('/api/v1/servers/security-summary'),
  });
  const publicCount = summary.data?.publicCount ?? 0;
  const missingCred = summary.data?.missingCredAssets ?? 0;
  const summaryErr = summary.isError;

  // 统计展示用真实资产名（displayName 可能是模板标题）
  const nameById = new Map(list.map((a) => [a.id, a.name]));
  const hotRows = (hot.data?.rows ?? [])
    .map((r) => ({
      id: String(r.asset_id ?? ''),
      name: nameById.get(String(r.asset_id)) ?? String(r.asset_id ?? '').slice(0, 8),
      calls: Number(r.call_count ?? 0),
    }))
    .filter((r) => r.calls > 0)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);

  const highRiskItems = (highRisk.data?.items ?? []).slice(0, 6);
  const mcpUrl = `${window.location.origin}/mcp`;

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="page animate-fade-in">
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, marginBottom: 4 }}>概览</h1>
        <p style={{ color: 'var(--muted)', margin: 0, fontSize: 'var(--text-sm)' }}>可信、可见、低门槛的运维 MCP 控制台</p>
      </div>

      {/* 安全状态条：非零项可点击直达（差异化卖点：审计到人 + 安全可见性） */}
      <div className="card" style={{ padding: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <ShieldAlert size={16} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginRight: 4 }}>安全状态</span>
        <SafetyChip
          icon={<Globe size={12} />} label="公开资产" value={summaryErr ? null : publicCount}
          onClick={() => nav('/assets?visibility=public')}
        />
        <SafetyChip
          icon={<KeyRound size={12} />} label="有未绑槽位" value={summaryErr ? null : missingCred}
          onClick={() => nav('/assets')}
        />
        {isAdmin && (
          <SafetyChip icon={<ShieldBan size={12} />} label="24h 拦截" value={blockedCount} onClick={() => nav('/audit')} />
        )}
        {isAdmin && (
          <SafetyChip icon={<AlertTriangle size={12} />} label="24h 错误" value={errorCount} onClick={() => nav('/audit?status=error')} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mcpUrl}</span>
          <button className="btn" onClick={() => void copyEndpoint()} style={{ gap: 6, minHeight: 30, padding: '4px 10px' }}>
            {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
            {copied ? '已复制' : '复制端点'}
          </button>
        </div>
      </div>

      {/* 指标卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
        <MetricCard label="24h 调用" value={isAdmin ? String(callCount) : '—'} icon={Activity} color="var(--accent)" bg="var(--accent-soft)" note={isAdmin ? undefined : '仅管理员可见'} />
        <MetricCard label="可见资产" value={String(summary.data?.totalAssets ?? assets.data?.total ?? list.length)} icon={Server} color="var(--fg)" bg="var(--surface-2)" />
        <MetricCard
          label="实例池"
          value={isAdmin ? `${ready}` : '—'}
          suffix={isAdmin ? ` / ${ready + spawning + failing}` : undefined}
          icon={Radio}
          color={failing > 0 ? 'var(--danger)' : 'var(--accent)'}
          bg={failing > 0 ? 'var(--danger-soft)' : 'var(--accent-soft)'}
          note={isAdmin ? (failing > 0 ? `${failing} 个失败` : spawning > 0 ? `${spawning} 个启动中` : '全部就绪') : '仅管理员可见'}
        />
        <MetricCard label="高危事件" value={String(highRiskItems.length)} icon={AlertTriangle} color={highRiskItems.length > 0 ? 'var(--warn)' : 'var(--success)'} bg={highRiskItems.length > 0 ? 'var(--warn-soft)' : 'var(--success-soft)'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* 热资产 Top5 */}
        <div className="card" style={{ padding: 18, display: 'grid', gap: 10, alignContent: 'start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Flame size={15} strokeWidth={1.8} style={{ color: 'var(--warn)' }} />
            <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>热资产 Top5（24h）</span>
          </div>
          {!isAdmin && <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>调用统计仅管理员可见。</div>}
          {isAdmin && hotRows.length === 0 && <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>近 24 小时暂无调用。</div>}
          {hotRows.map((r, i) => (
            <button
              key={r.id}
              className="palette-item"
              style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left' }}
              onClick={() => nav(`/assets/${r.id}`)}
            >
              <span className="mono" style={{ color: 'var(--meta)', width: 16 }}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <span className="mono" style={{ color: 'var(--fg-2)' }}>{r.calls}</span>
            </button>
          ))}
        </div>

        {/* 最近高危事件流 */}
        <div className="card" style={{ padding: 18, display: 'grid', gap: 10, alignContent: 'start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={15} strokeWidth={1.8} style={{ color: 'var(--danger)' }} />
            <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>最近高危事件</span>
            <button className="btn" style={{ marginLeft: 'auto', gap: 4, minHeight: 28, padding: '3px 8px' }} onClick={() => nav('/audit?risk=high')}>
              全部 <ArrowRight size={12} strokeWidth={1.8} />
            </button>
          </div>
          {highRiskItems.length === 0 && <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>暂无高危事件。</div>}
          {highRiskItems.map((it, i) => (
            <div key={String(it.id ?? i)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)' }}>
              <StatusBadge kind={it.status === 'blocked' ? 'warn' : it.status === 'error' ? 'error' : 'info'} label={String(it.status ?? '')} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-2)' }}>
                {String(it.username ?? '—')} · {String(it.tool ?? it.action ?? '')}
              </span>
              <span className="mono" style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>{fmtTs(it.ts as number)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <ShieldBan size={15} style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
          <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>审计说明</span>
        </div>
        <p style={{ color: 'var(--fg-2)', margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>
          审计日志保留 12 个月；所有工具调用经 write-ahead 审计（人 / 时间 / 凭证 / 资产 / 工具五要素）。
          预聚合统计按小时桶更新，跨月查询自动合并。
        </p>
      </div>
    </div>
  );
}

/** 安全条单项。value=null 表示统计不可用（拉取失败）——显式标注而非假报 0 */
function SafetyChip({ icon, label, value, onClick }: { icon: React.ReactNode; label: string; value: number | null; onClick: () => void }) {
  const unavailable = value === null;
  const alert = !unavailable && value > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="status-badge"
      style={{
        cursor: 'pointer', gap: 5,
        color: unavailable ? 'var(--danger)' : alert ? 'var(--warn)' : 'var(--muted)',
        background: unavailable ? 'var(--danger-soft)' : alert ? 'var(--warn-soft)' : 'var(--surface-2)',
        borderColor: unavailable ? 'var(--danger)' : alert ? 'var(--security-warn-border)' : 'var(--border)',
        fontFamily: 'inherit',
      }}
      title={unavailable ? '统计不可用（请求失败，请重试）' : alert ? `${label} ${value}（需关注，点击查看）` : `${label} ${value}`}
    >
      {icon}{label} <span className="mono" style={{ fontWeight: 700 }}>{unavailable ? '—' : value}</span>
    </button>
  );
}

function MetricCard({ label, value, suffix, icon: Icon, color, bg, note }: {
  label: string; value: string; suffix?: string; icon: typeof Activity; color: string; bg: string; note?: string;
}) {
  return (
    <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'flex-start', gap: 14 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={18} style={{ color }} strokeWidth={1.8} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', marginBottom: 2 }}>{label}</div>
        <div className="mono" style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color, lineHeight: 1.1 }}>
          {value}{suffix ?? ''}
        </div>
        {note && <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', marginTop: 2 }}>{note}</div>}
      </div>
    </div>
  );
}
