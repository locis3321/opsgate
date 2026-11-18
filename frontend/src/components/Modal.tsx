import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';

/**
 * 现代模态：焦点圈定 + ESC 关闭 + 可选 dirty 保护 + 退出动效。
 * dirty 为真时，点击遮罩/ESC/关闭按钮不直接关闭，而是在模态内显示确认条
 * （放弃修改 / 继续编辑）——按要求禁止原生 confirm/alert。
 */
export default function Modal({
  title,
  onClose,
  children,
  width = 520,
  dirty = false,
  dirtyMessage = '有未保存的修改，关闭将丢失。',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  dirty?: boolean;
  dirtyMessage?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setConfirming(false);
    setClosing(true);
    // 等退出动效结束再卸载（reduced-motion 下时间极短）
    window.setTimeout(onClose, 140);
  }, [onClose]);

  const requestClose = useCallback(() => {
    if (dirty) { setConfirming(true); return; }
    close();
  }, [dirty, close]);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (confirming) setConfirming(false);
        else requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // 焦点圈定：Tab 在模态内循环
      const root = panelRef.current;
      if (!root) return;
      const nodes = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose, confirming]);

  const shown = visible && !closing;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: shown ? 'var(--overlay)' : 'transparent',
        backdropFilter: shown ? 'blur(6px)' : 'blur(0px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        transition: 'background var(--dur-normal) var(--ease), backdrop-filter var(--dur-normal) var(--ease)',
      }}
      onMouseDown={requestClose}
    >
      <div
        ref={panelRef}
        className="card"
        style={{
          width,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: '85vh',
          overflow: 'auto',
          padding: 0,
          opacity: shown ? 1 : 0,
          transform: shown ? 'scale(1) translateY(0)' : 'scale(0.97) translateY(6px)',
          transition: 'opacity var(--dur-normal) var(--ease), transform var(--dur-normal) var(--ease)',
          boxShadow: 'var(--shadow-lg)',
          borderRadius: 'var(--r-lg)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            position: 'sticky',
            top: 0,
            background: 'var(--surface)',
            zIndex: 1,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 'var(--text-lg)', letterSpacing: '-0.01em' }}>{title}</div>
          <button className="icon-btn" onClick={requestClose} aria-label="关闭">
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        <div style={{ padding: '18px', display: 'grid', gap: 'var(--space-3)' }}>
          {children}
        </div>

        {confirming && (
          <div
            role="alertdialog"
            aria-label="确认关闭"
            style={{
              position: 'sticky', bottom: 0,
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 18px',
              background: 'var(--surface-2)',
              borderTop: '1px solid var(--border)',
            }}
          >
            <AlertTriangle size={14} strokeWidth={2} style={{ color: 'var(--warn)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>{dirtyMessage}</span>
            <button className="btn btn-danger" onClick={close} autoFocus>放弃修改</button>
            <button className="btn" onClick={() => setConfirming(false)}>继续编辑</button>
          </div>
        )}
      </div>
    </div>
  );
}
