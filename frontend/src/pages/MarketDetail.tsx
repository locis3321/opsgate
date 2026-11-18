import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Store, Plus, Code, Package, ExternalLink, BookOpen, RefreshCw, Loader2 } from 'lucide-react';
import { api, ApiError } from '../api';
import SlotValueEditor from '../components/SlotValueEditor';
import MarkdownView from '../components/MarkdownView';
import { StringListEditor, KVListEditor } from '../components/ConfigEditors';
import { detectSlots, SLOT_PLACEHOLDER_RE, slotLabel } from '../slots';

interface Detail {
  key: string; displayName: string; description: string; repository: string; runtime: string;
  executionMode?: 'mcp' | 'native';
  categories?: string[];
  preview: {
    command: string; args: string[]; env: Record<string, string>;
    url: string | null; headers: Record<string, string>;
  };
  slots: Array<{ target: string; name: string; label: string; file: boolean; sensitive: boolean }>;
  addedCount: number;
}
interface Candidate { id: string; name: string; kind: string; valueHint: string; keys?: string[] }
interface InstResult { server: { id: string }; missingSlots: string[] }

type KV = { key: string; value: string };

/** 配置（可编辑）：目录默认值 + 用户追加的参数/env/kv */
interface CfgForm {
  command: string;
  args: string[];
  env: KV[];
  headers: KV[];
  url: string | null;
}

const recToRows = (rec: Record<string, string>): KV[] =>
  Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));
const rowsToRec = (rows: KV[]): Record<string, string> =>
  Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]));

/** 表单形态与 JSON 形态互转（JSON 为「自定义 JSON 方式添加」入口） */
function toJson(c: CfgForm): string {
  return JSON.stringify(
    {
      command: c.command,
      args: c.args,
      env: rowsToRec(c.env),
      headers: rowsToRec(c.headers),
      ...(c.url ? { url: c.url } : {}),
    },
    null,
    2,
  );
}

function fromJson(text: string): CfgForm {
  const p = JSON.parse(text) as Record<string, unknown>;
  return {
    command: typeof p.command === 'string' ? p.command : '',
    args: Array.isArray(p.args) ? p.args.map((a) => String(a)) : [],
    env: recToRows(p.env as Record<string, string>),
    headers: recToRows(p.headers as Record<string, string>),
    url: typeof p.url === 'string' ? p.url : null,
  };
}

/** Market 条目详情 + 添加面板（全程无 JSON Schema 编辑，AC-64）。
 *  配置可编辑（表单 / JSON 两种方式）：在目录默认配置上追加参数、env、kv；
 *  槽位取值两种方式二选一：直接输入值（资产自带直填值，ADR-027）或从 + 下拉选择已有凭证。 */
export default function MarketDetail() {
  const { key } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['market-detail', key], queryFn: () => api<Detail>(`/api/v1/market/catalog/${key}`) });
  const cands = useQuery({ queryKey: ['my-credential-candidates'], queryFn: () => api<Candidate[]>('/api/v1/credentials/candidates') });
  const [name, setName] = useState('');
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [inlineValues, setInlineValues] = useState<Record<string, string>>({});
  const [cfg, setCfg] = useState<CfgForm | null>(null);
  const [cfgMode, setCfgMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  const [err, setErr] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  /** 渐进披露（T3）：高级配置默认收起，主路径只露名称 + 槽位取值 */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const initKey = useRef('');

  const d = detail.data;
  /** 平台内建条目（网关内建 HTTP 工具）：无配置可编辑，地址由用户填写 */
  const isNative = d?.executionMode === 'native';
  const [nativeUrl, setNativeUrl] = useState('');
  const [nativeAllowPrivate, setNativeAllowPrivate] = useState(false);
  const [allowInsecureTls, setAllowInsecureTls] = useState(false);

  // 首次拿到条目时用目录默认配置初始化（条目切换才重置，用户编辑不丢）
  useEffect(() => {
    if (!d) return;
    if (initKey.current === d.key) return;
    initKey.current = d.key;
    const init: CfgForm = {
      command: d.preview.command ?? '',
      args: [...(d.preview.args ?? [])],
      env: recToRows(d.preview.env),
      headers: recToRows(d.preview.headers),
      url: d.preview.url ?? null,
    };
    setCfg(init);
    setJsonText(toJson(init));
    setJsonErr('');
  }, [d]);

  /** 当前生效的 env / headers 映射（空键忽略） */
  const envMap = useMemo(() => rowsToRec(cfg?.env ?? []), [cfg]);
  const headerMap = useMemo(() => rowsToRec(cfg?.headers ?? []), [cfg]);
  /** 槽位按当前配置实时识别（改了 env/args/headers → 槽位随之变化）。
   *  原生条目没有可扫描的配置，槽位由目录条目声明（后端 detectSlots 已按 slotLabels 返回）。 */
  const slots = useMemo(
    () => (isNative ? (d?.slots ?? []) : cfg ? detectSlots({ env: envMap, args: cfg.args, headers: headerMap }) : []),
    [isNative, d?.slots, cfg, envMap, headerMap],
  );

  const switchMode = (m: 'form' | 'json') => {
    if (m === cfgMode) return;
    if (m === 'json') {
      if (!cfg) return;
      setJsonText(toJson(cfg));
      setJsonErr('');
      setCfgMode('json');
      return;
    }
    try {
      setCfg(fromJson(jsonText));
      setJsonErr('');
      setCfgMode('form');
    } catch (e) {
      setJsonErr('JSON 解析失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const onJsonChange = (text: string) => {
    setJsonText(text);
    try {
      setCfg(fromJson(text));
      setJsonErr('');
    } catch (e) {
      setJsonErr('JSON 解析失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const inst = useMutation({
    mutationFn: async () => {
      // 直填值与凭证绑定同批提交：后端在**单事务**内落库，任一失败整体回滚（T1-4 原子化）。
      // 此前是"先实例化再逐槽位 PUT"，中途失败会留下半成品资产。
      const inlineToSubmit: Record<string, string> = {};
      for (const s of slots) {
        if (refs[s.name]) continue;
        const v = (inlineValues[s.name] ?? '').trim();
        if (v) inlineToSubmit[s.name] = v;
      }
      const payload: Record<string, unknown> = {
        pkgName: key,
        name,
        credentialRefs: refs,
        inlineValues: inlineToSubmit,
        // 平台内建条目：地址由用户填写，不传可编辑配置
        ...(isNative
          ? { url: nativeUrl.trim(), ...(nativeAllowPrivate ? { allowPrivateNetwork: true } : {}), ...(allowInsecureTls ? { allowInsecureTls: true } : {}) }
          : {
              // 配置以用户编辑结果为准（未编辑时与目录默认值相同）
              config: cfg
                ? { command: cfg.command, args: cfg.args, env: envMap, headers: headerMap, url: cfg.url }
                : undefined,
            }),
      };
      return api<InstResult>('/api/v1/market/instantiate', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (res) => { void qc.invalidateQueries({ queryKey: ['market'] }); nav(`/assets/${res.server.id}`); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '实例化失败'),
  });

  /** 槽位已绑定的凭证展示信息 */
  const boundInfo = (slotName: string) => {
    const cid = refs[slotName];
    if (!cid) return undefined;
    const c = (cands.data ?? []).find((x) => x.id === cid);
    return { id: cid, name: c?.name ?? '凭证已删除', valueHint: c?.valueHint ?? '****' };
  };

  /**
   * 行内取值控件（T19）：配置里写的是 `${VAR}` 占位符时，该行的值输入框直接换成
   * "填值 / 选凭证"控件，不再在下方重复列一遍槽位。
   * 返回 null 表示这行不是占位符，交给编辑器渲染普通输入框。
   */
  const renderSlotValue = (raw: string) => {
    const m = SLOT_PLACEHOLDER_RE.exec(raw);
    if (!m) return null;
    const name = m[1]!;
    const detected = slots.find((s) => s.name === name);
    return (
      <div style={{ flex: 3 }}>
        <SlotValueEditor
          slotName={name}
          label={detected?.label ?? slotLabel(name)}
          isFile={detected?.file}
          candidates={cands.data ?? []}
          value={inlineValues[name] ?? ''}
          bound={boundInfo(name)}
          onValueChange={(v) => setInlineValues((prev) => ({ ...prev, [name]: v }))}
          onPick={(cid) => {
            setRefs((prev) => ({ ...prev, [name]: cid }));
            setInlineValues((prev) => { const n = { ...prev }; delete n[name]; return n; });
          }}
          onUnbind={() => setRefs((prev) => { const n = { ...prev }; delete n[name]; return n; })}
        />
      </div>
    );
  };

  if (detail.isLoading) return (
    <div className="page animate-slide-up">
      <div className="card" style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </div>
        <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>加载中…</span>
      </div>
    </div>
  );
  if (!d) return (
    <div className="page animate-slide-up">
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 16px', borderRadius: 'var(--radius-lg)',
        background: 'var(--danger-soft)', border: '1px solid var(--danger)',
      }}>
        <span style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>条目不存在</span>
      </div>
    </div>
  );
  return (
    <div className="page animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn" onClick={() => nav(-1)} style={{ padding: '7px 10px', minHeight: 34 }}>
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent-soft)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Package size={18} style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
          </div>
          <div>
            <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650 }}>{d.displayName}</h1>
            <p style={{ color: 'var(--muted)', margin: '2px 0 0', fontSize: 'var(--text-sm)' }}>
              Market 条目详情 · 添加并绑定至资产
            </p>
          </div>
        </div>
      </div>

      <VersionHint entryKey={d.key} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 20, display: 'grid', gap: 10, alignSelf: 'start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Store size={15} style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
            <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>条目信息</span>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>{d.description}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="tag">{isNative ? '平台内建' : d.runtime}</span>
            {(d.addedCount ?? 0) > 0
              ? <span className="tag" style={{ color: 'var(--success)', background: 'var(--success-soft)' }}>已添加（{d.addedCount} 个资产）</span>
              : <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>未添加</span>}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)' }}>
            <a href={d.repository} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              仓库链接 <ExternalLink size={12} strokeWidth={1.8} />
            </a>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', lineHeight: 1.6, marginTop: 4 }}>
            {isNative
              ? '工具由网关进程内直接实现（不起子进程、无实例池）：添加资产后即可调用，不涉及实例预热'
              : '使用前需先实例化（右侧"添加并绑定"）；首次调用时实例池现场拉起，预热可提前缓存'}
          </div>
          <ReadmePanel entryKey={d.key} />
        </div>

        <div className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Plus size={15} style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
            <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>添加并绑定</span>
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>资产名称</label>
            <input className="input" placeholder="如 mysql-prod-01" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {isNative && (
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>管理 API 地址</label>
              <input
                className="input mono"
                placeholder="如 http://rocketmq-dashboard.internal:8080"
                value={nativeUrl}
                onChange={(e) => setNativeUrl(e.target.value)}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                <input type="checkbox" checked={nativeAllowPrivate} onChange={(e) => setNativeAllowPrivate(e.target.checked)} />
                允许私网访问（内网地址必选；变更写治理审计）
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                <input type="checkbox" checked={allowInsecureTls} onChange={(e) => setAllowInsecureTls(e.target.checked)} />
                允许不安全 TLS（自签证书；关闭证书校验会失去中间人防护）
              </label>
              <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                该条目是平台内建工具（网关进程内直连，不起子进程）。地址随部署而变，由你在这里填写。
              </div>
            </div>
          )}

          {/* 配置：渐进披露（默认收起，主路径只露名称 + 槽位取值）。原生条目无安装配置，不渲染。 */}
          <div style={{ display: isNative ? 'none' : 'grid', gap: 6 }}>
            <button
              type="button"
              className="btn"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              style={{ justifyContent: 'space-between', minHeight: 32 }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Code size={13} strokeWidth={1.8} />
                高级：编辑安装配置
              </span>
              <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>{advancedOpen ? '收起' : '展开'}</span>
            </button>
            {advancedOpen && (
            <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>配置</span>
              <div className="segmented" style={{ marginLeft: 'auto' }}>
                <button type="button" aria-selected={cfgMode === 'form'} onClick={() => switchMode('form')}>表单</button>
                <button type="button" aria-selected={cfgMode === 'json'} onClick={() => switchMode('json')}>JSON</button>
              </div>
            </div>
            {cfgMode === 'form' ? (
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'grid', gap: 4 }}>
                  <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>启动命令</label>
                  <input
                    className="input mono"
                    value={cfg?.command ?? ''}
                    onChange={(e) => setCfg((c) => (c ? { ...c, command: e.target.value } : c))}
                  />
                </div>
                <StringListEditor
                  label="参数（args）"
                  hint="可追加额外参数；某参数为 ${VAR} 时该行直接填值/选凭证"
                  value={cfg?.args ?? []}
                  onChange={(v) => setCfg((c) => (c ? { ...c, args: v } : c))}
                  renderValue={(_i, cur) => renderSlotValue(cur)}
                />
                <KVListEditor
                  label="环境变量（env）"
                  hint="值为 ${VAR} 时该行直接填值/选凭证"
                  value={cfg?.env ?? []}
                  onChange={(v) => setCfg((c) => (c ? { ...c, env: v } : c))}
                  valuePlaceholder="${VAR} 或值"
                  renderValue={(_i, row) => renderSlotValue(row.value)}
                />
                <KVListEditor
                  label="请求头（headers）"
                  hint="HTTP/SSE 型才生效；值为 ${VAR} 时直接填值/选凭证"
                  value={cfg?.headers ?? []}
                  onChange={(v) => setCfg((c) => (c ? { ...c, headers: v } : c))}
                  valuePlaceholder="${VAR} 或值"
                  renderValue={(_i, row) => renderSlotValue(row.value)}
                />
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                <textarea
                  className="input mono"
                  rows={10}
                  spellCheck={false}
                  value={jsonText}
                  onChange={(e) => onJsonChange(e.target.value)}
                  style={{ fontSize: 12 }}
                />
                {jsonErr && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{jsonErr}</div>}
              </div>
            )}
            </>
            )}
          </div>

          {/* 原生条目：槽位没有可内联的配置行，单独列出（每个槽位填值或选凭证） */}
          {isNative && slots.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              <span style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>凭证</span>
              {slots.map((s) => (
                <SlotValueEditor
                  key={s.name}
                  slotName={s.name}
                  label={s.label}
                  isFile={s.file}
                  candidates={cands.data ?? []}
                  value={inlineValues[s.name] ?? ''}
                  bound={boundInfo(s.name)}
                  onValueChange={(v) => setInlineValues((prev) => ({ ...prev, [s.name]: v }))}
                  onPick={(cid) => {
                    setRefs((prev) => ({ ...prev, [s.name]: cid }));
                    setInlineValues((prev) => { const n = { ...prev }; delete n[s.name]; return n; });
                  }}
                  onUnbind={() => setRefs((prev) => { const n = { ...prev }; delete n[s.name]; return n; })}
                />
              ))}
            </div>
          )}

          {/* 槽位取值已内联到 env / args / headers 的占位符行（T19），此处仅提示 */}
          <div style={{ color: 'var(--meta)', fontSize: 12, lineHeight: 1.6 }}>
            {slots.length === 0 ? (
              isNative
                ? <>该条目没有凭证槽位；若产品需要鉴权，由目录维护者补充槽位声明。</>
                : <>当前配置未识别到凭证槽位。在 env / args / headers 的值里写 <code className="mono">{'${VAR}'}</code> 占位符即可自动识别。</>
            ) : (
              <>已识别 {slots.length} 个凭证槽位，直接在上方填写值或点 <code className="mono">+</code> 选择已有凭证；两者都不填则该槽位不注入，产品需要它会自己报错。</>
            )}
          </div>

          {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
          <button
            className="btn btn-primary"
            onClick={() => inst.mutate()}
            disabled={inst.isPending}
            style={{ justifyContent: 'center', gap: 6 }}
          >
            {inst.isPending && <Loader2 size={14} strokeWidth={2} className="spin" />}
            {inst.isPending ? '添加中…' : '添加并绑定'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <button className="btn" onClick={() => setShowConfig(!showConfig)} style={{ gap: 6 }}>
          <Code size={14} strokeWidth={1.8} /> 查看将生成的配置
        </button>
        {showConfig && (
          <pre className="mono" style={{ marginTop: 12, color: 'var(--fg-2)', whiteSpace: 'pre-wrap', fontSize: 'var(--text-sm)', background: 'var(--surface-raise)', padding: 16, borderRadius: 'var(--radius)' }}>
            {isNative
              ? JSON.stringify(
                  {
                    executionMode: 'native',
                    category: d?.categories?.[0] ?? '',
                    url: nativeUrl.trim() || '<待填管理 API 地址>',
                    allowPrivateNetwork: nativeAllowPrivate,
                    credentialSlots: slots.map((s) => s.name),
                  },
                  null,
                  2,
                )
              : toJson(cfg ?? { command: '', args: [], env: [], headers: [], url: null })}
          </pre>
        )}
      </div>
    </div>
  );
}

interface ReadmeResp {
  markdown: string | null;
  stale: boolean;
  repository: string;
  fetchedAt: number | null;
  error?: string;
}

/** README 面板（T5/T17）：默认折叠；失败显示原因并给出重试，不显示空白。 */
function ReadmePanel({ entryKey }: { entryKey: string }) {
  const [open, setOpen] = useState(true);
  const [retry, setRetry] = useState(0);
  const q = useQuery({
    queryKey: ['market-readme', entryKey, retry],
    queryFn: () => api<ReadmeResp>(`/api/v1/market/catalog/${encodeURIComponent(entryKey)}/readme`),
    // 进入详情即拉取（README 是判断"这个 MCP 能干什么"的主要依据，不该藏在按钮后面）
    staleTime: 10 * 60_000,
  });

  return (
    <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <BookOpen size={14} style={{ color: 'var(--meta)' }} strokeWidth={1.8} />
        <button
          className="btn"
          style={{ padding: '2px 8px', fontSize: 'var(--text-xs)' }}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起 README' : '展开 README'}
        </button>
        {open && q.data?.stale && (
          <span style={{ color: 'var(--meta)', fontSize: 11 }}>缓存内容，正在后台刷新</span>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 8 }}>
          {q.isLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
              <div style={{ width: 13, height: 13, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              正在抓取 README…
            </div>
          )}

          {q.isError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-xs)' }}>
              <span style={{ color: 'var(--danger)' }}>
                README 加载失败：{q.error instanceof ApiError ? q.error.message : '请求失败'}
              </span>
              <button className="btn" style={{ gap: 4, fontSize: 11, padding: '2px 8px' }} onClick={() => setRetry(retry + 1)}>
                <RefreshCw size={11} strokeWidth={2} /> 重试
              </button>
            </div>
          )}

          {q.data && !q.data.markdown && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)' }}>
              {q.data.error ?? '该条目暂无 README 内容'}
              <div style={{ marginTop: 4 }}>
                <a href={q.data.repository} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  在源站查看 <ExternalLink size={11} strokeWidth={1.8} />
                </a>
              </div>
            </div>
          )}

          {q.data?.markdown && (
            <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
              <MarkdownView text={q.data.markdown} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface AdminEntryInfo {
  versionPinned: string | null;
  versionLatest: string | null;
  upgradeAvailable: boolean;
}

/** 版本升级提示条（T6/T17）：仅管理员可见；普通用户不感知版本信息。 */
function VersionHint({ entryKey }: { entryKey: string }) {
  const isAdminQ = useQuery({
    queryKey: ['session-isadmin'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { isAdmin?: boolean } };
      return Boolean(j?.user?.isAdmin);
    },
    staleTime: 60_000,
  });
  const isAdmin = isAdminQ.data === true;
  const q = useQuery({
    queryKey: ['market-entry-version', entryKey],
    queryFn: () => api<AdminEntryInfo>(`/api/v1/market/entries/${encodeURIComponent(entryKey)}`),
    enabled: isAdmin,
    staleTime: 60_000,
  });
  if (!isAdmin || !q.data?.upgradeAvailable) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 14px', borderRadius: 'var(--radius-lg)',
      background: 'var(--accent-soft)', border: '1px solid var(--accent)',
      fontSize: 'var(--text-sm)', color: 'var(--fg)',
    }}>
      <RefreshCw size={14} strokeWidth={1.8} style={{ color: 'var(--accent)', flexShrink: 0 }} />
      <span>
        有新版本 <span className="mono">{q.data.versionLatest}</span> 可用（当前锁定{' '}
        <span className="mono">{q.data.versionPinned}</span>）
      </span>
      <span style={{ color: 'var(--meta)', fontSize: 11 }}>如需升级请到「管理目录」编辑安装配置</span>
    </div>
  );
}
