import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, RefreshCw, Trash2, CheckCircle2, Ban, PlayCircle, FlaskConical, Info } from 'lucide-react';
import { api, ApiError, fmtTs } from '../api';
import Modal from '../components/Modal';
import Combobox from '../components/Combobox';
import { StringListEditor, KVListEditor } from '../components/ConfigEditors';
import { detectSlots } from '../slots';
import Tabs from '../components/Tabs';
import { useToast } from '../components/Toast';

/** 发布含凭证槽位、但未做凭证级验证时的提示需要用户读完，给足 10 秒 */
const PROBE_HINT_MS = 10_000;

interface InstallBranch { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }

/** Record → 键值行（空对象 → 空数组） */
function recToRows(rec?: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(rec ?? {}).map(([k, v]) => ({ key: k, value: v }));
}

/** 键值行 → Record（忽略空键） */
function rowsToRec(rows: Array<{ key: string; value: string }>): Record<string, string> {
  return Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
}

interface EntryRow {
  key: string; name: string; displayName: string; description: string; repository: string;
  categories: string[]; tags: string[]; runtime: string; status: 'draft' | 'verified' | 'disabled';
  readmeUrl: string | null; versionPinned: string | null; versionLatest: string | null;
  updatedAt: number; assetCount: number;
}

interface EntryDetail extends EntryRow {
  slotLabels: Record<string, string> | null;
  optionalSlots: string[] | null;
  executionMode?: 'mcp' | 'native';
  defaultGroup: string | null;
  installations: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
}

const STATUS_META: Record<EntryRow['status'], { label: string; cls: string }> = {
  draft: { label: '未验证', cls: 'badge-warn' },
  verified: { label: '已验证', cls: 'badge-success' },
  disabled: { label: '已停用', cls: 'tag' },
};

/** Market 条目管理（ADR-029 / T16）：管理员维护目录主数据；状态机 + 连通性测试 + 引用保护。 */
export default function MarketEntries() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EntryDetail | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['market-entries', status],
    queryFn: () => api<EntryRow[]>(`/api/v1/market/entries${status ? `?status=${status}` : ''}`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['market-entries'] });
    void qc.invalidateQueries({ queryKey: ['market'] });
    void qc.invalidateQueries({ queryKey: ['market-categories'] });
  };

  const act = useMutation({
    mutationFn: (v: { key: string; action: 'verify' | 'disable' | 'enable' }) =>
      api(`/api/v1/market/entries/${v.key}/${v.action}`, { method: 'POST' }),
    onSuccess: (d, v) => {
      invalidate();
      setErr('');
      // 后端在"含槽位但未做凭证级验证"时会回 tested=false + reason。
      // 用站点级提示而不是表格单元格：这段文案很长，塞进「操作」列会把表格撑变形。
      const info = d as { tested?: boolean; reason?: string; slots?: string[] } | undefined;
      if (v.action === 'verify' && info && info.tested === false && info.reason === 'needs-credential') {
        toast.info(
          `已发布（含 ${info.slots?.join('/') ?? '凭证'} 槽位，未做凭证级验证——请绑定凭证后在资产详情测试）`,
          PROBE_HINT_MS,
        );
      }
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '操作失败'),
  });

  const del = useMutation({
    mutationFn: (key: string) => api(`/api/v1/market/entries/${key}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); setConfirming(null); setErr(''); },
    onError: (e) => { setErr(e instanceof ApiError ? e.message : '删除失败'); setConfirming(null); },
  });

  const test = useMutation({
    mutationFn: (key: string) =>
      api<{ ok: boolean; tools?: number; error?: string }>(`/api/v1/market/entries/${key}/test`, { method: 'POST' }),
    onSuccess: (d) => {
      if (d.ok) toast.success(`连通正常（${d.tools} 个工具）`);
      else toast.error(`测试失败：${d.error ?? '未知错误'}`);
    },
    onError: (e) => toast.error('测试失败：' + (e instanceof ApiError ? e.message : '请求失败')),
  });

  const openEdit = async (key: string) => {
    try {
      const d = await api<EntryDetail>(`/api/v1/market/entries/${key}`);
      setEditing(d);
      setOpen(true);
      setErr('');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载条目失败');
    }
  };

  const rows = list.data ?? [];

  return (
    <div className="page animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn" onClick={() => nav('/market')} style={{ padding: '7px 10px', minHeight: 34 }}>
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>Market 条目管理</h1>
          <p style={{ color: 'var(--muted)', margin: '2px 0 0', fontSize: 'var(--text-sm)' }}>
            新增/编辑目录条目；「发布」= 让普通成员可见。含凭证槽位的条目需在资产详情绑定凭证后才能真正验证可用性
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { setEditing(null); setOpen(true); setErr(''); }} style={{ gap: 6 }}>
          <Plus size={14} strokeWidth={2} /> 新增条目
        </button>
      </div>

      <div className="toolbar">
        <div style={{ minWidth: 140 }}><Combobox
          ariaLabel="状态筛选"
          value={status}
          onChange={setStatus}
          placeholder="全部状态"
          options={[
            { value: '', label: '全部状态' },
            { value: 'draft', label: '未验证' },
            { value: 'verified', label: '已验证' },
            { value: 'disabled', label: '已停用' },
          ]}
        /></div>
        <button className="btn" onClick={() => list.refetch()} style={{ gap: 6 }}>
          <RefreshCw size={14} strokeWidth={1.8} /> 刷新
        </button>
        <span style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>共 {rows.length} 条</span>
      </div>

      {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}

      {list.isLoading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>加载中…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div>暂无条目</div>
          <div className="hint">点击「新增条目」添加 MCP 服务</div>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="dt">
            <thead>
              <tr>
                <th>条目</th><th>分类</th><th>运行时</th><th>状态</th><th>引用资产</th><th>更新时间</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <div className="mono">{r.displayName}</div>
                    <div style={{ color: 'var(--meta)', fontSize: 12 }}>{r.key}</div>
                  </td>
                  <td>{r.categories.map((c) => <span key={c} className="tag">{c}</span>)}</td>
                  <td><span className="tag">{r.runtime}</span></td>
                  <td><span className={STATUS_META[r.status].cls}>{STATUS_META[r.status].label}</span></td>
                  <td>{r.assetCount > 0 ? <span className="tag">{r.assetCount}</span> : '0'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtTs(r.updatedAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button className="btn" onClick={() => void openEdit(r.key)}>编辑</button>
                      <button className="btn" style={{ gap: 4 }} onClick={() => test.mutate(r.key)} disabled={test.isPending}>
                        <FlaskConical size={13} strokeWidth={1.8} /> 测试
                      </button>
                      {r.status === 'draft' && (
                        <button
                          className="btn btn-primary"
                          style={{ gap: 4 }}
                          onClick={() => act.mutate({ key: r.key, action: 'verify' })}
                          disabled={act.isPending}
                          title="发布后普通成员可见。发布前会现场拉起条目验证命令可启动；含凭证槽位的条目不做凭证级验证（需绑定后到资产详情测试）"
                        >
                          {act.isPending ? <RefreshCw size={13} className="spin" /> : <CheckCircle2 size={13} strokeWidth={1.8} />} 发布
                        </button>
                      )}
                      {r.status === 'verified' && (
                        <button className="btn" style={{ gap: 4 }} onClick={() => act.mutate({ key: r.key, action: 'disable' })}>
                          <Ban size={13} strokeWidth={1.8} /> 停用
                        </button>
                      )}
                      {r.status === 'disabled' && (
                        <button className="btn" style={{ gap: 4 }} onClick={() => act.mutate({ key: r.key, action: 'enable' })}>
                          <PlayCircle size={13} strokeWidth={1.8} /> 启用
                        </button>
                      )}
                      {confirming !== r.key ? (
                        <button className="btn btn-danger" onClick={() => setConfirming(r.key)} style={{ gap: 4 }}>
                          <Trash2 size={13} strokeWidth={1.8} /> 删除
                        </button>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <span style={{ color: 'var(--danger)', fontSize: 12 }}>
                            {r.assetCount > 0 ? `已被 ${r.assetCount} 个资产引用，无法删除，请改用停用` : '确认删除？'}
                          </span>
                          <button className="btn btn-danger" disabled={r.assetCount > 0} onClick={() => del.mutate(r.key)}>确认</button>
                          <button className="btn" onClick={() => setConfirming(null)}>取消</button>
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <EntryModal
          editing={editing}
          onClose={() => { setOpen(false); setEditing(null); }}
          onSaved={() => { setOpen(false); setEditing(null); invalidate(); setErr(''); }}
          onError={setErr}
        />
      )}
    </div>
  );
}

/** 新增/编辑弹窗：安装配置以结构化表单为主（command/args/env/headers 动态行），
 *  并保留 JSON 模式供批量粘贴/复杂场景（两者互转同源）；槽位标签用键值行而非手写 JSON。 */
function EntryModal({
  editing, onClose, onSaved, onError,
}: {
  editing: EntryDetail | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const isEdit = !!editing;
  const [key, setKey] = useState(editing?.key ?? '');
  const [displayName, setDisplayName] = useState(editing?.displayName ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [repository, setRepository] = useState(editing?.repository ?? '');
  const [categories, setCategories] = useState((editing?.categories ?? []).join(','));
  const [tags, setTags] = useState((editing?.tags ?? []).join(','));
  const [runtime, setRuntime] = useState(editing?.runtime ?? 'npm');
  const [slotLabelRows, setSlotLabelRows] = useState<Array<{ key: string; value: string }>>(recToRows(editing?.slotLabels ?? {}));
  const [readmeUrl, setReadmeUrl] = useState(editing?.readmeUrl ?? '');
  const [defaultGroup, setDefaultGroup] = useState(editing?.defaultGroup ?? '');

  // 当前运行时的安装分支（结构化表单编辑这三组）
  const initBranch = (() => {
    const all = (editing?.installations ?? { npm: { command: 'npx', args: ['-y', 'pkg@1.0.0'], env: {} } }) as Record<string, InstallBranch>;
    return all[runtime] ?? { command: 'npx', args: ['-y', 'pkg@1.0.0'], env: {} };
  })();
  const [command, setCommand] = useState(initBranch.command ?? '');
  const [argsRows, setArgsRows] = useState<string[]>(initBranch.args ?? []);
  const [envRows, setEnvRows] = useState<Array<{ key: string; value: string }>>(recToRows(initBranch.env));
  const [headersRows, setHeadersRows] = useState<Array<{ key: string; value: string }>>(recToRows(initBranch.headers));
  const [url, setUrl] = useState(initBranch.url ?? '');
  const [cfgMode, setCfgMode] = useState<'form' | 'json'>('form');
  const [installations, setInstallations] = useState(
    JSON.stringify(editing?.installations ?? { npm: { command: 'npx', args: ['-y', 'pkg@1.0.0'], env: {} } }, null, 2),
  );
  const [jsonErr, setJsonErr] = useState('');

  /** 表单 → installations（保留其他 runtime 分支，只覆盖当前 runtime） */
  const buildInstallations = (): Record<string, unknown> => {
    const all = (() => {
      try {
        return JSON.parse(installations || '{}') as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const branch: InstallBranch = {
      ...(url.trim() ? { url: url.trim() } : { command: command.trim() || 'npx' }),
      ...(url.trim() ? { headers: rowsToRec(headersRows) } : { args: argsRows.filter((a) => a.trim()), env: rowsToRec(envRows) }),
    };
    return { ...all, [runtime]: branch };
  };

  const switchMode = (m: 'form' | 'json') => {
    if (m === cfgMode) return;
    if (m === 'json') {
      setInstallations(JSON.stringify(buildInstallations(), null, 2));
      setJsonErr('');
      setCfgMode('json');
      return;
    }
    try {
      JSON.parse(installations || '{}');
      setJsonErr('');
      setCfgMode('form');
    } catch (e) {
      setJsonErr('JSON 解析失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const save = useMutation({
    mutationFn: () => {
      let inst: unknown;
      try {
        // 表单模式下以表单为准；JSON 模式直接用文本
        inst = cfgMode === 'form' ? buildInstallations() : JSON.parse(installations || '{}');
      } catch {
        throw new Error('安装配置不是合法 JSON');
      }
      // 槽位标签：键值行 → 对象（空键忽略），不再解析手写 JSON
      const labels = rowsToRec(slotLabelRows);
      const payload = {
        key,
        // name 与 key 同族（后端两者必填）；表单只暴露 key，避免用户填两个近义字段
        name: key,
        displayName,
        description,
        repository,
        categories: categories.split(',').map((s) => s.trim()).filter(Boolean),
        tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
        runtime,
        installations: inst,
        slotLabels: labels,
        readmeUrl: readmeUrl || null,
        defaultGroup: defaultGroup.trim() || null,
      };
      return isEdit
        ? api(`/api/v1/market/entries/${editing!.key}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : api('/api/v1/market/entries', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: onSaved,
    onError: (e) => onError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '保存失败'),
  });

  return (
    <Modal title={isEdit ? `编辑条目 ${editing!.key}` : '新增条目'} onClose={onClose} width={760}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="key（唯一标识，保存后不可改）">
          <input className="input mono" value={key} disabled={isEdit} onChange={(e) => setKey(e.target.value)} placeholder="my-mcp-server" />
        </Field>
        <Field label="展示名">
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My MCP Server" />
        </Field>
        <Field label="运行时">
          <Combobox
            ariaLabel="包管理器"
            value={runtime}
            onChange={setRuntime}
            options={[{ value: 'npm', label: 'npm' }, { value: 'pypi', label: 'pypi' }]}
          />
        </Field>
        <Field label="分类（逗号分隔）">
          <input className="input" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="mysql,other" />
        </Field>
        <Field label="标签（逗号分隔）">
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="database,sql" />
        </Field>
        <Field label="仓库地址">
          <input className="input mono" value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="https://www.npmjs.com/package/…" />
        </Field>
        <Field label="一句话描述" span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="README 源地址（可选，用于详情页展示）" span>
          <input className="input mono" value={readmeUrl} onChange={(e) => setReadmeUrl(e.target.value)} placeholder="https://pypi.org/project/…" />
        </Field>
        <Field label="默认分组（可选）" span>
          <input className="input" value={defaultGroup} onChange={(e) => setDefaultGroup(e.target.value)} placeholder="如 k8s / prod-db（留空则不自动归组）" />
          <div style={{ color: 'var(--meta)', fontSize: 12, marginTop: 4 }}>
            从该条目创建的资产会自动加入这个分组；分组不存在则自动创建。分组只有管理员能管理。
          </div>
        </Field>
        <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>安装配置（{runtime}）</span>
            <div style={{ marginLeft: 'auto' }}>
              <Tabs
                variant="segmented"
                tabs={[{ value: 'form' as const, label: '表单' }, { value: 'json' as const, label: 'JSON' }]}
                value={cfgMode}
                onChange={switchMode}
              />
            </div>
          </div>
          {cfgMode === 'form' ? (
            <div style={{ display: 'grid', gap: 10, padding: 12, background: 'var(--surface-2)', borderRadius: 'var(--r-md)' }}>
              <Field label="启动命令（stdio）">
                <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx / uvx …" />
              </Field>
              <Field label="服务地址（http/sse，填了则忽略命令）">
                <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp（可选）" />
              </Field>
              <StringListEditor label="参数（args）" hint="每个输入框一个数组元素" value={argsRows} onChange={setArgsRows} />
              <KVListEditor label="环境变量（env）" hint="值写 ${NAME} 声明为凭证槽位" value={envRows} onChange={setEnvRows} valuePlaceholder="${NAME} 或值" />
              <KVListEditor label="请求头（headers）" hint="HTTP/SSE 型才生效" value={headersRows} onChange={setHeadersRows} valuePlaceholder="Bearer ${TOKEN} 或值" />
              {/* 实时槽位识别（避免用户按厂商文档填空值，导致条目永远起不来） */}
              <SlotPreviewHint env={rowsToRec(envRows)} args={argsRows} headers={rowsToRec(headersRows)} />
              <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
                表单只编辑当前运行时（{runtime}）；切换运行时后保存会保留其它运行时分支。
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 4 }}>
              <textarea className="input mono" rows={12} value={installations} onChange={(e) => setInstallations(e.target.value)} />
              {jsonErr && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{jsonErr}</div>}
            </div>
          )}
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <KVListEditor
            label="槽位中文标签（可选）"
            hint="键 = 槽位名，值 = 展示用中文；用于详情页与绑定下拉的可读标签"
            value={slotLabelRows}
            onChange={setSlotLabelRows}
            valuePlaceholder="如 认证口令"
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {isEdit ? '保存' : '创建（存为草稿）'}
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, span, children }: { label: string; span?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4, ...(span ? { gridColumn: '1 / -1' } : {}) }}>
      <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{label}</span>
      {children}
    </label>
  );
}

/**
 * 实时槽位预览（编辑条目时）。
 *
 * 为什么需要：厂商 README 通常写「设置环境变量 ES_URL」而不提"要用 `${ES_URL}` 占位符"。
 * 用户照抄成空值 → 槽位识别不到 → 子进程拿空 URL 直接退出（Connection closed），
 * 且报错信息只有 zod 校验尾巴，非常难自查。这里在编辑时就给出结论与一键修正建议。
 */
function SlotPreviewHint({
  env, args, headers,
}: {
  env: Record<string, string>;
  args: string[];
  headers: Record<string, string>;
}) {
  const slots = detectSlots({ env, args, headers });
  // 空值或字面量的敏感项：这些多半应该是占位符
  const suspect = [
    ...Object.entries(env).map(([k, v]) => ({ where: 'env', key: k, value: v })),
    ...Object.entries(headers).map(([k, v]) => ({ where: 'headers', key: k, value: v })),
  ].filter(({ key, value }) => /url|host|token|key|password|secret|user|user_?name|endpoint|dsn/i.test(key)
    && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test((value ?? '').trim()));

  const applyFix = () => {
    // 仅生成建议文本，不自动改写表单（避免用户不知情地被改配置）
    const lines = suspect.map((s) => `${s.where === 'env' ? '环境变量' : '请求头'} ${s.key} → \${${s.key}}`).join('\n');
    void navigator.clipboard?.writeText(lines);
  };

  if (slots.length === 0 && suspect.length === 0) {
    return (
      <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
        未识别到槽位。若该 MCP 需要认证/地址，把对应值写成 <code className="mono">{'${变量名}'}</code> 即可自动识别为槽位。
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 6, padding: '10px 12px', borderRadius: 'var(--r-md)', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--fg-2)' }}>
        <Info size={12} strokeWidth={2} /> 槽位识别结果（保存后生效）
      </div>
      {slots.length > 0 ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-2)' }}>
          识别到 <b>{slots.length}</b> 个槽位：
          {slots.map((s) => (
            <span key={s.name} className="mono" style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              {s.name}
            </span>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>暂无槽位。</div>
      )}

      {suspect.length > 0 && (
        <div style={{ display: 'grid', gap: 4, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warn)', fontWeight: 600 }}>
            这 {suspect.length} 项看着该是槽位，但当前是空值/字面量——子进程很可能拿不到配置而起不来：
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.8 }}>
            {suspect.map((s) => (
              <div key={`${s.where}:${s.key}`}>
                {s.key} = <span style={{ color: 'var(--danger)' }}>{s.value === '' ? '（空）' : s.value}</span>
                {'  →  '}
                <span style={{ color: 'var(--success)' }}>{'${'}{s.key}{'}'}</span>
              </div>
            ))}
          </div>
          <button type="button" className="btn" style={{ justifySelf: 'start', minHeight: 26, padding: '2px 8px', fontSize: 11 }} onClick={applyFix}>
            复制修正建议
          </button>
        </div>
      )}
    </div>
  );
}
