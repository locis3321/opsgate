import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Server, CheckCircle, Loader2, Scale, RefreshCw, Power } from 'lucide-react';
import { api, ApiError, fmtTs } from '../api';
import { useToast } from '../components/Toast';

interface Inst {
  key: string; serverId: string; serverName: string | null; state: string;
  refs: number; spawnedAt: number; lastUsed: number;
  pid: number | null;
  /** 主进程快照；采样失败为 null（显示「—」，不伪造 0） */
  cpuPercent: number | null;
  rssBytes: number | null;
  error?: string;
}

const STAT_META: Record<string, { label: string; icon: typeof Server; color: string; bg: string }> = {
  instances: { label: '总实例', icon: Server, color: 'var(--accent)', bg: 'var(--accent-soft)' },
  ready: { label: '就绪', icon: CheckCircle, color: 'var(--success)', bg: 'var(--success-soft)' },
  spawning: { label: '启动中', icon: Loader2, color: 'var(--warn)', bg: 'var(--warn-soft)' },
  allocatedWeight: { label: '已分配权重', icon: Scale, color: 'var(--accent)', bg: 'var(--accent-soft)' },
};

function fmtBytes(v: number | null): string {
  if (v === null) return '—';
  const mb = v / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function fmtCpu(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`;
}

/** 运行时：实例池 + SSH 连接池 + 暂存区摘要（双池并列展示，§8.5）。 */
export default function Runtime() {
  // 5s 轮询：资源是可观测的短时量，手动刷新不足以看趋势
  const instances = useQuery({
    queryKey: ['runtime-instances'],
    queryFn: () => api<{ stats: Record<string, number>; instances: Inst[] }>('/api/v1/runtime/instances'),
    refetchInterval: 5000,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState<string | null>(null);
  const close = useMutation({
    mutationFn: (key: string) => api<{ closed: boolean }>(`/api/v1/runtime/instances/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    onSuccess: (d) => {
      setConfirming(null);
      toast.success(d.closed ? '实例已关闭' : '实例已不存在');
      void qc.invalidateQueries({ queryKey: ['runtime-instances'] });
    },
    onError: (e) => {
      setConfirming(null);
      toast.error(e instanceof ApiError ? e.message : '关闭失败');
    },
  });

  const statEntries = Object.entries(instances.data?.stats ?? {}).filter(([k]) => k in STAT_META);

  // 长连接池（Redis/Kafka）：有状态连接，active=有调用在用，idle=连接开着没人用（等 TTL 回收）
  const longConn = useQuery({
    queryKey: ['runtime-long-connections'],
    queryFn: () => api<{
      redis: { active: number; idle: number; total: number; available: boolean };
      kafka: { active: number; idle: number; total: number; available: boolean };
    }>('/api/v1/runtime/long-connections'),
    refetchInterval: 5000,
  });

  const longPools = [
    { key: 'redis', label: 'Redis', data: longConn.data?.redis },
    { key: 'kafka', label: 'Kafka', data: longConn.data?.kafka },
  ];

  return (
    <div className="page animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>运行时</h1>
          <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
            实例池与连接池实时状态，展示资源分配与使用情况（每 5 秒自动刷新）
          </p>
        </div>
        <button className="btn" onClick={() => { void instances.refetch(); }} disabled={instances.isFetching} style={{ gap: 6 }} title="重新拉取运行时状态">
          <RefreshCw size={14} strokeWidth={1.8} className={instances.isFetching ? 'spin' : ''} /> 刷新
        </button>
      </div>

      {instances.isLoading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
          <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</span>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
            {statEntries.map(([k, v]) => {
              const meta = STAT_META[k];
              if (!meta) return null;
              const Icon = meta.icon;
              return (
                <div key={k} className="card" style={{ padding: 20, display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                  <div style={{
                    width: 42, height: 42, borderRadius: 10,
                    background: meta.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <Icon size={20} style={{ color: meta.color }} strokeWidth={1.8} />
                  </div>
                  <div>
                    <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', marginBottom: 4 }}>{meta.label}</div>
                    <div className="mono" style={{
                      fontSize: 'var(--text-2xl)',
                      fontWeight: 700,
                      color: meta.color,
                      letterSpacing: '-0.02em',
                      lineHeight: 1.1,
                    }}>
                      {Number(v).toLocaleString()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card" style={{ overflow: 'auto' }}>
            <table className="dt">
              <thead>
                <tr>
                  <th>资产</th>
                  <th>状态</th>
                  <th>CPU</th>
                  <th>内存</th>
                  <th>引用</th>
                  <th>拉起时间</th>
                  <th>最近使用</th>
                  <th>实例键</th>
                  <th style={{ width: 90 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {(instances.data?.instances ?? []).map((i) => (
                  <tr key={i.key}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{i.serverName ?? <span className="mono">{i.serverId.slice(0, 10)}</span>}</div>
                      <div className="mono" style={{ color: 'var(--meta)', fontSize: 11 }}>{i.serverId.slice(0, 12)}</div>
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-block',
                        fontSize: 'var(--text-xs)', fontWeight: 550,
                        padding: '3px 10px', borderRadius: 6,
                        background: i.state === 'ready' ? 'var(--success-soft)' : i.state === 'spawning' ? 'var(--warn-soft)' : 'var(--surface-raise)',
                        color: i.state === 'ready' ? 'var(--success)' : i.state === 'spawning' ? 'var(--warn)' : 'var(--muted)',
                      }} title={i.error}>
                        {i.state}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{fmtCpu(i.cpuPercent)}</td>
                    <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{fmtBytes(i.rssBytes)}</td>
                    <td style={{ fontSize: 'var(--text-sm)' }}>{i.refs}</td>
                    <td className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{fmtTs(i.spawnedAt)}</td>
                    <td className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{fmtTs(i.lastUsed)}</td>
                    <td className="mono" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11, color: 'var(--meta)' }} title={i.key}>{i.key}</td>
                    <td>
                      {confirming === i.key ? (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-danger" style={{ padding: '1px 6px', fontSize: 11 }} disabled={close.isPending} onClick={() => close.mutate(i.key)}>
                            {close.isPending ? '关闭中…' : '确认'}
                          </button>
                          <button className="btn" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => setConfirming(null)}>取消</button>
                        </span>
                      ) : (
                        <button
                          className="btn"
                          style={{ padding: '2px 8px', fontSize: 12, gap: 4 }}
                          title="强制关闭该实例；正在使用它的调用会失败"
                          onClick={() => setConfirming(i.key)}
                        >
                          <Power size={12} strokeWidth={1.8} /> 关闭
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(instances.data?.instances ?? []).length === 0 && (
            <div className="empty">
              <Server size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
              <div>暂无运行实例</div>
              <div className="hint">实例将在首次工具调用时自动拉起</div>
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: 4 }}>长连接池</h2>
            <p style={{ color: 'var(--muted)', margin: '0 0 12px', fontSize: 'var(--text-sm)' }}>
              Redis / Kafka 为有状态长连接：活跃 = 正被调用使用，空闲 = 连接仍打开但无调用（到期自动回收）
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
              {longPools.map((p) => {
                const available = p.data?.available !== false;
                return (
                  <div key={p.key} className="card" style={{ padding: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>{p.label}</span>
                      <span style={{ fontSize: 'var(--text-xs)', color: available ? 'var(--success)' : 'var(--muted)' }}>
                        {available ? '已启用' : '未启用'}
                      </span>
                    </div>
                    {available ? (
                      <div style={{ display: 'flex', gap: 24 }}>
                        {[
                          { label: '活跃', value: p.data?.active ?? 0, color: 'var(--accent)' },
                          { label: '空闲', value: p.data?.idle ?? 0, color: 'var(--warn)' },
                          { label: '总计', value: p.data?.total ?? 0, color: 'var(--fg)' },
                        ].map((it) => (
                          <div key={it.label}>
                            <div style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', marginBottom: 2 }}>{it.label}</div>
                            <div className="mono" style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: it.color, lineHeight: 1.1 }}>
                              {it.value}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="hint" style={{ fontSize: 'var(--text-sm)' }}>该品类尚未注册连接器</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
