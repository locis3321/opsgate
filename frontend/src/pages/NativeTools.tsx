import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wrench, AlertCircle } from 'lucide-react';
import { api, ApiError } from '../api';

interface NativeTool {
  id: string; name: string; category: string; connector: string; risk: string;
  enabled: boolean; hitCount: number;
}

/** 原生工具管理（Spec §8.5 `/native-tools`，admin）：清单 + 命中次数 + 启用开关（§5.9.5 停用即从 tools/list 移除）。 */
export default function NativeTools() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['native-tools'],
    queryFn: () => api<NativeTool[]>('/api/v1/native-tools'),
  });
  const toggle = useMutation({
    mutationFn: (t: NativeTool) => api(`/api/v1/native-tools/${t.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !t.enabled }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['native-tools'] }); },
  });

  if (q.isError) {
    const msg = q.error instanceof ApiError ? q.error.message : String(q.error);
    return (
      <div className="page animate-slide-up">
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>原生工具</h1>
          <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
            管理系统内置原生工具，停用即从 tools/list 移除
          </p>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', borderRadius: 'var(--radius-lg)',
          background: 'var(--danger-soft)', border: '1px solid var(--danger)',
        }}>
          <AlertCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} strokeWidth={1.8} />
          <span style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
            {String(msg).includes('403') ? '仅管理员可管理原生工具（当前会话无权限）' : `加载失败：${msg}`}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="page animate-slide-up">
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>原生工具</h1>
        <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
          管理系统内置原生工具，停用即从 tools/list 移除（灰度与故障隔离）；命中次数 = 当月审计调用数
        </p>
      </div>

      {q.isLoading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
          <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</span>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="dt">
            <thead>
              <tr>
                <th>暴露名</th>
                <th>类别</th>
                <th>连接器</th>
                <th>风险</th>
                <th>命中</th>
                <th style={{ textAlign: 'center' }}>启用</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 7,
                        background: t.enabled ? 'var(--accent-soft)' : 'var(--surface-raise)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        <Wrench size={13} style={{ color: t.enabled ? 'var(--accent)' : 'var(--meta)' }} strokeWidth={1.8} />
                      </div>
                      <span className="mono" style={{ fontWeight: 500 }}>{t.name}</span>
                    </div>
                  </td>
                  <td><span className="tag">{t.category}</span></td>
                  <td className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{t.connector}</td>
                  <td>
                    {t.risk === 'destructive'
                      ? <span className="badge-danger">destructive</span>
                      : <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{t.risk}</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{t.hitCount}</td>
                  <td style={{ textAlign: 'center' }}>
                    <button
                      onClick={() => toggle.mutate(t)}
                      title={t.enabled ? '停用后该工具从 tools/list 移除' : '重新启用'}
                      style={{
                        width: 36, height: 20, borderRadius: 10,
                        border: 'none', cursor: 'pointer',
                        background: t.enabled ? 'var(--accent)' : 'var(--surface-raise)',
                        position: 'relative',
                        transition: 'background var(--dur-fast) var(--ease)',
                        padding: 0,
                      }}
                    >
                      <span style={{
                        position: 'absolute',
                        top: 2,
                        left: t.enabled ? 18 : 2,
                        width: 16, height: 16, borderRadius: '50%',
                        background: t.enabled ? 'var(--surface)' : 'var(--muted)',
                        transition: 'left var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)',
                        boxShadow: 'var(--shadow-sm)',
                      }} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(q.data ?? []).length === 0 && !q.isLoading && (
        <div className="empty">
          <Wrench size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
          <div>暂无原生工具</div>
        </div>
      )}
    </div>
  );
}
