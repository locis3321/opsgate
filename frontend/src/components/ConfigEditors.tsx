import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';

/**
 * 动态字符串列表编辑器（用于 args）。
 * `renderValue` 让调用方替换某一行的值控件——Market 详情页用它把 `${VAR}` 占位符行
 * 直接换成"填值/选凭证"控件，避免下方再列一遍同样的槽位。
 */
export function StringListEditor({ label, hint, value, onChange, renderValue }: {
  label: string; hint?: string; value: string[]; onChange: (v: string[]) => void;
  /** 返回非 null 时替换该行的输入框（索引 + 当前值 + 更新函数） */
  renderValue?: (index: number, current: string, set: (v: string) => void) => ReactNode | null;
}) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>{label}</label>
        {hint && <span style={{ color: 'var(--meta)', fontSize: 12 }}>{hint}</span>}
      </div>
      {value.map((row, i) => {
        const setVal = (v: string) => { const next = [...value]; next[i] = v; onChange(next); };
        const custom = renderValue?.(i, row, setVal) ?? null;
        return (
          <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {custom ?? (
              <input
                className="input"
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
                placeholder={`参数 ${i + 1}`}
                value={row}
                onChange={(e) => setVal(e.target.value)}
              />
            )}
            <button
              type="button"
              className="btn"
              style={{ padding: '4px 8px', flexShrink: 0 }}
              title="删除"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} strokeWidth={1.8} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="btn"
        style={{ alignSelf: 'flex-start', fontSize: 'var(--text-xs)', gap: 4 }}
        onClick={() => onChange([...value, ''])}
      >
        <Plus size={12} strokeWidth={2} /> 添加
      </button>
    </div>
  );
}

/** 动态键值对编辑器（用于 env / headers） */
export function KVListEditor({ label, hint, value, onChange, valuePlaceholder, renderValue }: {
  label: string; hint?: string;
  value: Array<{ key: string; value: string }>;
  onChange: (v: Array<{ key: string; value: string }>) => void;
  valuePlaceholder?: string;
  /** 返回非 null 时替换该行的「值」输入框；键列保持可编辑 */
  renderValue?: (index: number, row: { key: string; value: string }, set: (v: string) => void) => ReactNode | null;
}) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>{label}</label>
        {hint && <span style={{ color: 'var(--meta)', fontSize: 12 }}>{hint}</span>}
      </div>
      {value.map((row, i) => {
        const setVal = (v: string) => { const next = [...value]; next[i] = { ...next[i]!, value: v }; onChange(next); };
        const custom = renderValue?.(i, row, setVal) ?? null;
        return (
          <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              className="input"
              style={{ flex: 2, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
              placeholder="键"
              value={row.key}
              onChange={(e) => { const next = [...value]; next[i] = { ...next[i]!, key: e.target.value }; onChange(next); }}
            />
            {custom ?? (
              <input
                className="input"
                style={{ flex: 3, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
                placeholder={valuePlaceholder ?? '值'}
                value={row.value}
                onChange={(e) => setVal(e.target.value)}
              />
            )}
            <button
              type="button"
              className="btn"
              style={{ padding: '4px 8px', flexShrink: 0 }}
              title="删除"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} strokeWidth={1.8} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="btn"
        style={{ alignSelf: 'flex-start', fontSize: 'var(--text-xs)', gap: 4 }}
        onClick={() => onChange([...value, { key: '', value: '' }])}
      >
        <Plus size={12} strokeWidth={2} /> 添加
      </button>
    </div>
  );
}
