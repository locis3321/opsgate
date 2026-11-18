import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, UserCog, ShieldCheck, User, KeyRound } from 'lucide-react';
import { api, ApiError, fmtTs } from '../api';
import Modal from '../components/Modal';
import Combobox from '../components/Combobox';
import { useToast } from '../components/Toast';

interface UserItem {
  id: string; username: string; name: string | null;
  isAdmin: boolean;
  /** ADR-028 §2.5：禁用只阻断 Web UI 登录，不阻断 MCP */
  isDisabled?: boolean;
  createdAt: number | null;
}

interface Me { id: string; isAdmin: boolean }

/** 成员管理（两态身份：管理员/成员，无角色矩阵——§8.5 P0）。 */
export default function Users() {
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<UserItem[]>('/api/v1/users') });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username, password }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      setOpen(false);
      setUsername(''); setPassword(''); setErr('');
    },
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  /** 重置密码弹窗的目标成员（用户决策：管理员只重置密码，不改用户名） */
  const [pwdTarget, setPwdTarget] = useState<UserItem | null>(null);
  const [newPwd, setNewPwd] = useState('');
  const [pwdErr, setPwdErr] = useState('');
  const toast = useToast();
  // 当前登录者：用于禁止对自己禁用/删除（服务端同样拦截，这里只是提前提示）
  const me = useQuery({
    queryKey: ['session-me'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { id?: string; isAdmin?: boolean } };
      return { id: j?.user?.id ?? '', isAdmin: Boolean(j?.user?.isAdmin) } as Me;
    },
    staleTime: 60_000,
  });

  const patch = useMutation({
    mutationFn: (v: { id: string; isAdmin?: boolean; isDisabled?: boolean }) =>
      api(`/api/v1/users/${v.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(v.isAdmin !== undefined ? { isAdmin: v.isAdmin } : {}),
          ...(v.isDisabled !== undefined ? { isDisabled: v.isDisabled } : {}),
        }),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); setErr(''); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '操作失败'),
  });
  const resetPwd = useMutation({
    mutationFn: (v: { id: string; password: string }) =>
      api(`/api/v1/users/${v.id}`, { method: 'PATCH', body: JSON.stringify({ password: v.password }) }),
    onSuccess: () => {
      toast.success(`已重置「${pwdTarget?.username ?? ''}」的密码，其登录会话已失效`);
      setPwdTarget(null);
      setNewPwd(''); setPwdErr('');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => setPwdErr(e instanceof ApiError ? e.message : '重置失败'),
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      api<{ orphanedCredentials: number; orphanedServers: number }>(`/api/v1/users/${id}`, { method: 'DELETE' }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      setConfirming(null);
      setErr(
        d.orphanedCredentials + d.orphanedServers > 0
          ? `已删除。其 ${d.orphanedCredentials} 个凭证与 ${d.orphanedServers} 个资产已转为无主状态，可在对应页面重新指派归属`
          : '',
      );
    },
    onError: (e) => { setErr(e instanceof ApiError ? e.message : '删除失败'); setConfirming(null); },
  });

  return (
    <div className="page animate-slide-up">
      <div>
        <div className="page-header">
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>成员</h1>
          <button className="btn btn-primary" onClick={() => { setOpen(true); setErr(''); setUsername(''); setPassword(''); }}>
            <Plus size={14} strokeWidth={2} /> 创建账号
          </button>
        </div>
        <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
          管理运维人员账号，区分管理员与成员身份；禁用只阻断 Web 登录，不影响其 API Key 的 MCP 调用
        </p>
        {err && !open && (
          <div style={{ marginTop: 8, color: err.startsWith('已删除') ? 'var(--muted)' : 'var(--danger)', fontSize: 'var(--text-sm)' }}>
            {err}
          </div>
        )}
      </div>

      {open && (
        <Modal title="创建成员账号" onClose={() => setOpen(false)}>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>用户名</label>
            <input className="input" placeholder="小写字母数字" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>密码</label>
            <input className="input" type="password" placeholder="至少 10 位" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create.mutate()} />
          </div>
          {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setOpen(false)}>取消</button>
            <button className="btn btn-primary" onClick={() => create.mutate(undefined, { onError: (e) => setErr(e instanceof ApiError ? e.message : '创建失败') })}>
              创建
            </button>
          </div>
        </Modal>
      )}

      {pwdTarget && (
        <Modal title={`重置「${pwdTarget.username}」的密码`} onClose={() => setPwdTarget(null)}>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>新密码（至少 10 位）</label>
            <input
              className="input"
              type="password"
              autoFocus
              autoComplete="new-password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newPwd.length >= 10) resetPwd.mutate({ id: pwdTarget.id, password: newPwd }); }}
            />
          </div>
          <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>
            重置后该成员当前所有登录会话立即失效，需要用新密码重新登录；其 API Key 与 MCP 调用不受影响。
          </div>
          {pwdErr && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{pwdErr}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setPwdTarget(null)} disabled={resetPwd.isPending}>取消</button>
            <button
              className="btn btn-primary"
              disabled={newPwd.length < 10 || resetPwd.isPending}
              onClick={() => resetPwd.mutate({ id: pwdTarget.id, password: newPwd })}
            >
              {resetPwd.isPending ? '重置中…' : '确认重置'}
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
      ) : (q.data ?? []).length === 0 ? (
        <div className="empty">
          <UserCog size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
          <div>暂无成员</div>
          <div className="hint">点击"创建账号"添加第一位成员</div>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="dt">
            <thead>
              <tr>
                <th>用户</th>
                <th>身份</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((u) => (
                <tr key={u.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: '50%',
                        background: u.isAdmin ? 'var(--accent-soft)' : 'var(--surface-raise)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {u.isAdmin
                          ? <ShieldCheck size={14} style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
                          : <User size={14} style={{ color: 'var(--muted)' }} strokeWidth={1.8} />}
                      </div>
                      <span className="mono" style={{ fontWeight: 500 }}>{u.username}</span>
                    </div>
                  </td>
                  <td>
                    <div style={{ minWidth: 110 }}>
                      <Combobox
                        ariaLabel={`${u.username} 的身份`}
                        value={u.isAdmin ? 'admin' : 'member'}
                        onChange={() => patch.mutate({ id: u.id, isAdmin: !u.isAdmin })}
                        disabled={u.id === me.data?.id}
                        options={[{ value: 'admin', label: '管理员' }, { value: 'member', label: '成员' }]}
                      />
                    </div>
                  </td>
                  <td>
                    {u.isDisabled
                      ? <span className="badge-warn">已禁用</span>
                      : <span className="badge-success">正常</span>}
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{fmtTs(u.createdAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {confirming !== u.id ? (
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          className="btn"
                          title="为该成员设置新密码；重置后其所有登录会话立即失效"
                          onClick={() => { setPwdTarget(u); setNewPwd(''); setPwdErr(''); }}
                        >
                          <KeyRound size={12} strokeWidth={1.8} /> 重置密码
                        </button>
                        <button
                          className="btn"
                          disabled={u.id === me.data?.id}
                          title={u.isDisabled ? '恢复该成员登录能力' : '禁用后仅阻断 Web 登录，MCP 调用不受影响'}
                          onClick={() => patch.mutate({ id: u.id, isDisabled: !u.isDisabled })}
                        >
                          {u.isDisabled ? '启用' : '禁用'}
                        </button>
                        <button
                          className="btn btn-danger"
                          disabled={u.id === me.data?.id}
                          onClick={() => setConfirming(u.id)}
                        >
                          删除
                        </button>
                      </div>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ color: 'var(--danger)', fontSize: 12 }}>
                          确认删除「{u.username}」？其凭证/资产将转为无主，等待重新指派
                        </span>
                        <button className="btn btn-danger" onClick={() => del.mutate(u.id)}>确认</button>
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
    </div>
  );
}
