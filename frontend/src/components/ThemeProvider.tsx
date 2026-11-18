import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** 主题三态：跟随系统 / 强制亮 / 强制暗。存 localStorage（'system' 时移除键） */
export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'opsgate-theme';

function systemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? systemTheme() : mode;
  document.documentElement.setAttribute('data-theme', resolved);
}

interface ThemeCtx {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
  /** 在 system → light → dark → system 之间轮转（顶栏按钮用） */
  cycle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => (readMode() === 'system' ? systemTheme() : (readMode() as 'light' | 'dark')));

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    if (m === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, m);
  }, []);

  useEffect(() => {
    applyTheme(mode);
    setResolved(mode === 'system' ? systemTheme() : mode);
    if (mode !== 'system') return;
    // 跟随系统：系统主题变化时同步（用户未手动覆盖）
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => { applyTheme('system'); setResolved(systemTheme()); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const cycle = useCallback(() => {
    setMode(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system');
  }, [mode, setMode]);

  const value = useMemo(() => ({ mode, resolved, setMode, cycle }), [mode, resolved, setMode, cycle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return v;
}
