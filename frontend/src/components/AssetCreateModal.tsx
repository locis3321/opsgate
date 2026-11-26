import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Store, Terminal, Globe, Radio, Plus, Trash2, ShieldAlert, KeyRound, FileKey, Zap, SquareTerminal } from 'lucide-react';
import { api, ApiError } from '../api';
import Modal from './Modal';
import Tabs from './Tabs';
import Combobox from './Combobox';
import TagEditor from './TagEditor';
import SlotValueEditor, { type CredCandidate } from './SlotValueEditor';
import { detectSlots, detectPlaintextSecrets, slotLabel } from '../slots';
import { StringListEditor, KVListEditor } from './ConfigEditors';

/**
 * 新建资产弹窗（§8.5）：四条创建路径统一入口。
 * 1) 原生主机 —— category=host + executionMode=native（不走 Market，ADR-022）
 * 2) MCP 资产 —— 从 Market 目录选条目（自动展开配置 + 槽位识别 + 凭证绑定）
 * 3) MCP 资产 —— 自定义（协议 stdio/http/sse + 手填连接配置 + 槽位凭证绑定）
 * 4) CLI 资产 —— executionMode=cli（网关本机一次性子进程，ADR-037）：
 *    二进制 + 声明式 env 槽位 + 可选目标地址；形态复用 type=native（无 MCP 子进程包装）。
 *
 * 凭证绑定统一走槽位机制（`${NAME}` 占位符 → server_credentials）；
 * 也可在 env/args/headers 中直接写 `ref.<凭证名>.<键名>` 引用已有凭证（一个凭证可服务多个资产）。
 */

interface CatalogItem { key: string; displayName: string; description: string; categories: string[]; runtime: string; executionMode?: 'mcp' | 'native' | 'cli' }
interface CatalogDetail {
  key: string; displayName: string; description: string; runtime: string;
  executionMode?: 'mcp' | 'native' | 'cli';
  preview: { command: string; args: string[]; env: Record<string, string>; url: string | null; headers: Record<string, string> };
  /** CLI 条目的声明段（`executionMode='cli'` 时由后端随条目下发）：二进制与 env 模板 */
  cli?: { bin: string; env?: Record<string, string>; urlEnv?: string };
  slots: Array<{ target: string; name: string; label: string; file: boolean }>;
}
type Candidate = CredCandidate;

type Protocol = 'stdio' | 'http' | 'sse';
type Tab = 'market' | 'custom';
/**
 * 执行分层（ADR-022 / ADR-037）：mcp = 代理社区实现走实例池；native = 网关进程内直连；
 * cli = 网关本机一次性子进程（argv 直执行，不经 shell，凭证只经 env/文件注入）。
 */
type ExecMode = 'mcp' | 'native' | 'cli';

/** CLI 槽位行（声明式，不靠扫描 env 值推断）：env 名 + 是否落临时文件 */
interface CliSlotRow { name: string; label: string; file: boolean }

/**
 * CLI 目标地址的唯一落点占位符。
 *
 * `url` 只有一条生效途径：CliRunner 渲染 env 模板时把 `${OPSGATE_TARGET}` 换成 asset.url。
 * 所以「env 模板里是否出现这个占位」才是目标地址输入框该不该生效的判据——
 * 没有它，收下的地址不会进任何变量，等于给用户一个不生效的字段。
 * （与 Market 详情页 `cliTakesTarget` 同口径，两处必须一致。）
 */
const CLI_TARGET_PLACEHOLDER = 'OPSGATE_TARGET';

/**
 * CLI 槽位的文件类启发（与后端 `marketCatalog.ts` 的 `CLI_FILE_SLOT_RE` 同一份判据）。
 *
 * 只用于**未显式声明**的槽位（仅被 env 模板 `${NAME}` 引用的名字）：kubeconfig / 证书 / 私钥
 * 这类值是文件内容，CliRunner 落 0600 临时文件后 env 只给路径；若错标成非文件，
 * kubectl 拿到的是 kubeconfig 原文而不是路径——资产建成功、首次调用必失败。
 * Market 条目入口也用这份启发，两条入口必须同口径，否则同一槽位在两边落库结果不同。
 */
const CLI_FILE_SLOT_RE = /KEY|KUBECONFIG|CERT|PEM/i;

/**
 * 由 env 模板 + 槽位行推导提交用的槽位声明。
 *
 * 两个来源都要合并：
 * - 槽位行是**声明**：CliRunner 会按声明名直接注入 env（file:true 的落 0600 临时文件、
 *   其余直接进 env），所以哪怕 env 模板里没写占位符，声明本身也是有效的注入点；
 * - env 模板里的 `${NAME}` 是**模板渲染点**：模板引用了却没声明的名字，
 *   执行时会因"槽位未绑定"直接 fail-closed，因此必须补进声明列表。
 * 两者取并集：label/file 以槽位行为准；**只有**被 env 模板引用却没声明的名字才走
 * `CLI_FILE_SLOT_RE` 启发补 `file`（显式声明过的槽位绝不被启发覆盖）。
 * 目标地址占位（`${OPSGATE_TARGET}`）不是凭证槽位，跳过。
 */
function cliSlotsFromEnv(
  envRows: Array<{ key: string; value: string }>,
  slotRows: CliSlotRow[],
): Array<{ target: 'env'; name: string; label: string; file: boolean }> {
  const names: string[] = [];
  const push = (raw: string) => {
    const n = raw.trim();
    // 空名字行不声明（槽位名是 env 名，空串既无法注入也会让后端拒绝）
    if (!n || n === CLI_TARGET_PLACEHOLDER || names.includes(n)) return;
    names.push(n);
  };
  for (const s of slotRows) push(s.name);
  for (const r of envRows) {
    for (const m of r.value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) push(m[1]!);
  }
  return names.map((name) => {
    const declared = slotRows.find((s) => s.name.trim() === name);
    return {
      target: 'env' as const,
      name,
      label: declared?.label?.trim() || slotLabel(name),
      file: declared ? declared.file : CLI_FILE_SLOT_RE.test(name),
    };
  });
}

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

/** 主机名维度的私网/环回判定（只吃 hostname，不做 URL 解析；http 与 CLI 两种地址形态共用） */
function isPrivateHostname(host: string): boolean {
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

/**
 * 粗判地址是否为私网/环回（仅用于提示，**不是**安全校验）。
 * 真正的 SSRF 判定在服务端（解析 DNS 后按 ipaddr.js 分类）；这里只为了让用户在保存前
 * 就看到"要勾选允许私网访问"，避免提交后才收到 400。
 * 只适用于**带协议头的 URL**（native 的 http(s):// / redis:// 等）；CLI 的 host:port 走 `isPrivateCliHost`。
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
  return isPrivateHostname(host);
}

/**
 * CLI 目标地址的私网提示（`host:port` 形态）。
 *
 * 不能直接复用 `isPrivateHost`：`new URL('10.0.0.5:3306')` 会把 `10.0.0.5:` 当成 scheme、
 * hostname 变成空串（或整体抛错），于是内网地址的琥珀提示永远不出现——用户填完提交才被
 * 后端 400 打回。归一化口径与服务端 `cliTargetForSsrf` 完全一致（无 `scheme://` 就补 `tcp://`），
 * 否则前端提示与后端校验会对同一份输入给出不同结论。
 */
function isPrivateCliHost(target: string): boolean {
  const s = target.trim();
  if (!s) return false;
  const probe = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ? s : `tcp://${s}`;
  let host = '';
  try {
    host = new URL(probe).hostname;
  } catch {
    return false;
  }
  return isPrivateHostname(host);
}

/**
 * CLI 凭证槽位声明编辑器（env 名 + 是否落临时文件）。
 *
 * 与 MCP 的槽位不同：CLI 槽位不写在 env 值里靠扫描推断，而是**声明式**——
 * `CliRunner` 直接按声明名把凭证注入同名环境变量；`file:true` 则写成 0600 临时文件、
 * 环境变量只给路径（kubeconfig / 私钥这类必须是文件路径而不能是内容）。
 */
function CliSlotEditor({ value, onChange }: { value: CliSlotRow[]; onChange: (v: CliSlotRow[]) => void }) {
  const setRow = (i: number, patch: Partial<CliSlotRow>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>凭证槽位</label>
        <span style={{ color: 'var(--meta)', fontSize: 12 }}>名字即注入的环境变量名；勾「文件」表示写成临时文件、env 只给路径</span>
      </div>
      {value.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input mono"
            style={{ flex: '2 1 160px', fontSize: 'var(--text-sm)' }}
            placeholder="MYSQL_PWD"
            aria-label={`槽位名 ${i + 1}`}
            value={row.name}
            onChange={(e) => setRow(i, { name: e.target.value })}
          />
          <input
            className="input"
            style={{ flex: '3 1 160px', fontSize: 'var(--text-sm)' }}
            placeholder="展示用标签（可选，如 MySQL 密码）"
            aria-label={`槽位标签 ${i + 1}`}
            value={row.label}
            onChange={(e) => setRow(i, { label: e.target.value })}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={row.file} onChange={(e) => setRow(i, { file: e.target.checked })} />
            文件
          </label>
          <button
            type="button"
            className="btn"
            style={{ padding: '4px 8px', flexShrink: 0 }}
            title="删除该槽位声明"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <Trash2 size={14} strokeWidth={1.8} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn"
        style={{ alignSelf: 'flex-start', fontSize: 'var(--text-xs)', gap: 4 }}
        onClick={() => onChange([...value, { name: '', label: '', file: false }])}
      >
        <Plus size={12} strokeWidth={2} /> 添加槽位
      </button>
    </div>
  );
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
  /**
   * CLI 分支状态（executionMode='cli'）：
   * - `cliCommand` 是二进制名/绝对路径（落 servers.command，后端创建时校验存在且可执行）
   * - `cliEnvRows` 是 env **模板**，值里写 `${NAME}` 表示该变量由槽位 NAME 渲染
   * - `cliSlotRows` 是槽位声明，仅用于标 `file:true`（kubeconfig/私钥这类要落临时文件）
   * - `cliUrl` 落 servers.url，是否生效取决于 env 模板有没有 `${OPSGATE_TARGET}`
   */
  const [cliCommand, setCliCommand] = useState('');
  const [cliEnvRows, setCliEnvRows] = useState<Array<{ key: string; value: string }>>([]);
  const [cliSlotRows, setCliSlotRows] = useState<CliSlotRow[]>([]);
  const [cliUrl, setCliUrl] = useState('');
  /**
   * 市场 tab 里 CLI 条目的目标地址（与自定义 CLI 的 `cliUrl` 分开存）。
   * 两个 tab 的地址语义不同（条目声明 vs 用户自建模板），共用一个 state 会让切 tab 时
   * 把另一边的值悄悄带过来——提交时就写进了不该有的 url。
   */
  const [marketCliUrl, setMarketCliUrl] = useState('');
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
   * 目录条目是平台 CLI（executionMode='cli'，ADR-037）：二进制由条目声明、argv 直执行，
   * 与社区 MCP 实现（起子进程/连远端）不是一回事——协议标签、说明与目标地址三类呈现都不同。
   * Market 详情页（`isCli`）已区分，两处必须同口径，否则同一 entry 在两个入口显示不同事实。
   */
  const isCliEntry = detail.data?.executionMode === 'cli';
  /**
   * 该 CLI 条目的 env 模板是否承接资产 url（`${OPSGATE_TARGET}` → CliRunner 渲染为 asset.url）。
   * 没承接的条目（kubectl 走 KUBECONFIG、kafka-topics 走 argv）不渲染目标地址输入框：
   * 收了也没有落点，等于给用户一个不生效的字段（与 MarketDetail 的 `cliTakesTarget` 同判据）。
   */
  const cliEntryTakesTarget = useMemo(() => {
    if (!isCliEntry) return false;
    const env = detail.data?.cli?.env ?? detail.data?.preview.env ?? {};
    return Object.values(env).some((v) => v.includes(`\${${CLI_TARGET_PLACEHOLDER}}`));
  }, [isCliEntry, detail.data]);
  /** CLI 条目承接目标地址的那个变量名（说明文案用，取不到时回落占位符名） */
  const cliEntryTargetEnv = useMemo(() => {
    if (!cliEntryTakesTarget) return CLI_TARGET_PLACEHOLDER;
    const env = detail.data?.cli?.env ?? detail.data?.preview.env ?? {};
    return Object.entries(env).find(([, v]) => v.includes(`\${${CLI_TARGET_PLACEHOLDER}}`))?.[0] ?? CLI_TARGET_PLACEHOLDER;
  }, [cliEntryTakesTarget, detail.data]);
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

  /** CLI 模式（自定义 tab）：槽位 = 槽位声明 ∪ env 模板占位符（与提交口径同一份推导） */
  const isCustomCli = tab === 'custom' && execMode === 'cli';
  const customCliSlots = useMemo(() => cliSlotsFromEnv(cliEnvRows, cliSlotRows), [cliEnvRows, cliSlotRows]);
  /**
   * file 由启发式判定出来的槽位名（只被 env 模板引用、没有对应槽位声明）。
   * 勾选状态是用户的动作，自动判定不是——不标出来用户会以为"我没勾文件，为什么显示文件"。
   */
  const customCliAutoFileSlots = useMemo(() => {
    const declared = new Set(cliSlotRows.map((s) => s.name.trim()).filter((n) => n !== ''));
    return new Set(customCliSlots.filter((s) => s.file && !declared.has(s.name)).map((s) => s.name));
  }, [customCliSlots, cliSlotRows]);
  /** env 模板是否承接 `${OPSGATE_TARGET}`：只有承接时目标地址才是有效字段 */
  const cliTakesTarget = useMemo(
    () => cliEnvRows.some((r) => r.value.includes(`\${${CLI_TARGET_PLACEHOLDER}}`)),
    [cliEnvRows],
  );

  const slots = tab === 'market'
    ? (isNativeTool ? nativeSlots : marketSlots)
    : (isCustomCli ? customCliSlots : isCustomNative ? customNativeSlots : customSlots);

  /** 明文密钥提示（T5-3）：配置里直接写死的敏感值会被明文落库，建议改用 ${SLOT} 占位符 */
  const plaintextHits = useMemo(() => {
    // 原生条目没有可扫描的配置（工具直连产品 API），不存在明文落库风险
    if (isNativeTool || isNativeEntry || isCustomNative) return [];
    // CLI 只有 env 模板可扫（argv 由调用方在调用时给，不在资产里）
    if (isCustomCli) {
      return detectPlaintextSecrets({
        env: Object.fromEntries(cliEnvRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value])),
        args: [],
        headers: {},
      });
    }
    const env = tab === 'custom'
      ? Object.fromEntries(envRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]))
      : (detail.data?.preview.env ?? {});
    const headers = tab === 'custom'
      ? Object.fromEntries(headersRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]))
      : (detail.data?.preview.headers ?? {});
    const args = tab === 'custom' ? argsRows.filter((r) => r.trim()) : (detail.data?.preview.args ?? []);
    return detectPlaintextSecrets({ env, args, headers });
  }, [tab, envRows, headersRows, argsRows, detail.data, isNativeTool, isNativeEntry, isCustomNative, isCustomCli, cliEnvRows]);
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
    || cliCommand.trim() || cliUrl.trim() || cliEnvRows.some((r) => r.key.trim())
    || cliSlotRows.length > 0 || marketCliUrl.trim()
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
        const isCliEntry = detail.data?.executionMode === 'cli';
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
        // CLI 条目：安装配置由条目声明（后端收到非空 config 会 400），只有目标地址可提交。
        // 承接 `${OPSGATE_TARGET}` 的条目必须填地址——缺了它 env 里那个变量不会被渲染，
        // 资产能建成但首次调用必然连不上（错误暴露得太晚）。
        if (isCliEntry && cliEntryTakesTarget && !marketCliUrl.trim()) {
          throw new Error(`该条目把 \${${CLI_TARGET_PLACEHOLDER}} 渲染进环境变量 ${cliEntryTargetEnv}，请填写目标地址（如 db.example.invalid:3306）`);
        }
        const res = await instantiate.mutateAsync({
          pkgName: marketKey,
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          credentialRefs: pickBindings(marketSlots.map((s) => s.name)),
          inlineValues: pickInlineValues(marketSlots.map((s) => s.name)),
          ...(isNativeEntry ? { ...(url.trim() ? { url: url.trim() } : {}), ...(allowPrivate ? { allowPrivateNetwork: true } : {}), ...(allowInsecureTls ? { allowInsecureTls: true } : {}) } : {}),
          // CLI 条目与原生条目共用 url 字段（D12 SSRF 闸门同一道）；地址与私网开关同批提交
          ...(isCliEntry ? { ...(marketCliUrl.trim() ? { url: marketCliUrl.trim() } : {}), ...(allowPrivate ? { allowPrivateNetwork: true } : {}) } : {}),
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

      // 自定义 · CLI 模式（ADR-037）：网关本机一次性子进程，argv 直执行
      // 形态复用 type='native'（后端硬约束：cli 的 type 若为 stdio/http/sse 会按 MCP 解析子进程/URL，
      // 与 executionMode=cli 矛盾，直接 400）。
      if (tab === 'custom' && execMode === 'cli') {
        const bin = cliCommand.trim();
        if (!bin) throw new Error('CLI 资产必须填写二进制（command），如 kubectl / mysql / redis-cli');
        // 二进制存在性与可执行位由后端校验（which/绝对路径 + 普通文件判定）：缺失即 400，
        // 前端不做本地探测——浏览器看不到网关主机的文件系统，猜出来的"可用"是假事实。
        const cliSlots = cliSlotsFromEnv(cliEnvRows, cliSlotRows);
        // 槽位名同时是 env 名与凭证文件名：CliRunner 执行前按标识符白名单校验，
        // 这里前置同一判据——否则资产建成功、第一次调用才因槽位名非法失败（错误暴露得太晚）。
        const badSlot = cliSlots.find((s) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name));
        if (badSlot) {
          throw new Error(`槽位名 "${badSlot.name}" 非法：只允许字母或下划线开头，后接字母/数字/下划线（它同时是环境变量名）`);
        }
        const env = Object.fromEntries(cliEnvRows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]));
        // 地址只在 env 模板承接 `${OPSGATE_TARGET}` 时才提交：没有落点的地址不写库，
        // 否则详情页会显示一个"填了但不生效"的目标。
        const takeUrl = cliEnvRows.some((r) => r.value.includes(`\${${CLI_TARGET_PLACEHOLDER}}`));
        if (takeUrl && !cliUrl.trim()) {
          throw new Error(`env 模板承接了 \${${CLI_TARGET_PLACEHOLDER}}，请填写目标地址（如 db.example.invalid:3306）`);
        }
        // 反向：填了地址但模板没有承接点 —— 静默丢弃等于"看起来成功"（§2 原则 5），显式拒绝
        if (!takeUrl && cliUrl.trim()) {
          throw new Error(`目标地址需要一个落点：请在 env 模板里加一行承接 \${${CLI_TARGET_PLACEHOLDER}}（如 MYSQL_HOST = \${${CLI_TARGET_PLACEHOLDER}}），或清空地址后提交`);
        }

        const res = await create.mutateAsync({
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          type: 'native',
          executionMode: 'cli',
          category,
          command: bin,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(takeUrl ? { url: cliUrl.trim() } : {}),
          ...(allowPrivate ? { allowPrivateNetwork: true } : {}),
          credentialSlots: cliSlots,
          credentialBindings: pickBindings(cliSlots.map((s) => s.name)),
          inlineValues: pickInlineValues(cliSlots.map((s) => s.name)),
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
          {isCustomCli
            ? <>当前没有声明凭证槽位。若 CLI 需要认证，在上方「凭证槽位」加一行（名字即注入的环境变量名），或在 env 模板值里写 <code className="mono">{'${VAR}'}</code> 自动识别。</>
            : <>未识别到凭证槽位。若服务需要认证，在配置里写 <code className="mono">{'${VAR}'}</code> 占位符即可自动识别为槽位。</>}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {slots.map((s) => (
            <SlotValueEditor
              key={s.name}
              slotName={s.name}
              label={s.label}
              isFile={s.file}
              note={isCustomCli && customCliAutoFileSlots.has(s.name) ? '自动判定为文件：该槽位只被 env 模板引用，值会写成 0600 临时文件、env 只给路径' : undefined}
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
        <Field label="工具" hint="内建工具由网关直接实现；平台 CLI 由网关本机二进制直执行；Market 条目由社区 MCP 实现，选中后自动展开配置并识别凭证槽位">
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
              // 「平台 CLI」= 网关本机二进制直执行（ADR-037）：与社区实现同样不是 MCP，单列一组
              ...(catalog.data?.items ?? [])
                .filter((it) => it.executionMode === 'cli')
                .map((it) => ({ value: it.key, label: it.displayName, hint: 'CLI', group: '平台 CLI', icon: <SquareTerminal size={13} strokeWidth={1.8} /> })),
              // 「Market 目录」= 社区 MCP 实现（子进程/远端服务）
              ...(catalog.data?.items ?? [])
                .filter((it) => it.executionMode !== 'native' && it.executionMode !== 'cli')
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
            ) : detail.data.executionMode === 'cli' ? (
              /* 平台 CLI（ADR-037）：不是 MCP 子进程，协议标签必须写 cli 而不是 stdio——
                 stdio 会让用户以为有一个 MCP server 在起子进程。目标地址只在条目承接
                 `${OPSGATE_TARGET}` 时才渲染（否则收了也无处落）。 */
              <Section title="将生成的配置">
                <div style={{ display: 'grid', gap: 6, fontSize: 'var(--text-sm)' }}>
                  <div><span style={{ color: 'var(--meta)', marginRight: 8 }}>协议</span><span className="tag">cli</span></div>
                  <div style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
                    平台 CLI（argv 直执行）：网关本机以 <code className="mono">spawn</code> 直执行二进制，不经 shell，
                    无实例池、无预热。调用时按元素传 argv。
                  </div>
                  {detail.data.cli?.bin && (
                    <div className="mono" style={{ fontSize: 13, color: 'var(--fg-2)', wordBreak: 'break-all' }}>
                      二进制：{detail.data.cli.bin}
                    </div>
                  )}
                  {Object.keys(detail.data.cli?.env ?? {}).length > 0 && (
                    <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                      注入环境变量：{Object.keys(detail.data.cli?.env ?? {}).join('、')}
                    </div>
                  )}
                  {cliEntryTakesTarget ? (
                    <Field
                      label="目标地址"
                      hint={`该地址会渲染进环境变量 ${cliEntryTargetEnv}，由 CLI 在调用时读取。`}
                    >
                      <input
                        className="input mono"
                        placeholder="db.example.invalid:3306"
                        value={marketCliUrl}
                        onChange={(e) => setMarketCliUrl(e.target.value)}
                      />
                    </Field>
                  ) : (
                    <div style={{ color: 'var(--meta)', fontSize: 12, lineHeight: 1.6 }}>
                      该条目没有承接目标地址的环境变量：目标由 {detail.data.cli?.bin ?? 'CLI'} 自己的配置决定
                      （如 KUBECONFIG）或在调用时由 argv 显式给出，此处无需填写地址。
                    </div>
                  )}
                  {cliEntryTakesTarget && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                      <input type="checkbox" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} />
                      允许私网访问（内网地址必选；变更写治理审计）
                    </label>
                  )}
                  {cliEntryTakesTarget && isPrivateCliHost(marketCliUrl) && !allowPrivate && (
                    <div style={{
                      padding: '8px 10px', borderRadius: 'var(--r-md)', fontSize: 12, lineHeight: 1.6,
                      background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)', color: 'var(--warn)',
                    }}>
                      检测到内网地址：请勾选上方「允许私网访问」，否则保存会被 SSRF 校验拒绝。
                    </div>
                  )}
                  <div style={{ color: 'var(--muted)' }}>{detail.data.description}</div>
                </div>
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
                { value: 'cli' as ExecMode, label: 'CLI', icon: <SquareTerminal size={14} strokeWidth={1.8} /> },
              ]}
              value={execMode}
              onChange={(v) => { setExecMode(v); setErr(''); setBindings({}); setSlotValues({}); }}
            />
            <div style={{ color: 'var(--meta)', fontSize: 12 }}>
              {execMode === 'mcp'
                ? '代理社区 MCP 实现：起子进程/连远端服务，走实例池。适合 mysql / k8s / 其他社区实现。'
                : execMode === 'native'
                  ? `网关进程内直连（不起子进程）：提供该品类的原生运维工具。仅支持 ${NATIVE_CAPABLE.join(' / ')}。`
                  : 'CLI 子进程：在网关本机以 argv 直执行二进制（不经 shell，Linux 上经 bwrap 隔离），凭证只经环境变量/临时文件注入。二进制需主机预装。'}
            </div>
          </Section>

          <Section title="业务品类">
            <Field label="品类" hint="决定安全规则匹配维度与工具名前缀；与分组无关，分组可自由创建与关联资产">
              <Combobox
                ariaLabel="业务品类"
                value={category}
                onChange={(v) => {
                  setCategory(v);
                  // 选到原生品类时自动切到 native（用户仍可手动改回），减少「以为有原生工具却拿到 mcp」的误配。
                  // CLI 模式不参与这条自动切换：k8s/redis/mysql 恰好都是 CLI 常见品类，
                  // 一切就跳走会让用户无法用 CLI 建这些品类的资产。
                  if (execMode !== 'cli' && (NATIVE_CAPABLE as readonly string[]).includes(v) && v !== 'host') setExecMode('native');
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

          {isCustomCli ? (
            <>
              <Section title="连接配置">
                <Field
                  label="二进制（command）"
                  hint="二进制名（按网关 PATH 查找）或绝对路径。创建时会校验存在且可执行——一期要求主机预装，缺失即拒绝保存。"
                >
                  <input
                    className="input mono"
                    placeholder="kubectl"
                    value={cliCommand}
                    onChange={(e) => setCliCommand(e.target.value)}
                  />
                </Field>
                <KVListEditor
                  label="环境变量模板（env）"
                  hint="值里写 ${NAME} 表示由槽位 NAME 注入；写 ${OPSGATE_TARGET} 表示注入下方目标地址"
                  value={cliEnvRows}
                  onChange={setCliEnvRows}
                  valuePlaceholder="${MYSQL_PWD} 或字面值"
                />
                <CliSlotEditor value={cliSlotRows} onChange={setCliSlotRows} />
              </Section>

              <Section title="目标地址（可选）">
                <Field
                  label="目标地址"
                  hint={
                    cliTakesTarget
                      ? '地址会被渲染进 env 模板里的 ${OPSGATE_TARGET}（如 MYSQL_HOST）。MySQL 作为主机；其它由 argv / kubeconfig 指定。'
                      : '地址只有一条生效途径：env 模板里写 ${OPSGATE_TARGET}。当前模板没有这个占位符——请先在上方 env 加一行承接它（如 MYSQL_HOST = ${OPSGATE_TARGET}），否则这里填了也保存不了。'
                  }
                >
                  <input
                    className="input mono"
                    placeholder="db.example.invalid:3306"
                    value={cliUrl}
                    onChange={(e) => setCliUrl(e.target.value)}
                  />
                </Field>
                {cliUrl.trim() !== '' && !cliTakesTarget && (
                  <div style={{
                    padding: '8px 10px', borderRadius: 'var(--r-md)', fontSize: 12, lineHeight: 1.6,
                    background: 'var(--warn-soft)', border: '1px solid var(--security-warn-border)', color: 'var(--warn)',
                  }}>
                    当前 env 模板没有承接 {'${OPSGATE_TARGET}'} 的变量，这个地址不会生效，提交会被拒绝。
                  </div>
                )}
                {isPrivateCliHost(cliUrl) && (
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
              </Section>
            </>
          ) : isCustomNative && nativePreset ? (
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
