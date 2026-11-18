import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

/** 登录页：现代深色设计；错误内联，不暴露账号存在性差异。 */
export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();
  const submit = async () => {
    setErr('');
    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/sign-in/username', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        nav('/overview');
        return;
      }
      // 服务端区分「凭据错误(401)」与「限流(429)」，此处如实展示，
      // 避免把"尝试过于频繁"误显示成密码错误而反复重试
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(body?.message ?? '用户名或密码不正确');
    } finally {
      setLoading(false);
    }
  };
  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* 背景装饰 */}
      <div style={{
        position: 'absolute',
        top: '20%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 600,
        height: 600,
        borderRadius: '50%',
        background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)',
        filter: 'blur(80px)',
        opacity: 0.4,
        pointerEvents: 'none',
      }} />

      <div className="card animate-scale-in" style={{
        width: 380,
        padding: 36,
        position: 'relative',
        boxShadow: 'var(--shadow-lg)',
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, fontWeight: 700, color: 'var(--accent-on)',
          }}>O</div>
          <div>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 650, color: 'var(--fg)', letterSpacing: '-0.02em' }}>OpsGate</div>
            <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>运维 MCP 控制台</div>
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--border)', margin: '20px 0' }} />

        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>用户名</label>
            <input
              className="input"
              placeholder="请输入用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>密码</label>
            <input
              className="input"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !loading && void submit()}
            />
          </div>
          {err && (
            <div style={{
              color: 'var(--danger)',
              fontSize: 'var(--text-sm)',
              padding: '8px 12px',
              background: 'var(--danger-soft)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--danger)',
            }}>{err}</div>
          )}
          <button
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={loading || !username || !password}
            style={{ width: '100%', justifyContent: 'center', minHeight: 40, marginTop: 4, fontSize: 'var(--text-base)' }}
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
