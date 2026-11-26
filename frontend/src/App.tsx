/**
 * 管理端 SPA 壳（hash 路由——server 侧 default-deny 只需放行 / 与 /assets/*，§8.5/决策记录）。
 * 现代开发者工具质感（Linear / Vercel / Railway）：240/64 可折叠侧栏 + 顶栏（面包屑 / ⌘K / 环境标识 / 通知）。
 */
import { HashRouter, Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Server, KeyRound, Users2, ScrollText, ShieldCheck, SlidersHorizontal,
  Wrench, Activity, UserCog, LogOut, Store, Sun, Moon, MonitorSmartphone, Search,
  Bell, PanelLeftClose, PanelLeftOpen, Menu, type LucideIcon,
} from 'lucide-react';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { ToastProvider } from './components/Toast';
import CommandPalette from './components/CommandPalette';
import ChangePasswordModal from './components/ChangePasswordModal';
import { api } from './api';
import Login from './pages/Login';

// 路由级代码分割（T7）：首屏只加载壳 + 概览，其余页面按需拉取
const Overview = lazy(() => import('./pages/Overview'));
const Assets = lazy(() => import('./pages/Assets'));
const AssetDetail = lazy(() => import('./pages/AssetDetail'));
const Credentials = lazy(() => import('./pages/Credentials'));
const CredentialDetail = lazy(() => import('./pages/CredentialDetail'));
const Groups = lazy(() => import('./pages/Groups'));
const GroupDetail = lazy(() => import('./pages/GroupDetail'));
const Audit = lazy(() => import('./pages/Audit'));
const GuardRules = lazy(() => import('./pages/GuardRules'));
const Settings = lazy(() => import('./pages/Settings'));
const NativeTools = lazy(() => import('./pages/NativeTools'));
const Runtime = lazy(() => import('./pages/Runtime'));
const Users = lazy(() => import('./pages/Users'));
const Market = lazy(() => import('./pages/Market'));
const MarketEntries = lazy(() => import('./pages/MarketEntries'));
const MarketDetail = lazy(() => import('./pages/MarketDetail'));
const ApiKeys = lazy(() => import('./pages/ApiKeys'));

/**
 * 导航按角色过滤：管理端的「运行时参数 / 原生工具 / 运行时 / 成员」四页都是 admin-only，
 * 后端已按 accessMode 拒绝，前端再放出来只会让成员点进去吃 403。
 * 安全策略对成员同样可见：成员可以为自己拥有的资产创建资产级策略并随时开关，
 * 管理员与内置规则在页面上对成员只读（服务端同样拒绝改删）。
 *
 * 文案统一为 2 字（2026-11-18 用户反馈：长短不一导致侧栏参差）：
 * 完整名称放 `full`，用于折叠态悬停提示与面包屑，菜单本身保持等宽。
 */
const NAV: Array<{ to: string; label: string; full: string; icon: LucideIcon; adminOnly?: boolean }> = [
  { to: '/overview', label: '概览', full: '概览', icon: LayoutDashboard },
  { to: '/assets', label: '资产', full: '资产', icon: Server },
  { to: '/market', label: '市场', full: 'Market 目录', icon: Store },
  { to: '/credentials', label: '凭证', full: '凭证', icon: KeyRound },
  { to: '/groups', label: '分组', full: '分组', icon: Users2 },
  { to: '/audit', label: '审计', full: '审计日志', icon: ScrollText },
  { to: '/guard-rules', label: '策略', full: '安全策略', icon: ShieldCheck },
  { to: '/settings', label: '参数', full: '运行时参数', icon: SlidersHorizontal, adminOnly: true },
  { to: '/native-tools', label: '原生', full: '原生工具', icon: Wrench, adminOnly: true },
  { to: '/runtime', label: '实例', full: '运行时实例', icon: Activity, adminOnly: true },
  { to: '/users', label: '成员', full: '成员', icon: UserCog, adminOnly: true },
  { to: '/api-keys', label: '密钥', full: '我的 API Key', icon: KeyRound },
];

const THEME_ICON = { system: MonitorSmartphone, light: Sun, dark: Moon } as const;
const THEME_LABEL = { system: '跟随系统', light: '亮色', dark: '暗色' } as const;

/** 顶栏环境标识：前端常量（不新增后端接口），按构建期环境变量取值 */
const ENV_NAME = (import.meta.env.VITE_OPSGATE_ENV as string | undefined) ?? 'prod';
const ENV_META: Record<string, { cls: string; text: string }> = {
  prod: { cls: 'env-prod', text: '生产' },
  staging: { cls: 'env-staging', text: '预发' },
  dev: { cls: 'env-dev', text: '开发' },
};

function ThemeToggle() {
  const { mode, cycle } = useTheme();
  const Icon = THEME_ICON[mode];
  return (
    <button className="icon-btn" onClick={cycle} title={`主题：${THEME_LABEL[mode]}（点击切换）`} aria-label={`主题：${THEME_LABEL[mode]}`}>
      <Icon size={15} strokeWidth={1.8} />
    </button>
  );
}

/** 通知铃：数据源为现有 /audit 最近高危事件（不新增后端接口） */
function NotificationBell() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  // 已读水位（localStorage 持久化）：只计"该时间之后"的高危事件为未读，点开面板即更新
  const [lastReadTs, setLastReadTs] = useState<number>(() => Number(localStorage.getItem('opsgate-notify-read-ts') ?? 0) || 0);
  const q = useQuery({
    queryKey: ['notify-highrisk'],
    queryFn: () => api<{ items: Array<Record<string, unknown>>; total: number }>('/api/v1/audit?risk=high&page=1'),
    refetchInterval: 60_000,
  });
  const items = q.data?.items ?? [];
  // 角标 = 当页高危事件中 ts 晚于已读水位的条数（不是全历史 total，否则只增不减）
  const unread = items.filter((it) => Number(it.ts ?? 0) > lastReadTs).length;
  const count = unread;
  const markRead = () => {
    const now = Date.now();
    setLastReadTs(now);
    localStorage.setItem('opsgate-notify-read-ts', String(now));
  };
  return (
    <div style={{ position: 'relative' }}>
      <button
        className="icon-btn"
        onClick={() => { setOpen((v) => !v); if (!open) markRead(); }}
        title="最近高危事件"
        aria-label={`通知（${count} 条未读高危）`}
      >
        <Bell size={15} strokeWidth={1.8} />
        {count > 0 && <span className="count">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <>
          <div className="scrim" style={{ background: 'transparent' }} onClick={() => setOpen(false)} aria-hidden />
          <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 320, zIndex: 120, padding: 0, boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 'var(--text-sm)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>最近高危事件</span>
              <button
                onClick={markRead}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 'var(--text-xs)', cursor: 'pointer', padding: 0 }}
                title="全部标为已读"
              >
                全部已读
              </button>
            </div>
            <div style={{ maxHeight: 300, overflow: 'auto', padding: 6 }}>
              {items.length === 0 && <div style={{ padding: 12, color: 'var(--meta)', fontSize: 'var(--text-sm)', textAlign: 'center' }}>暂无高危事件</div>}
              {items.slice(0, 8).map((it, i) => (
                <button
                  key={String(it.id ?? i)}
                  className="palette-item"
                  style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left' }}
                  onClick={() => {
                    setOpen(false);
                    nav(it.server_id ? `/audit?asset=${String(it.server_id)}` : '/audit');
                  }}
                >
                  {Number(it.ts ?? 0) > lastReadTs && (
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)', flexShrink: 0, marginRight: 6 }} aria-label="未读" />
                  )}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {String(it.username ?? '—')} · {String(it.tool ?? it.action ?? '')}
                  </span>
                  <span className="mono" style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                    {it.ts ? new Date(Number(it.ts)).toLocaleTimeString('zh-CN', { hour12: false }) : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SessionGuard({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<{ user: { username: string; isAdmin?: boolean } } | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('opsgate-sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const nav = useNavigate();
  const location = useLocation();

  useEffect(() => {
    localStorage.setItem('opsgate-sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  useEffect(() => {
    let alive = true;
    fetch('/api/v1/auth/get-session', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j?.session) setMe(j);
        else nav('/login', { replace: true });
      })
      .catch(() => alive && nav('/login', { replace: true }));
    return () => { alive = false; };
  }, [location.pathname, location.hash, nav]);

  // ⌘/Ctrl+K 打开命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 路由变化关闭移动端抽屉
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const isAdmin = me?.user.isAdmin === true;
  /** 当前角色可见的导航（admin 见全部；成员不见 admin-only 项） */
  const navItems = useMemo(() => NAV.filter((n) => !n.adminOnly || isAdmin), [isAdmin]);

  const currentNav = useMemo(() => navItems.find((n) => location.pathname.startsWith(n.to))?.full ?? '概览', [location.pathname, navItems]);

  // 成员直接输 URL 访问 admin-only 页面 → 回概览（后端也会 403，这里避免空白页）
  useEffect(() => {
    if (!me) return;
    const hit = NAV.find((n) => n.adminOnly && location.pathname.startsWith(n.to));
    if (hit && !isAdmin) nav('/overview', { replace: true });
  }, [me, isAdmin, location.pathname, nav]);

  const crumbLeaf = useMemo(() => {
    const p = location.pathname;
    if (/^\/assets\/.+/.test(p)) return '资产详情';
    if (/^\/credentials\/.+/.test(p)) return '凭证详情';
    if (/^\/groups\/.+/.test(p)) return '分组详情';
    if (/^\/market\/entries/.test(p)) return '目录管理';
    if (/^\/market\/.+/.test(p)) return '条目详情';
    return null;
  }, [location.pathname]);

  if (!me) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 30, height: 30, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</span>
      </div>
    </div>
  );

  const env = ENV_META[ENV_NAME] ?? ENV_META.prod!;
  const signOut = () => fetch('/api/v1/auth/sign-out', { method: 'POST', credentials: 'include' }).finally(() => nav('/login'));

  return (
    <div className="app-shell">
      {mobileOpen && <div className="scrim" onClick={() => setMobileOpen(false)} aria-hidden />}
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-logo">O</div>
          {!collapsed && <span className="sidebar-brand-text">OpsGate</span>}
          {/* 折叠开关跟随品牌行（用户要求：放在 OpsGate 右侧、居右） */}
          <button
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          >
            {collapsed ? <PanelLeftOpen size={15} strokeWidth={1.8} /> : <PanelLeftClose size={15} strokeWidth={1.8} />}
          </button>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(({ to, label, full, icon: Icon }) => (
            <NavLink key={to} to={to} className="nav-item" title={collapsed ? full : full !== label ? full : undefined}>
              <Icon size={16} strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar">{me.user.username[0]?.toUpperCase()}</div>
            {!collapsed && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 550, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{me.user.username}</div>
                {me.user.isAdmin && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)' }}>管理员</div>}
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setMobileOpen((v) => !v)} aria-label="打开菜单" style={{ display: 'none' }} data-mobile-only>
            <Menu size={16} strokeWidth={1.8} />
          </button>
          <div className="topbar-crumbs">
            <span>{currentNav}</span>
            {crumbLeaf && <><span aria-hidden>/</span><span className="crumb-current">{crumbLeaf}</span></>}
          </div>
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            <button
              className="btn"
              onClick={() => setPaletteOpen(true)}
              style={{ gap: 6, padding: '6px 10px', minHeight: 30, color: 'var(--muted)' }}
              title="搜索（⌘K）"
            >
              <Search size={14} strokeWidth={1.8} />
              <span style={{ fontSize: 'var(--text-sm)' }}>搜索</span>
              <kbd className="mono" style={{ fontSize: 10, border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px', color: 'var(--meta)' }}>⌘K</kbd>
            </button>
            <span className={`env-badge ${env.cls}`} title="当前部署环境">
              <span className="dot" />{env.text}
            </span>
            <NotificationBell />
            {/* 主题 / 改密 / 退出从侧栏挪到顶栏（用户要求），与搜索、环境标识同排 */}
            <span style={{ width: 1, height: 20, background: 'var(--border)' }} aria-hidden />
            <ThemeToggle />
            <button className="icon-btn" onClick={() => setPwdOpen(true)} title="修改密码" aria-label="修改密码">
              <KeyRound size={15} strokeWidth={1.8} />
            </button>
            <button className="icon-btn" onClick={signOut} title="退出登录" aria-label="退出登录">
              <LogOut size={15} strokeWidth={1.8} />
            </button>
          </div>
        </header>
        <main className="main-content animate-fade-in">
          <Suspense fallback={<div style={{ padding: 32, color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</div>}>
            {children}
          </Suspense>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} navItems={navItems} />
      {pwdOpen && <ChangePasswordModal onClose={() => setPwdOpen(false)} />}
    </div>
  );
}

const wrap = (el: ReactNode) => <SessionGuard>{el}</SessionGuard>;

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <HashRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={wrap(<Overview />)} />
            <Route path="/overview" element={wrap(<Overview />)} />
            <Route path="/assets" element={wrap(<Assets />)} />
            <Route path="/assets/:id" element={wrap(<AssetDetail />)} />
            <Route path="/market" element={wrap(<Market />)} />
            <Route path="/market/entries" element={wrap(<MarketEntries />)} />
            <Route path="/market/:key" element={wrap(<MarketDetail />)} />
            <Route path="/credentials" element={wrap(<Credentials />)} />
            <Route path="/credentials/:id" element={wrap(<CredentialDetail />)} />
            <Route path="/groups" element={wrap(<Groups />)} />
            <Route path="/groups/:id" element={wrap(<GroupDetail />)} />
            <Route path="/audit" element={wrap(<Audit />)} />
            <Route path="/guard-rules" element={wrap(<GuardRules />)} />
            <Route path="/settings" element={wrap(<Settings />)} />
            <Route path="/native-tools" element={wrap(<NativeTools />)} />
            <Route path="/runtime" element={wrap(<Runtime />)} />
            <Route path="/users" element={wrap(<Users />)} />
            <Route path="/api-keys" element={wrap(<ApiKeys />)} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </HashRouter>
      </ToastProvider>
    </ThemeProvider>
  );
}
