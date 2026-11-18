import type { ReactNode } from 'react';

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * 标签页导航：
 * - `underline` 下划线标签 —— 用于模式切换（市场 / 自定义）
 * - `segmented` 分段控件 —— 用于表单枚举（stdio / http / sse）
 */
export default function Tabs<T extends string>({ tabs, value, onChange, variant = 'underline' }: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  variant?: 'underline' | 'segmented';
}) {
  return (
    <div className={variant === 'segmented' ? 'segmented' : 'tabs'} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}
