import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal, AlertTriangle, RotateCcw, Eye, Pencil } from 'lucide-react';
import { api, ApiError } from '../api';
import MarkdownView from '../components/MarkdownView';
import Modal from '../components/Modal';

interface Setting {
  key: string; category: string; type: string; label: string; description: string;
  default: unknown; min: number | null; max: number | null; requiresRestart: boolean; secret: boolean;
  current: unknown; stored: boolean;
}

const CATEN: Record<string, string> = {
  instance_pool: '实例池', ssh_pool: 'SSH 连接池', tools: '工具', transfer: '文件传输', audit: '审计', credentials: '凭证', mcp: 'MCP', general: '通用',
};

/** 需要多行编辑的配置项（其余仍用单行 input，避免把简单参数做成大文本框） */
const MULTILINE_KEYS = new Set(['mcp.instructions']);

/** 运行时参数（ADR-024，admin）：分类卡片 + inline 编辑 + 待重启提示条 + 双值 + 恢复默认（AC-55/57/60）。
 *  多行项（mcp.instructions）走弹窗编辑：表格单元格里塞 textarea 可视区域太小。 */
export default function Settings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<Setting[]>('/api/v1/settings') });
  const pending = useQuery({ queryKey: ['settings-pending'], queryFn: () => api<{ pending: Array<{ key: string; saved: unknown }> }>('/api/v1/settings/pending-restart') });
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const [editKey, setEditKey] = useState('');
  const [draft, setDraft] = useState('');
  /** 弹窗编辑的配置项 id（多行项专用） */
  const [modalKey, setModalKey] = useState('');
  const [modalDraft, setModalDraft] = useState('');
  const save = useMutation({
    mutationFn: (v: { key: string; value: unknown }) => api(`/api/v1/settings/${v.key}`, { method: 'PATCH', body: JSON.stringify({ value: v.value }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings'] }); void qc.invalidateQueries({ queryKey: ['settings-pending'] }); setEditKey(''); setModalKey(''); setErr(''); },
  });
  const reset = useMutation({
    mutationFn: (key: string) => api(`/api/v1/settings/${key}/reset`, { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings'] }); void qc.invalidateQueries({ queryKey: ['settings-pending'] }); },
  });

  const pendingKeys = (pending.data?.pending ?? []).map((p) => p.key);
  const categories = [...new Set((q.data ?? []).map((s) => s.category))];
  const modalSetting = (q.data ?? []).find((s) => s.key === modalKey);

  return (
    <div className="page animate-slide-up">
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>运行时参数</h1>
        <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
          调整服务器运行时配置，部分参数需重启后生效
        </p>
      </div>

      {pendingKeys.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', borderRadius: 'var(--radius-lg)',
          background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)',
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--warn)', flexShrink: 0 }} strokeWidth={1.8} />
          <span style={{ color: 'var(--warn)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>
            {pendingKeys.length} 项待重启生效：{pendingKeys.join('、')}（当前显示为已保存值，重启前不生效）
          </span>
        </div>
      )}

      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', padding: '10px 14px', background: 'var(--danger-soft)', borderRadius: 'var(--radius)' }}>{err}</div>}

      {q.isLoading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
          <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</span>
        </div>
      ) : categories.map((cat, catIdx) => (
        <div key={cat} className="animate-slide-up" style={{ animationDelay: `${catIdx * 60}ms`, animationFillMode: 'both' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-2)', margin: '8px 0 8px', fontWeight: 600, fontSize: 'var(--text-sm)' }}>
            <SlidersHorizontal size={14} strokeWidth={1.8} />
            {CATEN[cat] ?? cat}
          </div>
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="dt">
              <thead><tr><th>配置项</th><th>说明</th><th>生效值</th></tr></thead>
              <tbody>
                {(q.data ?? []).filter((s) => s.category === cat).map((s) => (
                  <tr key={s.key}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="mono" style={{ fontWeight: 500 }}>{s.label}</span>
                        {s.requiresRestart && <span className="badge-warn" style={{ padding: '1px 6px', fontSize: 'var(--text-xs)' }}>需重启</span>}
                      </div>
                      <div className="mono" style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', marginTop: 2 }}>{s.key}</div>
                    </td>
                    <td style={{ color: 'var(--muted)', maxWidth: 380, fontSize: 'var(--text-sm)' }}>{s.description}</td>
                    <td>
                      {editKey === s.key ? (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input className="input mono" style={{ width: 140 }} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
                            onKeyDown={(e) => e.key === 'Enter' && save.mutate({ key: s.key, value: coerce(draft, s.type) })} />
                          <button className="btn btn-primary" style={{ padding: '5px 12px' }} onClick={() => save.mutate({ key: s.key, value: coerce(draft, s.type) }, {
                            onError: (e) => setErr(e instanceof ApiError ? e.message : '校验失败'),
                          })}>保存</button>
                          <button className="btn" style={{ padding: '5px 12px' }} onClick={() => setEditKey('')}>取消</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          {MULTILINE_KEYS.has(s.key) ? (
                            <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                              {String(s.current ?? '').trim() ? `${String(s.current).length} 字符` : '（未设置）'}
                            </span>
                          ) : (
                            <span className="mono" style={{ fontSize: 'var(--text-sm)' }}>{s.secret ? '••••••' : String(s.current ?? '')}</span>
                          )}
                          {s.stored && s.requiresRestart && s.current !== s.default && (
                            <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }} className="mono">
                              (默认 {String(s.default)})
                            </span>
                          )}
                          <button
                            className="btn"
                            style={{ padding: '4px 10px', minHeight: 28, fontSize: 'var(--text-xs)' }}
                            onClick={() => {
                              if (MULTILINE_KEYS.has(s.key)) { setModalKey(s.key); setModalDraft(String(s.current ?? '')); }
                              else { setEditKey(s.key); setDraft(String(s.current ?? '')); }
                            }}
                          >
                            编辑
                          </button>
                          {s.stored && (
                            <button className="btn" style={{ padding: '4px 10px', minHeight: 28, fontSize: 'var(--text-xs)' }} onClick={() => reset.mutate(s.key)} title="恢复默认值">
                              <RotateCcw size={12} strokeWidth={1.8} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {modalSetting && (
        <Modal title={modalSetting.label} width={900} onClose={() => setModalKey('')}>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{modalSetting.description}</div>
          <div style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            padding: '10px 14px', borderRadius: 'var(--radius)',
            background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)',
          }}>
            <AlertTriangle size={15} strokeWidth={2} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
            <div style={{ color: 'var(--warn)', fontSize: 'var(--text-sm)', lineHeight: 1.65 }}>
              这段文本会作为系统提示注入 <b>每一个</b> MCP 连接，直接影响模型行为。
              删掉其中的安全约束（执行高危操作前先确认、不编造资产名、不绕过安全策略）后，这些约束就不再下发给模型，网关不会在别处兜底。
              所需事实信息（视图名、资产台数、工具数、分组说明）由服务端自动生成并置于其上，无需在此重复。
              留空或点「恢复默认」即用内置版本。
            </div>
          </div>
          <MarkdownSettingEditor
            value={modalDraft}
            onChange={setModalDraft}
            pending={save.isPending}
            onCancel={() => setModalKey('')}
            onSave={() => save.mutate({ key: modalSetting.key, value: modalDraft }, {
              onError: (e) => setErr(e instanceof ApiError ? e.message : '校验失败'),
            })}
          />
        </Modal>
      )}
    </div>
  );
}

/** 多行 Markdown 配置项编辑：编辑 / 预览切换（预览走本地 MarkdownView，不注入 HTML）。 */
function MarkdownSettingEditor({
  value, onChange, pending, onCancel, onSave,
}: {
  value: string;
  onChange: (next: string) => void;
  pending: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const tabBtn = (active: boolean) => ({
    padding: '3px 10px', fontSize: 'var(--text-xs)', minHeight: 26,
    color: active ? 'var(--fg)' : 'var(--muted)',
    background: active ? 'var(--surface-raise)' : 'transparent',
    border: 'none', cursor: 'pointer', borderRadius: 'var(--radius)',
    display: 'inline-flex', alignItems: 'center', gap: 4,
  } as const);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 2, background: 'var(--surface)', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius)', width: 'fit-content' }}>
        <button type="button" style={tabBtn(tab === 'edit')} onClick={() => setTab('edit')}>
          <Pencil size={11} strokeWidth={1.8} /> 编辑
        </button>
        <button type="button" style={tabBtn(tab === 'preview')} onClick={() => setTab('preview')}>
          <Eye size={11} strokeWidth={1.8} /> 预览
        </button>
      </div>
      {tab === 'edit' ? (
        <textarea
          className="input mono"
          rows={20}
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={'例如：\n## 环境约定\n- 生产环境变更需双人确认\n- 所有 SQL 先 EXPLAIN'}
          style={{ width: '100%', resize: 'vertical', lineHeight: 1.6, fontSize: 'var(--text-xs)', minHeight: 380 }}
        />
      ) : (
        <div style={{
          minHeight: 380, maxHeight: 520, overflow: 'auto', padding: 12,
          background: 'var(--surface)', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius)',
        }}>
          {value.trim() ? <MarkdownView text={value} /> : <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>（空）</span>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-primary" style={{ padding: '5px 12px' }} disabled={pending} onClick={onSave}>保存</button>
        <button className="btn" style={{ padding: '5px 12px' }} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

function coerce(raw: string, type: string): unknown {
  if (type === 'int' || type === 'size' || type === 'duration' || type === 'float') return Number(raw);
  if (type === 'bool') return raw === 'true';
  if (type === 'json') return JSON.parse(raw);
  return raw;
}
