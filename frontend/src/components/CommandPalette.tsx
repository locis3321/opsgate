import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon?: LucideIcon;
  run: () => void;
}

/**
 * 命令面板（⌘/Ctrl+K）：模糊搜导航 + 资产，↑↓/Enter/Esc。
 * 资产来自现有 GET /servers（不新增后端接口）；导航项为前端常量。
 */
export default function CommandPalette({
  open,
  onClose,
  navItems,
}: {
  open: boolean;
  onClose: () => void;
  /** `label` 是侧栏用的短名（2 字），`full` 是完整页面名——面板里显示完整的那个 */
  navItems: Array<{ to: string; label: string; full?: string; icon: LucideIcon }>;
}) {
  const nav = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const assets = useQuery({
    queryKey: ['palette-assets'],
    queryFn: () => api<{ items: Array<{ id: string; name: string; displayName: string | null }> }>('/api/v1/servers?page=1'),
    enabled: open,
  });

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = navItems.map((n) => ({
      id: `nav:${n.to}`,
      label: n.full ?? n.label,
      hint: n.full && n.full !== n.label ? n.label : undefined,
      group: '导航',
      icon: n.icon,
      run: () => nav(n.to),
    }));
    for (const a of assets.data?.items ?? []) {
      list.push({
        id: `asset:${a.id}`,
        label: a.displayName || a.name,
        hint: a.name,
        group: '资产',
        run: () => nav(`/assets/${a.id}`),
      });
    }
    return list;
  }, [navItems, assets.data, nav]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q) || (a.hint ?? '').toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const runAction = (a: PaletteAction) => { onClose(); a.run(); };

  let lastGroup = '';

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="dialog" aria-modal aria-label="命令面板">
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 14, color: 'var(--meta)' }}>
          <Search size={16} strokeWidth={1.8} />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="搜索页面或资产…（↑↓ 选择，Enter 打开，Esc 关闭）"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(filtered.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); const a = filtered[active]; if (a) runAction(a); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
          />
        </div>
        <div className="palette-list">
          {filtered.length === 0 && <div className="combobox-empty">无匹配项</div>}
          {filtered.map((a, i) => {
            const header = a.group !== lastGroup ? a.group : null;
            lastGroup = a.group;
            const Icon = a.icon;
            return (
              <div key={a.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  className={`palette-item${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); runAction(a); }}
                >
                  {Icon ? <Icon size={14} strokeWidth={1.8} /> : <span style={{ width: 14 }} />}
                  <span>{a.label}</span>
                  {a.hint && <span className="hint mono">{a.hint}</span>}
                  {i === active && !a.hint && <CornerDownLeft size={12} strokeWidth={1.8} className="hint" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
