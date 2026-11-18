import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ApiError } from '../api';
import Modal from './Modal';

/**
 * 修改自己的密码（任何登录用户）。
 *
 * 走 better-auth 自带端点 `POST /api/v1/auth/change-password`（已被 `ALL /api/v1/auth/*`
 * 的 session 路由覆盖，无需新增后端路由）。
 * 注意：better-auth 改密默认吊销其他会话；这里显式 revokeOtherSessions=true，
 * 让"改密 = 把其他设备踢下线"这一预期成立。
 */
export default function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    if (next.length < 10) { setErr('新密码至少 10 位'); return; }
    if (next !== confirm) { setErr('两次输入的新密码不一致'); return; }
    setBusy(true);
    try {
      // better-auth 端点返回非统一信封，直接 fetch 并读状态
      const r = await fetch('/api/v1/auth/change-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next, revokeOtherSessions: true }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; code?: string };
        // 常见错误码→人话：原密码错 / 太短
        const msg = j.message ?? '';
        if (/invalid password|incorrect/i.test(msg) || j.code === 'INVALID_PASSWORD') setErr('当前密码不正确');
        else setErr(msg || `修改失败（HTTP ${r.status}）`);
        return;
      }
      setDone(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '网络错误，修改未生效');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="修改密码" onClose={onClose}>
      {done ? (
        <>
          <div style={{ color: 'var(--fg-2)', fontSize: 'var(--text-sm)' }}>密码已修改，其他设备的登录会话已失效。</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={onClose}>完成</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'grid', gap: 8 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>当前密码</label>
            <input className="input" type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>新密码（至少 10 位）</label>
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>确认新密码</label>
            <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
          </div>
          {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose} disabled={busy}>取消</button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !current || !next}>
              <KeyRound size={13} strokeWidth={1.8} /> {busy ? '提交中…' : '确认修改'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
