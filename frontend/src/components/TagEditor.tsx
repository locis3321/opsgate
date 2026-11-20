import { useMemo, useRef, useState } from 'react';
import { X, Plus, Tag as TagIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export interface TagCount { tag: string; count: number }

/**
 * 资产标签编辑器：chip 展示 + 从已有标签中选 / 输入新标签。
 *
 * 为什么不做纯文本框：`?tag=` 与 `opsgate_select_scope({tag})` 是**精确匹配**，
 * 自由输入很容易造出 `prod` / `Prod` / `生产` 这类近义重复，直接让按标签收窄失效。
 * 这里把已有标签作为候选优先呈现（按使用次数降序），同时允许输入新值。
 */
export default function TagEditor({
  value, onChange, disabled, inputId,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  inputId?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const all = useQuery({
    queryKey: ['server-tags'],
    queryFn: () => api<TagCount[]>('/api/v1/servers/tags'),
    staleTime: 60_000,
  });

  const selected = new Set(value);
  const q = query.trim();
  const suggestions = useMemo(() => {
    const list = all.data ?? [];
    return list
      .filter((x) => !selected.has(x.tag))
      .filter((x) => !q || x.tag.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 30);
  }, [all.data, selected, q]);

  const canCreate = q !== '' && !value.includes(q) && !(all.data ?? []).some((x) => x.tag === q);

  const add = (t: string) => {
    const tag = t.trim();
    if (!tag || selected.has(tag)) return;
    onChange([...value, tag]);
    setQuery('');
    setOpen(false);
  };
  const remove = (t: string) => onChange(value.filter((x) => x !== t));

  return (
    <div ref={rootRef} style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {value.length === 0 && <span style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>无标签</span>}
        {value.map((t) => (
          <span key={t} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <TagIcon size={11} strokeWidth={2} style={{ opacity: 0.7 }} />
            {t}
            {!disabled && (
              <button
                type="button"
                className="icon-btn"
                style={{ width: 16, height: 16, minHeight: 0 }}
                onClick={() => remove(t)}
                aria-label={`移除标签 ${t}`}
                title="移除该标签"
              >
                <X size={11} strokeWidth={2.4} />
              </button>
            )}
          </span>
        ))}
      </div>

      {!disabled && (
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id={inputId}
              className="input"
              style={{ flex: 1, minWidth: 160 }}
              placeholder="搜索已有标签或输入新标签"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onBlur={() => window.setTimeout(() => setOpen(false), 120)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); if (q) add(q); }
                if (e.key === 'Escape') setOpen(false);
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={!q || selected.has(q)}
              onClick={() => add(q)}
              style={{ flexShrink: 0 }}
            >
              <Plus size={13} strokeWidth={2} /> 添加
            </button>
          </div>

          {open && (suggestions.length > 0 || canCreate) && (
            <div
              role="listbox"
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4,
                maxHeight: 220, overflowY: 'auto', background: 'var(--surface)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
              }}
            >
              {canCreate && (
                <div
                  role="option"
                  aria-selected={false}
                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}
                  onMouseDown={(e) => { e.preventDefault(); add(q); }}
                >
                  <Plus size={12} strokeWidth={2} />
                  新建标签 <span className="mono" style={{ fontWeight: 600 }}>{q}</span>
                </div>
              )}
              {suggestions.map((s) => (
                <div
                  key={s.tag}
                  role="option"
                  aria-selected={false}
                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 'var(--text-sm)', display: 'flex', alignItems: 'center', gap: 8 }}
                  onMouseDown={(e) => { e.preventDefault(); add(s.tag); }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-raise)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <span className="mono" style={{ flex: 1 }}>{s.tag}</span>
                  <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>{s.count} 台</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
