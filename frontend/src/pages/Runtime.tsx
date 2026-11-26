import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Server, CheckCircle, Loader2, Scale, RefreshCw, Power, SquareTerminal, OctagonX } from 'lucide-react';
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

/** 在飞 CLI 执行（内存登记表，进程退出即移除） */
interface CliRun {
  runId: string; assetId: string; pid: number | null;
  argvSummary: string; userId: string; startedAt: number; sandboxed: boolean;
}
/** CLI 健康检查状态（服务端口径；覆盖全部 cli 资产，不只是在飞的） */
type CliHealthStatus = 'healthy' | 'bin-missing' | 'not-executable' | 'sandbox-unavailable' | 'slots-unbound';
interface CliRuntime {
  /** 执行器是否装配。false 时 runs/stats/health 全空，与「装配了但零在飞」同形，必须靠它区分 */
  available: boolean;
  runs: CliRun[];
  stats: { active: number; total: number };
  health: Array<{ assetId: string; name: string; status: CliHealthStatus }>;
}

const CLI_HEALTH_META: Record<CliHealthStatus, { label: string; kind: 'success' | 'warn' | 'error' | 'info'; hint: string }> = {
  healthy: { label: '可用', kind: 'success', hint: '二进制可执行，且（开启时）沙箱可用' },
  'bin-missing': { label: '二进制缺失', kind: 'error', hint: 'command 不在 PATH，或槽位/配置里填了不存在的路径' },
  'not-executable': { label: '不可执行', kind: 'error', hint: '文件存在但没有可执行位，或该路径是目录' },
  'sandbox-unavailable': { label: '沙箱不可用', kind: 'error', hint: 'bwrap 不可用：CLI 执行会显式失败，不降级' },
  'slots-unbound': { label: '槽位未绑', kind: 'warn', hint: '必需槽位未绑定凭证' },
};

/** 运行时长（毫秒 → 人可读）；跑得久的进程是这个区块最需要被看见的信息 */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
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

/** 运行时：实例池 + 长连接池 + CLI 一次性执行（双池并列展示，§8.5；CLI 见 ADR-037）。 */
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

  // CLI 一次性执行（ADR-037）：在飞进程 + 装配事实 + 全量 cli 资产健康
  const cli = useQuery({
    queryKey: ['rt-cli'],
    queryFn: () => api<CliRuntime>('/api/v1/runtime/cli'),
    refetchInterval: 5000,
  });
  const [killing, setKilling] = useState<string | null>(null);
  const killCli = useMutation({
    mutationFn: (runId: string) =>
      api<{ killed: boolean }>(`/api/v1/runtime/cli/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setKilling(null);
      // kill 只发 SIGTERM，登记要等进程 close 才移除：立即失效查询，让下一轮 5s 轮询看到真实状态
      toast.success('已发出终止信号（SIGTERM，超时后升级 SIGKILL）');
      void qc.invalidateQueries({ queryKey: ['rt-cli'] });
    },
    onError: (e) => {
      setKilling(null);
      // 404 = 进程已自行结束；这不是失败，是"你看到的列表已过期"
      if (e instanceof ApiError && e.status === 404) {
        toast.info(e.message || '该 CLI 运行已结束');
        void qc.invalidateQueries({ queryKey: ['rt-cli'] });
        return;
      }
      toast.error(e instanceof ApiError ? e.message : '终止失败');
    },
  });
  const cliAvailable = cli.data?.available === true;
  const cliRuns = cli.data?.runs ?? [];
  /** runId → 资产名：health 覆盖全部 cli 资产，复用它做名称映射，省一次请求 */
  const cliAssetNames = new Map((cli.data?.health ?? []).map((h) => [h.assetId, h.name]));
  const cliStats = cli.data?.stats ?? { active: 0, total: 0 };
  const cliHealth = cli.data?.health ?? [];

  return (
    <div className="page animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>运行时</h1>
          <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
            实例池、连接池与 CLI 执行实时状态，展示资源分配与使用情况（每 5 秒自动刷新）
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

          {/* CLI 一次性执行（ADR-037）：与实例池/长连接池语义都不同——进程起完即走，没有 ready 态，
              所以在飞清单与"资产是否跑得起来"的健康快照要分开呈现。 */}
          <div style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: 4 }}>CLI 执行</h2>
            <p style={{ color: 'var(--muted)', margin: '0 0 12px', fontSize: 'var(--text-sm)' }}>
              网关本机一次性子进程（argv 直执行，不经 shell）。在飞清单每 5 秒刷新，可强制终止；「终止」只发信号，进程退出后自动从列表移除。
            </p>

            {cli.isLoading ? (
              <div className="card" style={{ padding: 20, color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载 CLI 运行状态…</div>
            ) : cli.isError ? (
              <div className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
                <span style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
                  CLI 运行状态加载失败：{cli.error instanceof ApiError ? cli.error.message : '请求失败'}
                </span>
                <button className="btn" style={{ justifySelf: 'start', gap: 6 }} onClick={() => void cli.refetch()}>
                  <RefreshCw size={13} strokeWidth={1.8} /> 重试
                </button>
              </div>
            ) : !cliAvailable ? (
              /* 未装配执行器：不伪造"有执行器但零在飞"（空表是同形），显式说明原因 */
              <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <OctagonX size={16} strokeWidth={1.8} style={{ color: 'var(--meta)', marginTop: 1, flexShrink: 0 }} />
                <div style={{ display: 'grid', gap: 2 }}>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 550 }}>CLI 执行器未启用</span>
                  <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
                    本实例未装配 CliRunner，cli 资产无法执行；在飞清单为空不代表"当前没有执行"。请检查部署配置。
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 16 }}>
                <div className="card" style={{ padding: 20, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  {[
                    { label: '在飞', value: cliStats.active, color: cliStats.active > 0 ? 'var(--accent)' : 'var(--fg)' },
                    { label: '累计执行', value: cliStats.total, color: 'var(--fg)' },
                  ].map((it) => (
                    <div key={it.label}>
                      <div style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', marginBottom: 2 }}>{it.label}</div>
                      <div className="mono" style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: it.color, lineHeight: 1.1 }}>
                        {it.value}
                      </div>
                    </div>
                  ))}
                  <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', alignSelf: 'flex-end', marginLeft: 'auto' }}>
                    累计计数自本进程启动起算（重启归零）
                  </div>
                </div>

                <div className="card" style={{ overflow: 'auto' }}>
                  {cliRuns.length === 0 ? (
                    <div className="empty" style={{ border: 'none', borderRadius: 0 }}>
                      <SquareTerminal size={30} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
                      <div>暂无在飞 CLI 执行</div>
                      <div className="hint">CLI 调用是一次性进程：只有正在执行的调用才会出现在这里</div>
                    </div>
                  ) : (
                    <table className="dt">
                      <thead>
                        <tr>
                          <th>资产</th>
                          <th>argv 摘要</th>
                          <th>操作者</th>
                          <th>已运行</th>
                          <th>沙箱</th>
                          <th style={{ width: 100 }}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cliRuns.map((r) => {
                          const pending = killing === r.runId && killCli.isPending;
                          return (
                            <tr key={r.runId}>
                              <td>
                                <div style={{ fontWeight: 500 }}>
                                  {cliAssetNames.get(r.assetId) ?? <span className="mono">{r.assetId.slice(0, 10)}</span>}
                                </div>
                                <div className="mono" style={{ color: 'var(--meta)', fontSize: 11 }} title={r.runId}>
                                  {r.pid === null ? 'pid —' : `pid ${r.pid}`}
                                </div>
                              </td>
                              <td className="mono" style={{ fontSize: 'var(--text-sm)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.argvSummary}>
                                {r.argvSummary || '—'}
                              </td>
                              <td className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }} title={r.userId}>
                                {r.userId.slice(0, 12)}
                              </td>
                              <td className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }} title={fmtTs(r.startedAt)}>
                                {fmtElapsed(Date.now() - r.startedAt)}
                              </td>
                              <td>
                                {r.sandboxed
                                  ? <span className="tag" title="已通过 bwrap 隔离：dataDir 被 tmpfs 遮住，凭证单独 bind">bwrap</span>
                                  : <span style={{ color: 'var(--warn)', fontSize: 'var(--text-xs)' }} title="未沙箱执行（沙箱关闭或非 Linux）">无沙箱</span>}
                              </td>
                              <td>
                                {killing === r.runId ? (
                                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
                                    <button
                                      className="btn btn-danger"
                                      style={{ padding: '1px 6px', fontSize: 11 }}
                                      disabled={pending}
                                      onClick={() => killCli.mutate(r.runId)}
                                    >
                                      {pending ? '终止中…' : '确认'}
                                    </button>
                                    <button className="btn" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => setKilling(null)}>取消</button>
                                  </span>
                                ) : (
                                  <button
                                    className="btn"
                                    style={{ padding: '2px 8px', fontSize: 12, gap: 4 }}
                                    title="强制终止该进程树（SIGTERM，宽限后 SIGKILL）；正在等结果的调用会失败"
                                    onClick={() => setKilling(r.runId)}
                                  >
                                    <Power size={12} strokeWidth={1.8} /> 终止
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>资产健康</span>
                    <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                      全部 cli 资产（含未在飞的）· 共 {cliHealth.length} 个
                    </span>
                  </div>
                  {cliHealth.length === 0 ? (
                    <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>当前没有 cli 资产</div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {cliHealth.map((h) => {
                        const meta = CLI_HEALTH_META[h.status] ?? { label: h.status, kind: 'info' as const, hint: '' };
                        const color = meta.kind === 'success' ? 'var(--success)'
                          : meta.kind === 'error' ? 'var(--danger)'
                            : meta.kind === 'warn' ? 'var(--warn)' : 'var(--muted)';
                        const bg = meta.kind === 'success' ? 'var(--success-soft)'
                          : meta.kind === 'error' ? 'var(--danger-soft)'
                            : meta.kind === 'warn' ? 'var(--warn-soft)' : 'var(--surface-raise)';
                        return (
                          <span
                            key={h.assetId}
                            title={`${h.status}：${meta.hint}`}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                              padding: '3px 10px', borderRadius: 6, background: bg, color,
                              fontSize: 'var(--text-xs)', fontWeight: 550,
                            }}
                          >
                            <span className="mono" style={{ color: 'var(--fg-2)' }}>{h.name}</span>
                            {meta.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
                    健康按需计算（二进制在 PATH 内且可执行 + 沙箱可用）。「二进制缺失」意味着该资产当前所有调用都会失败，与 MCP 实例重建不同，这是资产本身不可用。
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
