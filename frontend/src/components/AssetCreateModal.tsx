import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Store, Terminal, Globe, Radio, Plus, ShieldAlert, KeyRound, FileKey } from 'lucide-react';
import { api, ApiError } from '../api';
import Modal from './Modal';
import Tabs from './Tabs';
import Combobox from './Combobox';
import SlotValueEditor, { type CredCandidate } from './SlotValueEditor';
import { detectSlots, detectPlaintextSecrets } from '../slots';
import { StringListEditor, KVListEditor } from './ConfigEditors';

/**
 * 新建资产弹窗（§8.5）：三条创建路径统一入口。
 * 1) 原生主机 —— category=host + executionMode=native（不走 Market，ADR-022）
 * 2) MCP 资产 —— 从 Market 目录选条目（自动展开配置 + 槽位识别 + 凭证绑定）
 * 3) MCP 资产 —— 自定义（协议 stdio/http/sse + 手填连接配置 + 槽位凭证绑定）
 *
 * 凭证绑定统一走槽位机制（`${NAME}` 占位符 → server_credentials）；
 * 也可在 env/args/headers 中直接写 `ref.<凭证名>.<键名>` 引用已有凭证（一个凭证可服务多个资产）。
 */

interface CatalogItem { key: string; displayName: string; description: string; categories: string[]; runtime: string; executionMode?: 'mcp' | 'native' }
interface CatalogDetail {
  key: string; displayName: string; description: string; runtime: string;
  executionMode?: 'mcp' | 'native';
  preview: { command: string; args: string[]; env: Record<string, string>; url: string | null; headers: Record<string, string> };
  slots: Array<{ target: string; name: string; label: string; file: boolean }>;
}
type Candidate = CredCandidate;

type Protocol = 'stdio' | 'http' | 'sse';
type Tab = 'market' | 'custom';

/** 市场 tab 里的内建工具：SSH 主机（网关内建 ssh2 直连，非社区 MCP） */
const NATIVE_TOOL = '__native_ssh__';

const PROTOCOLS: Array<{ value: Protocol; label: string; icon: typeof Terminal; hint: string }> = [
  { value: 'stdio', label: 'stdio', icon: Terminal, hint: '本地子进程，经标准输入输出通信' },
  { value: 'http', label: 'http', icon: Globe, hint: 'Streamable HTTP 远端服务' },
  { value: 'sse', label: 'sse', icon: Radio, hint: '旧式 SSE 长连接服务' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>{label}</label>
      {children}
      {hint && <div style={{ color: 'var(--meta)', fontSize: 12, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

export default function AssetCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('market');
  const [marketTool, setMarketTool] = useState('');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');

  // 原生主机（市场 tab 的内建工具）
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  /** SSH 认证方式：与 ssh 协议一致，只有两种（口令槽位仅私钥方式可选用） */
  const [sshAuthMethod, setSshAuthMethod] = useState<'password' | 'key'>('password');
  /**
   * 槽位名由系统固定，用户不需要理解也不需要命名：
   * - 密码方式：`AUTH`（值为密码）
   * - 私钥方式：`AUTH`（值为私钥）+ 可选 `AUTH_PASS`（值为口令）
   * 这样与其它品类的槽位机制一致，UI 上只呈现"密码 / 私钥+口令"。
   */
  const authSlot = 'AUTH';

  // 自定义 MCP
  const [protocol, setProtocol] = useState<Protocol>('stdio');
  const [category, setCategory] = useState('other');
  const [command, setCommand] = useState('');
  const [argsRows, setArgsRows] = useState<string[]>([]);
  const [envRows, setEnvRows] = useState<Array<{ key: string; value: string }>>([]);
  const [url, setUrl] = useState('');
  const [headersRows, setHeadersRows] = useState<Array<{ key: string; value: string }>>([]);
  /** 目录条目为平台内建工具时的私网开关（内网部署必选，否则 SSRF fail-closed 拒绝保存） */
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [allowInsecureTls, setAllowInsecureTls] = useState(false);

  const [bindings, setBindings] = useState<Record<string, string>>({});

  /** Market 目录条目 key（非内建工具时） */
  const marketKey = marketTool && marketTool !== NATIVE_TOOL ? marketTool : '';
  const isNativeTool = marketTool === NATIVE_TOOL;

  const catalog = useQuery({
    queryKey: ['market-catalog'],
    queryFn: () => api<{ items: CatalogItem[] }>('/api/v1/market/catalog?page=1'),
  });
  const detail = useQuery({
    queryKey: ['market-detail', marketKey],
    queryFn: () => api<CatalogDetail>(`/api/v1/market/catalog/${marketKey}`),
    enabled: marketKey !== '',
  });
  const cands = useQuery({
    queryKey: ['credential-candidates'],
    queryFn: () => api<Candidate[]>('/api/v1/credentials/candidates'),
  });

  // 槽位直接输入的值（提交时写入资产本身，ADR-027：直填值不是凭证）
  const [slotValues, setSlotValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setBindings({}); setSlotValues({}); setErr('');
  }, [marketTool]);

  const marketSlots = useMemo(() => detail.data?.slots ?? [], [detail.data]);
  /** 目录条目本身是平台内建工具（executionMode=native），与内建 SSH 主机不是一回事 */
  const isNativeEntry = detail.data?.executionMode === 'native';

  // 内建 SSH 主机的槽位：槽位名由系统固定，标签按"认证方式"直白呈现，用户无需理解 AUTH 这类内部名
  const nativeSlots = useMemo(() => {
    const out: Array<{ target: 'env'; name: string; label: string; file: boolean }> = [];
    if (sshAuthMethod === 'password') {
      out.push({ target: 'env', name: 'AUTH', label: 'SSH 密码', file: false });
    } else {
      out.push({ target: 'env', name: 'AUTH', label: 'SSH 私钥', file: true });
      out.push({ target: 'env', name: 'AUTH_PASS', label: '私钥口令（可选）', file: false });
    }
    return out;
  }, [sshAuthMethod]);

  // 自定义模式的槽位（实时从表单行识别）
  const customSlots = useMemo(() => {
    const env = Object.fromEntries(envRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]));
    const headers = Object.fromEntries(headersRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]));
    const args = argsRows.filter((r) => r.trim());
    return detectSlots({ env, args, headers });
  }, [envRows, argsRows, headersRows]);

  const slots = tab === 'market' ? (isNativeTool ? nativeSlots : marketSlots) : customSlots;

  /** 明文密钥提示（T5-3）：配置里直接写死的敏感值会被明文落库，建议改用 ${SLOT} 占位符 */
  const plaintextHits = useMemo(() => {
    // 原生条目没有可扫描的配置（工具直连产品 API），不存在明文落库风险
    if (isNativeTool || isNativeEntry) return [];
    const env = tab === 'custom'
      ? Object.fromEntries(envRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]))
      : (detail.data?.preview.env ?? {});
    const headers = tab === 'custom'
      ? Object.fromEntries(headersRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]))
      : (detail.data?.preview.headers ?? {});
    const args = tab === 'custom' ? argsRows.filter((r) => r.trim()) : (detail.data?.preview.args ?? []);
    return detectPlaintextSecrets({ env, args, headers });
  }, [tab, envRows, headersRows, argsRows, detail.data, isNativeTool, isNativeEntry]);
  /** 市场 tab 未选工具 / 内建主机未填认证槽位时无槽位可绑，不渲染凭证绑定区 */
  // 内建 SSH：凭证绑定区块**始终显示**——认证是必填事实，不该等用户先猜一个槽位名才露出来
  const showSlots = tab === 'custom' ? true : isNativeTool ? true : marketKey !== '';
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string }>('/api/v1/servers', { method: 'POST', body: JSON.stringify(body) }),
  });
  const instantiate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ server: { id: string } }>('/api/v1/market/instantiate', { method: 'POST', body: JSON.stringify(body) }),
  });

  const busy = create.isPending || instantiate.isPending;

  /** 用户已填入任何内容即视为"未保存修改"，关闭时需确认（避免误丢表单） */
  const dirty = Boolean(
    marketTool || name.trim() || displayName.trim() || host.trim() || username.trim() || authSlot.trim()
    || command.trim() || url.trim() || argsRows.some((r) => r.trim())
    || envRows.some((r) => r.key.trim()) || headersRows.some((r) => r.key.trim())
    || Object.keys(bindings).length > 0 || Object.values(slotValues).some((v) => v.trim()),
  );

  const submit = async () => {
    setErr('');
    try {
      if (!name.trim()) throw new Error('资产名称必填');

      // 市场 · 内建 SSH 主机（网关内建 ssh2 直连）
      if (tab === 'market' && isNativeTool) {
        if (!host.trim() || !username.trim()) throw new Error('主机地址与 SSH 用户名必填');
        const res = await create.mutateAsync({
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          type: 'native',
          executionMode: 'native',
          category: 'host',
          hostConn: {
            host: host.trim(),
            port: Number(port) || 22,
            username: username.trim(),
            authSlot,
            // 仅私钥方式下才有口令槽位（AUTH_PASS），密码方式不设
            ...(sshAuthMethod === 'key' ? { authPassSlot: 'AUTH_PASS' } : {}),
          },
          credentialSlots: nativeSlots,
          credentialBindings: pickBindings(nativeSlots.map((s) => s.name)),
          inlineValues: pickInlineValues(nativeSlots.map((s) => s.name)),
        });
        onCreated(res.id);
        return;
      }

      // 市场 · Market 目录条目：目录展开 + 槽位绑定 + 直填值由后端一次原子完成
      if (tab === 'market') {
        if (!marketKey) throw new Error('请选择工具');
        const isNativeEntry = detail.data?.executionMode === 'native';
        if (isNativeEntry && !url.trim()) throw new Error('该条目为平台内建工具，请填写管理 API 地址');
        const res = await instantiate.mutateAsync({
          pkgName: marketKey,
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          credentialRefs: pickBindings(marketSlots.map((s) => s.name)),
          inlineValues: pickInlineValues(marketSlots.map((s) => s.name)),
          ...(isNativeEntry ? { url: url.trim(), ...(allowPrivate ? { allowPrivateNetwork: true } : {}), ...(allowInsecureTls ? { allowInsecureTls: true } : {}) } : {}),
        });
        onCreated(res.server.id);
        return;
      }

      // 自定义 MCP
      const args = argsRows.filter((r) => r.trim());
      const env = Object.fromEntries(envRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]));
      const headers = Object.fromEntries(headersRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]));
      if (protocol === 'stdio' && !command.trim()) throw new Error('stdio 协议需要填写启动命令');
      if (protocol !== 'stdio' && !url.trim()) throw new Error(`${protocol} 协议需要填写服务地址`);

      const res = await create.mutateAsync({
        name: name.trim(),
        displayName: displayName.trim() || undefined,
        type: protocol,
        executionMode: 'mcp',
        category,
        ...(protocol === 'stdio' ? { command: command.trim(), args, env } : { url: url.trim(), headers }),
        ...(allowInsecureTls ? { allowInsecureTls: true } : {}),
        credentialSlots: customSlots,
        credentialBindings: pickBindings(customSlots.map((s) => s.name)),
        inlineValues: pickInlineValues(customSlots.map((s) => s.name)),
      });
      onCreated(res.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  };

  /** 只收集真正选了凭证的槽位（未选不传，由后端判 missing） */
  const pickBindings = (slotNames: string[]) => {
    const out: Record<string, string> = {};
    for (const name of slotNames) {
      const cid = bindings[name];
      if (cid) out[name] = cid;
    }
    return out;
  };

  /** 只收集真正填了值的槽位（已绑定凭证的槽位互斥，不传） */
  const pickInlineValues = (slotNames: string[]) => {
    const out: Record<string, string> = {};
    for (const name of slotNames) {
      if (bindings[name]) continue;
      const v = (slotValues[name] ?? '').trim();
      if (v) out[name] = v;
    }
    return out;
  };

  /** 槽位当前绑定的凭证展示信息 */
  const boundInfo = (slotName: string) => {
    const id = bindings[slotName];
    if (!id) return undefined;
    const c = (cands.data ?? []).find((x) => x.id === id);
    return c ? { id, name: c.name, valueHint: c.valueHint } : { id, name: '凭证已删除', valueHint: '****' };
  };

  const slotBindings = (
    <Section title="凭证绑定">
      {slots.length === 0 ? (
        <div style={{ color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>
          未识别到凭证槽位。若服务需要认证，在配置里写 <code className="mono">{'${VAR}'}</code> 占位符即可自动识别为槽位。
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {slots.map((s) => (
            <SlotValueEditor
              key={s.name}
              slotName={s.name}
              label={s.label}
              isFile={s.file}
              candidates={cands.data ?? []}
              value={slotValues[s.name] ?? ''}
              bound={boundInfo(s.name)}
              onValueChange={(v) => setSlotValues((prev) => ({ ...prev, [s.name]: v }))}
              onPick={(cid) => {
                setBindings((prev) => ({ ...prev, [s.name]: cid }));
                // 绑定与直填值互斥：选了凭证就丢掉手填值
                setSlotValues((prev) => { const n = { ...prev }; delete n[s.name]; return n; });
              }}
              onUnbind={() => setBindings((prev) => { const n = { ...prev }; delete n[s.name]; return n; })}
            />
          ))}
        </div>
      )}
      <div style={{ color: 'var(--meta)', fontSize: 12, lineHeight: 1.6 }}>
        每个槽位两种取值方式二选一：直接在上方输入框填写凭证值，或点右侧 <code className="mono">+</code> 选择已有凭证。
        两者都不填则该槽位不注入，产品若需要它会自己报错。
        也可在 env / args / headers 中写 <code className="mono">ref.凭证名.键名</code> 直接引用，无需槽位绑定。
        凭证列表仅显示本人创建的凭证（共享凭证只能使用、不能绑定）。
      </div>
    </Section>
  );

  return (
    <Modal title="新建资产" onClose={onClose} width={680} dirty={dirty} dirtyMessage="新建资产的填写内容尚未提交，关闭将丢失。">
      <Tabs
        tabs={[
          { value: 'market' as Tab, label: '市场', icon: <Store size={14} strokeWidth={1.8} /> },
          { value: 'custom' as Tab, label: '自定义', icon: <Plus size={14} strokeWidth={1.8} /> },
        ]}
        value={tab}
        onChange={(v) => { setTab(v); setErr(''); setBindings({}); setSlotValues({}); }}
      />

      {tab === 'market' && (
        <Field label="工具" hint="内建工具由网关直接实现；Market 条目由社区 MCP 实现，选中后自动展开配置并识别凭证槽位">
          <Combobox
            ariaLabel="选择工具"
            value={marketTool}
            onChange={setMarketTool}
            placeholder="请选择工具…"
            searchPlaceholder="搜索工具或内建项…"
            options={[
              // 「内建」= 网关自身实现的工具（SSH 直连 + Zabbix/RocketMQ/Nacos 等 HTTP 原生工具）
              { value: NATIVE_TOOL, label: 'SSH 主机（网关内建 · ssh2 直连）', hint: '内建', group: '内建', icon: <Terminal size={13} strokeWidth={1.8} /> },
              ...(catalog.data?.items ?? [])
                .filter((it) => it.executionMode === 'native')
                .map((it) => ({ value: it.key, label: it.displayName, hint: '内建', group: '内建' })),
              // 「Market 目录」= 社区 MCP 实现（子进程/远端服务）
              ...(catalog.data?.items ?? [])
                .filter((it) => it.executionMode !== 'native')
                .map((it) => ({ value: it.key, label: it.displayName, hint: it.runtime, group: 'Market 目录' })),
            ]}
          />
        </Field>
      )}

      <Section title="基础信息">
        <Field label="资产名称">
          <input className="input" placeholder="DNS-1123，如 web-01" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="显示名（可选）">
          <input className="input" placeholder="展示用名称" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
      </Section>

      {tab === 'market' ? (
        isNativeTool ? (
          <Section title="连接信息">
            <Field label="主机地址">
              <input className="input" placeholder="10.0.0.1" value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <Field label="端口">
              <input className="input" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
            <Field label="SSH 用户名">
              <input className="input" placeholder="root" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="认证方式" hint="与 SSH 协议一致：账号密码，或私钥（可选口令）。认证值在下方「认证」区填写或选择已有凭证。">
              <Tabs
                variant="segmented"
                tabs={[
                  { value: 'password' as const, label: '账号密码', icon: <KeyRound size={13} strokeWidth={1.8} /> },
                  { value: 'key' as const, label: '私钥（可选口令）', icon: <FileKey size={13} strokeWidth={1.8} /> },
                ]}
                value={sshAuthMethod}
                onChange={(v) => { setSshAuthMethod(v); setSlotValues({}); setBindings({}); }}
              />
            </Field>
          </Section>
        ) : (
          marketKey && detail.data && (
            detail.data.executionMode === 'native' ? (
              <Section title="连接信息">
                <Field label="管理 API 地址" hint="平台内建工具：网关进程内直连，不起子进程。地址随部署而变，由你填写。">
                  <input className="input mono" placeholder="如 http://zabbix.example:8080" value={url} onChange={(e) => setUrl(e.target.value)} />
                </Field>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                  <input type="checkbox" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} />
                  允许私网访问（内网地址必选；变更写治理审计）
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                  <input type="checkbox" checked={allowInsecureTls} onChange={(e) => setAllowInsecureTls(e.target.checked)} />
                  允许不安全 TLS（自签证书；关闭证书校验会失去中间人防护）
                </label>
                <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>{detail.data.description}</div>
              </Section>
            ) : (
              <Section title="将生成的配置">
                <div style={{ display: 'grid', gap: 6, fontSize: 'var(--text-sm)' }}>
                  <div><span style={{ color: 'var(--meta)', marginRight: 8 }}>协议</span><span className="tag">{detail.data.preview.url ? 'http' : 'stdio'}</span></div>
                  {detail.data.preview.url && (
                    <div className="mono" style={{ fontSize: 13, color: 'var(--fg-2)' }}>{detail.data.preview.url}</div>
                  )}
                  {detail.data.preview.command && (
                    <div className="mono" style={{ fontSize: 13, color: 'var(--fg-2)', wordBreak: 'break-all' }}>
                      {detail.data.preview.command} {detail.data.preview.args.join(' ')}
                    </div>
                  )}
                  <div style={{ color: 'var(--muted)' }}>{detail.data.description}</div>
                </div>
              </Section>
            )
          )
        )
      ) : (
        <>
          <Section title="协议">
            <Tabs
              variant="segmented"
              tabs={PROTOCOLS.map(({ value, label, icon: Icon }) => ({ value, label, icon: <Icon size={14} strokeWidth={1.8} /> }))}
              value={protocol}
              onChange={(v) => { setProtocol(v); setErr(''); }}
            />
            <div style={{ color: 'var(--meta)', fontSize: 12 }}>{PROTOCOLS.find((p) => p.value === protocol)?.hint}</div>
          </Section>

          <Section title="连接配置">
            {protocol === 'stdio' ? (
              <>
                <Field label="启动命令" hint="如 uvx / npx -y pkg@x.y.z">
                  <input className="input" placeholder="uvx" value={command} onChange={(e) => setCommand(e.target.value)} />
                </Field>
                <StringListEditor label="参数（args）" hint="每个输入框为一个数组元素" value={argsRows} onChange={setArgsRows} />
                <KVListEditor label="环境变量（env）" hint="值写 ${VAR} 占位符 → 自动识别为凭证槽位" value={envRows} onChange={setEnvRows} valuePlaceholder="${VAR} 或值" />
              </>
            ) : (
              <>
                <Field label="服务地址" hint="http = Streamable HTTP；sse = 旧式 SSE">
                  <input className="input" placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
                </Field>
                <KVListEditor label="请求头（headers）" hint="值写 ${VAR} 占位符 → 自动识别为凭证槽位" value={headersRows} onChange={setHeadersRows} valuePlaceholder="Bearer ${API_KEY} 或值" />
              </>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
              <input type="checkbox" checked={allowInsecureTls} onChange={(e) => setAllowInsecureTls(e.target.checked)} />
              允许不安全 TLS（目标用自签证书时勾选；关闭校验会失去中间人防护）
            </label>
            <Field label="业务品类" hint="决定安全规则的资产类型匹配维度；与分组无关，分组可自由创建与关联资产">
              <Combobox
                ariaLabel="业务品类"
                value={category}
                onChange={setCategory}
                placeholder="选择品类…"
                options={[{ value: 'mysql', label: 'mysql' }, { value: 'k8s', label: 'k8s' }, { value: 'zabbix', label: 'zabbix' }, { value: 'rocketmq', label: 'rocketmq' }, { value: 'nacos', label: 'nacos' }, { value: 'other', label: 'other' }, { value: 'host', label: 'host' }]}
              />
            </Field>
          </Section>
        </>
      )}

      {showSlots && slotBindings}

      {plaintextHits.length > 0 && (
        <div style={{
          display: 'grid', gap: 4, padding: '10px 12px', borderRadius: 'var(--r-md)',
          background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--warn)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
            <ShieldAlert size={14} strokeWidth={2} /> 检测到明文密钥（建议改用槽位）
          </div>
          {plaintextHits.map((h) => (
            <div key={h} style={{ color: 'var(--fg-2)', fontSize: 'var(--text-xs)' }}>· {h}</div>
          ))}
          <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
            改用 <code className="mono">{'${SLOT}'}</code> 占位符后，值会加密存于槽位而非明文写入配置。不阻断创建。
          </div>
        </div>
      )}

      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '创建中…' : '创建'}
        </button>
      </div>
    </Modal>
  );
}
