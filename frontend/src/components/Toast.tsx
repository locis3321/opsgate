import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'warn' | 'info';

interface ToastItem { id: number; kind: ToastKind; message: string }

interface ToastApi {
  /** `durationMs` 覆盖默认时长（success/info/warn 3.5s、error 6s）；需要用户读完的长提示用它 */
  show: (kind: ToastKind, message: string, durationMs?: number) => void;
  success: (m: string, durationMs?: number) => void;
  error: (m: string, durationMs?: number) => void;
  warn: (m: string, durationMs?: number) => void;
  info: (m: string, durationMs?: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

const ICONS: Record<ToastKind, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  warn: AlertTriangle,
  info: Info,
};

/** 全局 Toast：slide-in + 自动消失；provider 挂在应用根。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback((kind: ToastKind, message: string, durationMs?: number) => {
    const id = ++seq.current;
    setItems((list) => [...list, { id, kind, message }]);
    window.setTimeout(() => remove(id), durationMs ?? (kind === 'error' ? 6000 : 3500));
  }, [remove]);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (m, d) => show('success', m, d),
    error: (m, d) => show('error', m, d),
    warn: (m, d) => show('warn', m, d),
    info: (m, d) => show('info', m, d),
  }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div key={t.id} className={`toast t-${t.kind}`}>
              <Icon size={15} strokeWidth={1.9} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{t.message}</span>
              <button className="close" onClick={() => remove(t.id)} aria-label="关闭提示">
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast 必须在 ToastProvider 内使用');
  return v;
}
