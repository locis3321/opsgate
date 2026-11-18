import type { ReactNode } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, XCircle, Ban, Info } from 'lucide-react';

/**
 * 状态三通道：颜色 + 图标 + 文字（不只靠颜色，色盲/灰度也可读）。
 * 语义：running / success / error / warn / info / disabled。
 */
export type StatusKind = 'running' | 'success' | 'error' | 'warn' | 'info' | 'disabled';

const PRESET: Record<StatusKind, { cls: string; label: string; icon: ReactNode }> = {
  running: { cls: 'st-running', label: '运行中', icon: <Loader2 size={11} strokeWidth={2.2} className="spin" /> },
  success: { cls: 'st-running', label: '正常', icon: <CheckCircle2 size={11} strokeWidth={2.2} /> },
  error: { cls: 'st-error', label: '异常', icon: <XCircle size={11} strokeWidth={2.2} /> },
  warn: { cls: 'st-warn', label: '告警', icon: <AlertTriangle size={11} strokeWidth={2.2} /> },
  info: { cls: 'st-info', label: '信息', icon: <Info size={11} strokeWidth={2.2} /> },
  disabled: { cls: 'st-disabled', label: '已停用', icon: <Ban size={11} strokeWidth={2.2} /> },
};

export default function StatusBadge({
  kind,
  label,
  icon,
  pulse = false,
  title,
}: {
  kind: StatusKind;
  /** 覆盖预设文案（如"限流"/"已绑定"） */
  label?: string;
  /** 覆盖预设图标 */
  icon?: ReactNode;
  /** running 时状态点微脉冲（仅真实运行态开启） */
  pulse?: boolean;
  title?: string;
}) {
  const p = PRESET[kind];
  return (
    <span className={`status-badge ${p.cls}${pulse && kind === 'running' ? ' st-pulse' : ''}`} title={title}>
      <span className="dot" aria-hidden />
      {icon ?? p.icon}
      {label ?? p.label}
    </span>
  );
}
