import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2, Copy, Check, Terminal, Info, RefreshCw, Ban } from 'lucide-react';
import { api, ApiError, fmtTs } from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../components/Toast';

interface ApiKeyRow {
  id: string;
  name: string;
  clientName: string | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/**
 * 我的 API Key：连接 OpsGate MCP 的唯一凭据（Bearer，`ogk_live_` 前缀）。
 * 明文只在签发时返回一次——这是安全设计，丢了只能重新签发，不能查看。
 *
 * 吊销与删除是两个动作（2026-11-18）：吊销保留行（可追溯"曾经存在过"），
 * 只有已吊销的 Key 才能删除。
 */
export default function ApiKeys() {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [clientName, setClientName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['api-keys'], queryFn: () => api<ApiKeyRow[]>('/api/v1/api-keys') });

  const create = useMutation({
    mutationFn: () => api<ApiKeyRow & { plainKey: string }>('/api/v1/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), clientName: clientName.trim() || undefined }),
    }),
    onSuccess: (d) => {
      setIssued(d.plainKey);
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('API Key 已签发');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '签发失败'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/api-keys/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      setConfirmRevoke(null);
      toast.success('API Key 已吊销');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '吊销失败'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/v1/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      setConfirmDelete(null);
      toast.success('已删除该 API Key 记录');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '删除失败'),
  });

  const rows = q.data ?? [];
  const active = rows.filter((r) => !r.revokedAt);
  const mcpUrl = `${window.location.origin}/mcp`;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('复制失败，请手动选择文本');
    }
  };

  const closeIssue = () => { setOpen(false); setIssued(null); setName(''); setClientName(''); };

  return (
    <div className="page animate-fade-in">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, marginBottom: 4 }}>我的 API Key</h1>
          <p style={{ color: 'var(--muted)', margin: 0, fontSize: 'var(--text-sm)' }}>
            用于在 Claude Desktop / Cursor / 自建客户端中连接 OpsGate MCP 端点
          </p>
        </div>
        <button className="btn" onClick={() => { void q.refetch(); }} disabled={q.isFetching} style={{ gap: 6 }} title="重新拉取 API Key 列表">
          <RefreshCw size={14} strokeWidth={1.8} className={q.isFetching ? 'spin' : ''} /> 刷新
        </button>
        <button className="btn btn-primary" onClick={() => setOpen(true)} style={{ gap: 6 }}>
          <Plus size={15} strokeWidth={2} /> 签发新 Key
        </button>
      </div>

      {/* 连接方式说明：用户最容易卡在这一步 */}
      <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Terminal size={15} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>如何连接</span>
        </div>
        <div style={{ color: 'var(--fg-2)', fontSize: 'var(--text-sm)', lineHeight: 1.8 }}>
          MCP 端点：<span className="mono">{mcpUrl}</span>，认证方式为 <span className="mono">Authorization: Bearer &lt;你的 API Key&gt;</span>。
        </div>
        <pre className="mono" style={{
          margin: 0, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)', fontSize: 12, overflow: 'auto', color: 'var(--fg-2)',
        }}>{`// Claude Desktop / Cursor 的 mcp 配置示例
{
  "mcpServers": {
    "opsgate": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer <你的 API Key>" }
    }
  }
}`}</pre>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: 'var(--meta)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
          <Info size={13} strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>Key 明文只在签发时显示一次，平台不保存可逆副本；遗失请吊销后重新签发。每个 Key 对应一个人的审计身份。</span>
        </div>
        <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
          默认返回<b>全部可见资产</b>。需要收窄时在 URL 追加查询参数：
          <span className="mono"> ?group=&lt;分组名&gt;</span> 按分组过滤、
          <span className="mono"> ?category=&lt;k8s|mysql|host|other&gt;</span> 按品类过滤（两者可叠加取交集）。
        </div>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        {q.isLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>加载中…</div>
        ) : rows.length === 0 ? (
          <div className="empty" style={{ border: 'none', borderRadius: 0 }}>
            <KeyRound size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
            <div>还没有 API Key</div>
            <div className="hint">签发一个用于连接 MCP；泄漏时吊销即可，不影响其他 Key</div>
          </div>
        ) : (
          <table className="dt">
            <thead><tr><th>名称</th><th>客户端</th><th>状态</th><th>最后使用</th><th style={{ width: 110 }}>操作</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontWeight: 550 }}>{r.name}</td>
                  <td style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>{r.clientName || '—'}</td>
                  <td>{r.revokedAt ? <StatusBadge kind="disabled" label="已吊销" /> : <StatusBadge kind="success" label="有效" />}</td>
                  <td style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{r.lastUsedAt ? fmtTs(r.lastUsedAt) : '从未使用'}</td>
                  <td>
                    {r.revokedAt ? (
                      confirmDelete === r.id ? (
                        <span style={{ display: 'inline-flex', gap: 4, whiteSpace: 'nowrap' }}>
                          <span style={{ color: 'var(--danger)', fontSize: 11 }}>永久删除？</span>
                          <button className="btn btn-danger" style={{ padding: '2px 6px', fontSize: 11 }} disabled={del.isPending} onClick={() => del.mutate(r.id)}>
                            {del.isPending ? '删除中…' : '确认'}
                          </button>
                          <button className="btn" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => setConfirmDelete(null)}>取消</button>
                        </span>
                      ) : (
                        <button
                          className="btn btn-danger"
                          style={{ padding: '2px 8px', fontSize: 11, gap: 4 }}
                          title="从列表中永久移除这条已吊销的 Key 记录"
                          onClick={() => setConfirmDelete(r.id)}
                        >
                          <Trash2 size={11} strokeWidth={2} /> 删除
                        </button>
                      )
                    ) : confirmRevoke === r.id ? (
                      <span style={{ display: 'inline-flex', gap: 4 }}>
                        <button className="btn btn-danger" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => revoke.mutate(r.id)}>确认</button>
                        <button className="btn" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => setConfirmRevoke(null)}>取消</button>
                      </span>
                    ) : (
                      <button className="btn" style={{ padding: '2px 8px', fontSize: 11, gap: 4 }} onClick={() => setConfirmRevoke(r.id)}>
                        <Ban size={11} strokeWidth={2} /> 吊销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {active.length > 1 && (
        <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
          当前有 {active.length} 个有效 Key。一个客户端一个 Key 更利于定位来源。
        </div>
      )}

      {open && (
        <Modal
          title={issued ? 'API Key 已签发' : '签发新 API Key'}
          onClose={closeIssue}
          width={620}
          dirty={!issued && (name.trim().length > 0 || clientName.trim().length > 0)}
        >
          {issued ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warn)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                <KeyRound size={15} strokeWidth={2} /> 请立刻复制——关闭后无法再次查看
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input mono" readOnly value={issued} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn btn-primary" onClick={() => void copy(issued)} style={{ gap: 6 }}>
                  {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
                把它填到客户端配置的 <span className="mono">Authorization: Bearer</span> 中。平台只保存哈希，无法再次显示。
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn" onClick={closeIssue}>我已保存</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>名称（用于区分用途）</label>
                <input className="input" placeholder="如 claude-desktop / cursor-laptop" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>客户端名（可选）</label>
                <input className="input" placeholder="如 Claude Desktop 1.x" value={clientName} onChange={(e) => setClientName(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={closeIssue}>取消</button>
                <button className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
                  {create.isPending ? '签发中…' : '签发'}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
