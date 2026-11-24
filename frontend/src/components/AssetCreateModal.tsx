import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Store, Terminal, Globe, Radio, Plus, ShieldAlert, KeyRound, FileKey, Zap } from 'lucide-react';
import { api, ApiError } from '../api';
import Modal from './Modal';
import Tabs from './Tabs';
import Combobox from './Combobox';
import TagEditor from './TagEditor';
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
/** 执行分层（ADR-022）：mcp = 代理社区实现走实例池；native = 网关进程内直连 */
type ExecMode = 'mcp' | 'native';

/**
 * 原生资产支持哪些品类（与后端 `HTTP_NATIVE_CATEGORIES` 保持一致）。
 *
 * 为什么前端要维护这份清单：品类下拉若不区分，用户会以为「redis + mcp 模式」也能拿到原生工具，
 * 但原生工具只在 `executionMode='native'` 时生效。这里同时驱动两件事——
 * 下拉可选项、以及选了该品类后是否自动切到 native 模式。
 */
const NATIVE_CAPABLE = ['host', 'zabbix', 'rocketmq', 'nacos', 'redis', 'kafka'] as const;

/** 各品类的原生连接信息：地址占位符 + 该品类需要的凭证槽位（槽位名与后端工具约定一致） */
const NATIVE_PRESETS: Record<string, {
  addrLabel: string;
  addrPlaceholder: string;
  addrHint: string;
  slots: Array<{ name: string; label: string; file: boolean }>;
}> = {
  redis: {
    addrLabel: 'Redis 地址',
    addrPlaceholder: 'redis://redis.example.invalid:6379/0',
    addrHint: '协议 rediss:// 表示 TLS；末尾 /0 是 db 编号。也可在槽位里分别给 host/port',
    slots: [{ name: 'REDIS_PASSWORD', label: 'Redis 密码（无认证可留空）', file: false }],
  },
  kafka: {
    addrLabel: 'Kafka Broker 地址',
    addrPlaceholder: 'kafka://kafka.example.invalid:9092',
    addrHint: '多个 broker 用逗号分隔，如 kafka://a:9092,b:9092。也可在槽位 KAFKA_BROKERS 填写',
    slots: [
      { name: 'KAFKA_SASL_USERNAME', label: 'SASL 用户名（无认证可留空）', file: false },
      { name: 'KAFKA_SASL_PASSWORD', label: 'SASL 密码（无认证可留空）', file: false },
    ],
  },
  zabbix: {
    addrLabel: 'Zabbix 服务地址',
    addrPlaceholder: 'http://zabbix.example.invalid:8080',
    addrHint: 'Zabbix 前端地址（工具会自行调用 /api_jsonrpc.php）',
    slots: [{ name: 'ZABBIX_TOKEN', label: 'Zabbix API Token', file: false }],
  },
  rocketmq: {
    addrLabel: 'RocketMQ Dashboard 地址',
    addrPlaceholder: 'http://rocketmq.example.invalid:8080',
    addrHint: '必须是 Dashboard 的 HTTP 地址，不是 broker 的 9876 端口',
    slots: [{ name: 'ROCKETMQ_TOKEN', label: 'Dashboard 访问令牌（无鉴权可留空）', file: false }],
  },
  nacos: {
    addrLabel: 'Nacos 服务地址',
    addrPlaceholder: 'http://nacos.example.invalid:8848',
    addrHint: '填 Nacos 根地址（工具内部自动拼 /nacos/v1）',
    slots: [
      { name: 'NACOS_USERNAME', label: 'Nacos 用户名（无鉴权可留空）', file: false },
      { name: 'NACOS_PASSWORD', label: 'Nacos 密码（无鉴权可留空）', file: false },
      { name: 'NACOS_TOKEN', label: 'Nacos accessToken（可选，优先于用户名密码）', file: false },
    ],
  },
};

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

/**
 * 粗判地址是否为私网/环回（仅用于提示，**不是**安全校验）。
 * 真正的 SSRF 判定在服务端（解析 DNS 后按 ipaddr.js 分类）；这里只为了让用户在保存前
 * 就看到"要勾选允许私网访问"，避免提交后才收到 400。
 */
function isPrivateHost(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  let host = '';
  try {
    host = new URL(s).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === 'localhost') return true;
  // IPv4 私网段：10/8、172.16/12、192.168/16、127/8、169.254/16
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return false;
}

export default function AssetCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('market');
  const [marketTool, setMarketTool] = useState('');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
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
  /** 执行模式：选到 redis/kafka 等原生品类时自动切 native（用户仍可改回 mcp） */
  const [execMode, setExecMode] = useState<ExecMode>('mcp');
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
  /**
   * redis / kafka 的地址可以完全来自槽位（REDIS_HOST+REDIS_PORT / KAFKA_BROKERS），
   * 因此这两类原生条目 url 可留空——与后端 market.ts 的 ADDRESS_OPTIONAL 判定一致。
   */
  const entryAddressOptional = useMemo(() => {
    if (!isNativeEntry) return false;
    const cats = (catalog.data?.items ?? []).find((it) => it.key === marketKey)?.categories ?? [];
    return cats.some((c) => c === 'redis' || c === 'kafka');
  }, [isNativeEntry, marketKey, catalog.data]);

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

  /** 原生模式（自定义 tab）：槽位由品类预设给出，不看 env/args 占位符 */
  const nativePreset = NATIVE_PRESETS[category];
  const isCustomNative = tab === 'custom' && execMode === 'native';
  const customNativeSlots = useMemo(
    () => (nativePreset?.slots ?? []).map((s) => ({ target: 'env' as const, name: s.name, label: s.label, file: s.file })),
    [nativePreset],
  );

  const slots = tab === 'market'
    ? (isNativeTool ? nativeSlots : marketSlots)
    : (isCustomNative ? customNativeSlots : customSlots);

  /** 明文密钥提示（T5-3）：配置里直接写死的敏感值会被明文落库，建议改用 ${SLOT} 占位符 */
  const plaintextHits = useMemo(() => {
    // 原生条目没有可扫描的配置（工具直连产品 API），不存在明文落库风险
    if (isNativeTool || isNativeEntry || isCustomNative) return [];
    const env = tab === 'custom'
      ? Object.fromEntries(envRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]))
      : (detail.data?.preview.env ?? {});
    const headers = tab === 'custom'
      ? Object.fromEntries(headersRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]))
      : (detail.data?.preview.headers ?? {});
    const args = tab === 'custom' ? argsRows.filter((r) => r.trim()) : (detail.data?.preview.args ?? []);
    return detectPlaintextSecrets({ env, args, headers });
  }, [tab, envRows, headersRows, argsRows, detail.data, isNativeTool, isNativeEntry, isCustomNative]);
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
    || Object.keys(bindings).length > 0 || Object.values(slotValues).some((v) => v.trim())
    || tags.length > 0,
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
          ...(tags.length > 0 ? { tags } : {}),
        });
        onCreated(res.id);
        return;
      }

      // 市场 · Market 目录条目：目录展开 + 槽位绑定 + 直填值由后端一次原子完成
      if (tab === 'market') {
        if (!marketKey) throw new Error('请选择工具');
        const isNativeEntry = detail.data?.executionMode === 'native';
        if (isNativeEntry && !url.trim() && !entryAddressOptional) {
          throw new Error('该条目为平台内建工具，请填写管理 API 地址');
        }
        if (isNativeEntry && !url.trim() && entryAddressOptional) {
          // 地址走槽位：必须有地址类槽位被绑定或直填，否则建出来也连不上
          const addrSlotFilled = marketSlots.some(
            (s) => /HOST|PORT|BROKERS|ADDR|ADDRESS|URL/i.test(s.name) && (bindings[s.name] || (slotValues[s.name] ?? '').trim() !== ''),
          );
          if (!addrSlotFilled) {
            throw new Error('请填写管理 API 地址，或在下方「凭证绑定」中提供地址类槽位（如 REDIS_HOST / KAFKA_BROKERS）');
          }
        }
        const res = await instantiate.mutateAsync({
          pkgName: marketKey,
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          credentialRefs: pickBindings(marketSlots.map((s) => s.name)),
          inlineValues: pickInlineValues(marketSlots.map((s) => s.name)),
          ...(isNativeEntry ? { ...(url.trim() ? { url: url.trim() } : {}), ...(allowPrivate ? { allowPrivateNetwork: true } : {}), ...(allowInsecureTls ? { allowInsecureTls: true } : {}) } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        });
        onCreated(res.server.id);
        return;
      }

      // 自定义 · 原生模式（ADR-022 分层：网关进程内直连，不起子进程）
      // 适用 redis / kafka / zabbix / rocketmq / nacos —— 它们的运维能力由原生工具提供
      if (tab === 'custom' && execMode === 'native') {
        if (!nativePreset) throw new Error(`品类 "${category}" 不支持原生模式（可选：${NATIVE_CAPABLE.join(' / ')}）`);
        if (!url.trim()) throw new Error(`${nativePreset.addrLabel}必填`);

        const res = await create.mutateAsync({
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          type: 'native',
          executionMode: 'native',
          category,
          url: url.trim(),
          ...(allowPrivate ? { allowPrivateNetwork: true } : {}),
          ...(allowInsecureTls ? { allowInsecureTls: true } : {}),
          credentialSlots: customNativeSlots,
          credentialBindings: pickBindings(customNativeSlots.map((s) => s.name)),
          inlineValues: pickInlineValues(customNativeSlots.map((s) => s.name)),
          ...(tags.length > 0 ? { tags } : {}),
        });
        onCreated(res.id);
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
        ...(tags.length > 0 ? { tags } : {}),
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
        <Field label="标签（可选）" hint="用于 MCP 端点 ?tag= 收窄与资产筛选，按精确值匹配；优先从已有标签中选">
          <TagEditor value={tags} onChange={setTags} />
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
                <Field
                  label={entryAddressOptional ? '管理 API 地址（可选）' : '管理 API 地址'}
                  hint={
                    entryAddressOptional
                      ? '平台内建工具：网关进程内直连。此地址可留空——改为在下方「凭证绑定」填 REDIS_HOST + REDIS_PORT（或 KAFKA_BROKERS）。两者都填时以槽位为准。'
                      : '平台内建工具：网关进程内直连，不起子进程。地址随部署而变，由你填写。'
                  }
                >
                  <input className="input mono" placeholder={entryAddressOptional ? '可留空；或在下方槽位填 REDIS_HOST / KAFKA_BROKERS' : '如 http://zabbix.example:8080'} value={url} onChange={(e) => setUrl(e.target.value)} />
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
          <Section title="执行模式">
            <Tabs
              variant="segmented"
              tabs={[
                { value: 'mcp' as ExecMode, label: 'MCP 代理', icon: <Terminal size={14} strokeWidth={1.8} /> },
                { value: 'native' as ExecMode, label: '原生直连', icon: <Zap size={14} strokeWidth={1.8} /> },
              ]}
              value={execMode}
              onChange={(v) => { setExecMode(v); setErr(''); setBindings({}); setSlotValues({}); }}
            />
            <div style={{ color: 'var(--meta)', fontSize: 12 }}>
              {execMode === 'mcp'
                ? '代理社区 MCP 实现：起子进程/连远端服务，走实例池。适合 mysql / k8s / 其他社区实现。'
                : `网关进程内直连（不起子进程）：提供该品类的原生运维工具。仅支持 ${NATIVE_CAPABLE.join(' / ')}。`}
            </div>
          </Section>

          <Section title="业务品类">
            <Field label="品类" hint="决定安全规则匹配维度与工具名前缀；与分组无关，分组可自由创建与关联资产">
              <Combobox
                ariaLabel="业务品类"
                value={category}
                onChange={(v) => {
                  setCategory(v);
                  // 选到原生品类时自动切到 native（用户仍可手动改回），减少「以为有原生工具却拿到 mcp」的误配
                  if ((NATIVE_CAPABLE as readonly string[]).includes(v) && v !== 'host') setExecMode('native');
                  setErr('');
                }}
                placeholder="选择品类…"
                options={[
                  { value: 'mysql', label: 'mysql' },
                  { value: 'k8s', label: 'k8s' },
                  { value: 'zabbix', label: 'zabbix' },
                  { value: 'rocketmq', label: 'rocketmq' },
                  { value: 'nacos', label: 'nacos' },
                  { value: 'redis', label: 'redis' },
                  { value: 'kafka', label: 'kafka' },
                  { value: 'other', label: 'other' },
                  { value: 'host', label: 'host' },
                ]}
              />
            </Field>
          </Section>

          {isCustomNative && nativePreset ? (
            <Section title="连接信息">
              <Field label={nativePreset.addrLabel} hint={nativePreset.addrHint}>
                <input className="input mono" placeholder={nativePreset.addrPlaceholder} value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              {isPrivateHost(url) && (
                <div style={{
                  padding: '8px 10px', borderRadius: 'var(--r-md)', fontSize: 12, lineHeight: 1.6,
                  background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)', color: 'var(--warn)',
                }}>
                  检测到内网地址：请勾选下方「允许私网访问」，否则保存会被 SSRF 校验拒绝。
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                <input type="checkbox" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} />
                允许私网访问（内网地址必选；变更写治理审计）
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                <input type="checkbox" checked={allowInsecureTls} onChange={(e) => setAllowInsecureTls(e.target.checked)} />
                允许不安全 TLS（自签证书；关闭证书校验会失去中间人防护）
              </label>
            </Section>
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
              </Section>
            </>
          )}
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
