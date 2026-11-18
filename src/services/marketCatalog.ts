/**
 * Market 目录服务（ADR-025 / §5.3）：内置静态 JSON（不落库、非运行时实体）。
 * 槽位自动识别：与 SLOT_PLACEHOLDER_RE 同源（唯一实现，无第二份正则——T11 约束）。
 * 实例化：展开配置快照 → 识别槽位 → 绑凭证（可带 missingSlots，运行时 fail-closed）→ 异步预热。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SLOT_PLACEHOLDER_SCAN_RE, SENSITIVE_KEY_RE } from '../config/constants.js';

/** 原生资产凭证槽位声明：无配置可扫描，必须由条目显式给出 */
export interface NativeSlotDecl {
  name: string;
  label: string;
  /** 值落临时文件（私钥/kubeconfig 类）；HTTP 型产品基本不用 */
  file?: boolean;
}

export interface CatalogEntry {
  key: string;
  name: string;
  displayName: string;
  description: string;
  repository: string;
  categories: string[];
  tags: string[];
  runtime: 'npm' | 'pypi';
  slotLabels?: Record<string, string>;
  /**
   * 默认分组名：从该条目创建的资产自动加入此分组（不存在则创建）。
   * 与 ADR-026 不冲突——分组仍不按品类自动归组，这里是条目显式声明的默认归属。
   */
  defaultGroup?: string;
  /**
   * 执行分层（ADR-022 扩展）：`mcp`（默认，代理社区实现，走实例池）|
   * `native`（网关内建 HTTP 工具，无子进程；管理 API 地址由用户建资产时填写）。
   * `native` 条目的槽位来自 `slotLabels`——工具按槽位名从 ctx.credentials 取值，不经配置注入。
   */
  executionMode?: 'mcp' | 'native';
  installations: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
}

export interface CatalogFile {
  version: number;
  note?: string;
  items: CatalogEntry[];
}

const CATALOG_PATH = fileURLToPath(new URL('../data/market-catalog.json', import.meta.url));

export function loadCatalog(filePath: string = CATALOG_PATH): CatalogEntry[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as CatalogFile;
  return raw.items;
}

export interface DetectedSlot {
  /** url：HTTP 资产的地址本身就是部署相关的（如宝塔 `https://<IP>:8765/bt-mcp-x/mcp`），同样要能填 */
  target: 'env' | 'args' | 'headers' | 'url';
  name: string;
  label: string;
  file: boolean;
  sensitive: boolean;
  placeholder: string;
  envKey?: string;
  headerKey?: string;
  index?: number;
}

const FILE_HINT_RE = /private_key|key_file|kubeconfig|cert|pem/i;

/** 取字符串里全部 `${NAME}`（支持 `Bearer ${TOKEN}`、`http://${HOST}/mcp` 这种嵌入写法） */
function placeholderNames(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(SLOT_PLACEHOLDER_SCAN_RE)) out.push(m[1]!);
  return out;
}

/** 字符串里是否含占位符（整值或嵌入均可） */
export function hasPlaceholder(value: string): boolean {
  SLOT_PLACEHOLDER_SCAN_RE.lastIndex = 0;
  return placeholderNames(value).length > 0;
}

/** 配置快照形状（展开后的实例化配置；自定义配置覆盖时同形） */
export interface ConfigSnapshot {
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
}

/** 槽位自动识别（§5.3 / T11）：从任意配置快照识别（entry 只用于取中文标签）。
 *  同一个 `${NAME}` 可能出现多次（如 headers 与 url 各一处），但槽位按名字唯一——注入时按名替换全部出现处。 */
export function detectSlotsInConfig(entry: CatalogEntry, config: ConfigSnapshot): DetectedSlot[] {
  const byName = new Map<string, DetectedSlot>();
  const labelOf = (name: string) => entry.slotLabels?.[name] ?? defaultLabel(name);
  const add = (slot: DetectedSlot) => {
    if (!byName.has(slot.name)) byName.set(slot.name, slot);
  };
  for (const [envKey, value] of Object.entries(config.env)) {
    for (const name of placeholderNames(value)) {
      add({
        target: 'env',
        name,
        envKey,
        label: labelOf(name),
        file: FILE_HINT_RE.test(envKey) || FILE_HINT_RE.test(name),
        sensitive: SENSITIVE_KEY_RE.test(envKey),
        placeholder: value,
      });
    }
  }
  for (const [headerKey, value] of Object.entries(config.headers)) {
    for (const name of placeholderNames(value)) {
      add({
        target: 'headers',
        name,
        headerKey,
        label: labelOf(name),
        file: false,
        sensitive: SENSITIVE_KEY_RE.test(headerKey),
        placeholder: value,
      });
    }
  }
  (config.args ?? []).forEach((arg, index) => {
    for (const name of placeholderNames(arg)) {
      add({
        target: 'args',
        name,
        index,
        label: labelOf(name),
        file: FILE_HINT_RE.test(name),
        sensitive: SENSITIVE_KEY_RE.test(name),
        placeholder: arg,
      });
    }
  });
  // url 里的占位符（如 `${MCP_URL}`）：地址随部署而变，必须能填
  for (const name of placeholderNames(config.url ?? '')) {
    add({
      target: 'url',
      name,
      label: labelOf(name),
      file: false,
      // 地址不是密钥；不参与"明文敏感值"告警
      sensitive: false,
      placeholder: config.url!,
    });
  }
  return [...byName.values()];
}

/** 槽位自动识别（目录条目默认配置）。
 *  原生条目没有可扫描的配置（工具直连产品 API），槽位由 `slotLabels` 声明。 */
export function detectSlots(entry: CatalogEntry): DetectedSlot[] {
  if (entry.executionMode === 'native') {
    return Object.entries(entry.slotLabels ?? {}).map(([name, label]) => ({
      target: 'env' as const,
      name,
      label,
      // 原生工具的槽位值直接进 ctx.credentials，不落文件也不进子进程
      file: false,
      sensitive: SENSITIVE_KEY_RE.test(name),
      placeholder: `\${${name}}`,
    }));
  }
  return detectSlotsInConfig(entry, expandConfig(entry));
}

function defaultLabel(name: string): string {
  if (/password|passwd/i.test(name)) return '密码';
  if (/private_key|key_file|kubeconfig/i.test(name)) return '私钥';
  if (/token|secret|api_key/i.test(name)) return 'Token';
  if (/host/i.test(name)) return '主机地址';
  if (/user|username/i.test(name)) return '用户名';
  return name;
}

/** 展开配置快照（§5.3 第 1 步）：命令固化版本已在目录 JSON 中保证（AC-62）；HTTP 条目带 url/headers */
export function expandConfig(entry: CatalogEntry): ConfigSnapshot {
  const install = entry.installations[entry.runtime];
  if (!install) return { command: '', args: [], env: {}, url: null, headers: {} };
  return {
    command: install.command ?? '',
    args: [...(install.args ?? [])],
    env: { ...(install.env ?? {}) },
    url: install.url ?? null,
    headers: { ...(install.headers ?? {}) },
  };
}

/** 把一个字符串里的 `${NAME}` 全部替换为给定值；未给出的槽位保持不变（调用方决定是否 fail-closed） */
export function substitutePlaceholders(value: string, values: Record<string, string>): string {
  return value.replace(SLOT_PLACEHOLDER_SCAN_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole,
  );
}

/** 实例化输入展开：把槽位凭证值注入快照的**每一处**出现（`Bearer ${TOKEN}` 这类嵌入值同样生效） */
export function injectSlots(
  config: { command: string; args: string[]; env: Record<string, string>; url: string | null; headers: Record<string, string> },
  slots: DetectedSlot[],
  credentialValues: Record<string, string>,
): { command: string; args: string[]; env: Record<string, string>; url: string | null; headers: Record<string, string> } {
  const known = new Set(slots.map((s) => s.name));
  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(credentialValues)) if (known.has(name)) values[name] = v;
  const env = Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, substitutePlaceholders(v, values)]));
  const args = config.args.map((a) => substitutePlaceholders(a, values));
  const headers = Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, substitutePlaceholders(v, values)]));
  const url = config.url === null ? null : substitutePlaceholders(config.url, values);
  return { command: config.command, args, env, url, headers };
}
