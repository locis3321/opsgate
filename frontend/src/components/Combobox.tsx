import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

export interface ComboOption {
  value: string;
  label: string;
  /** 可选的辅助说明（如 runtime / 分类） */
  hint?: string;
  /** 分组名（同组的选项连续排列时显示组标题） */
  group?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * 可搜索下拉（替换原生 select）：键盘 ↑↓/Enter/Esc、点击外部关闭、aria 语义。
 * 空 value 表示"未选择"，用 placeholder 展示。
 */
export default function Combobox({
  value,
  options,
  onChange,
  placeholder = '请选择…',
  searchPlaceholder = '搜索…',
  emptyText = '无匹配项',
  disabled = false,
  ariaLabel,
}: {
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    // 打开后聚焦搜索框（移动端键盘也能直接输入）
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => { window.clearTimeout(t); document.removeEventListener('mousedown', onDocDown); };
  }, [open, options, value]);

  const pick = (opt: ComboOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[active];
      if (opt) pick(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  let lastGroup: string | undefined;

  return (
    <div className="combobox" ref={rootRef}>
      <button
        type="button"
        className="combobox-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        {selected?.icon}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className={selected ? '' : 'placeholder'}>
          {selected ? selected.label : placeholder}
        </span>
        {selected?.hint && <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>{selected.hint}</span>}
        <ChevronsUpDown size={13} strokeWidth={1.8} className="chev" />
      </button>

      {open && (
        <div className="combobox-pop" role="listbox">
          <input
            ref={searchRef}
            className="combobox-search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
          />
          {filtered.length === 0 && <div className="combobox-empty">{emptyText}</div>}
          {filtered.map((opt, i) => {
            const header = opt.group && opt.group !== lastGroup ? opt.group : null;
            lastGroup = opt.group;
            return (
              <div key={opt.value}>
                {header && <div className="palette-group" style={{ padding: '6px 8px 2px' }}>{header}</div>}
                <div
                  role="option"
                  aria-selected={opt.value === value}
                  className={`combobox-option${i === active ? ' active' : ''}`}
                  style={opt.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); pick(opt); }}
                >
                  {opt.icon}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                  {opt.hint && <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', marginLeft: 'auto' }}>{opt.hint}</span>}
                  {opt.value === value && <Check size={13} strokeWidth={2} className="check" style={{ marginLeft: opt.hint ? 6 : 'auto' }} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
