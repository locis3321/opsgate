/**
 * 槽位识别（前端侧）：与后端 src/services/marketCatalog.ts 的 detectSlots 同源启发式
 * —— env/args/headers/url 的 `${NAME}` 占位符（整值或嵌入，如 `Bearer ${TOKEN}`）+ 敏感键/file 推断。
 * 单一实现：创建资产弹窗与 Market 添加面板共用，避免两处正则漂移。
 */

export const SLOT_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** 值内嵌占位符（`Bearer ${TOKEN}` / `http://${HOST}/mcp`） */
export const SLOT_PLACEHOLDER_SCAN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const FILE_HINT_RE = /private_key|key_file|kubeconfig|cert|pem/i;

export interface DetectedSlot {
  target: 'env' | 'args' | 'headers' | 'url';
  name: string;
  label: string;
  file: boolean;
}

export interface SlotScanInput {
  env: Record<string, string>;
  args: string[];
  headers: Record<string, string>;
  url?: string | null;
}

/** 槽位名的中文标签回落（与后端 defaultLabel 同源） */
export function slotLabel(name: string): string {
  if (/password|passwd/i.test(name)) return '密码';
  if (/private_key|key_file|kubeconfig/i.test(name)) return '私钥';
  if (/token|secret|api_key/i.test(name)) return 'Token';
  if (/host/i.test(name)) return '主机地址';
  if (/user|username/i.test(name)) return '用户名';
  return name;
}

/** 字符串里是否含占位符（整值或嵌入） */
export function hasPlaceholder(value: string): boolean {
  return [...value.matchAll(SLOT_PLACEHOLDER_SCAN_RE)].length > 0;
}

/** 从配置快照（env/args/headers/url）识别凭证槽位；同名只保留首次出现（注入按名替换全部出现处）。 */
export function detectSlots(input: SlotScanInput): DetectedSlot[] {
  const out = new Map<string, DetectedSlot>();
  const add = (slot: DetectedSlot) => { if (!out.has(slot.name)) out.set(slot.name, slot); };
  for (const [k, v] of Object.entries(input.env)) {
    for (const name of v.matchAll(SLOT_PLACEHOLDER_SCAN_RE)) {
      add({ target: 'env', name: name[1]!, label: slotLabel(name[1]!), file: FILE_HINT_RE.test(k) || FILE_HINT_RE.test(name[1]!) });
    }
  }
  for (const [k, v] of Object.entries(input.headers)) {
    for (const name of v.matchAll(SLOT_PLACEHOLDER_SCAN_RE)) {
      add({ target: 'headers', name: name[1]!, label: slotLabel(name[1]!), file: FILE_HINT_RE.test(k) });
    }
  }
  input.args.forEach((a) => {
    for (const name of a.matchAll(SLOT_PLACEHOLDER_SCAN_RE)) {
      add({ target: 'args', name: name[1]!, label: slotLabel(name[1]!), file: FILE_HINT_RE.test(name[1]!) });
    }
  });
  for (const name of (input.url ?? '').matchAll(SLOT_PLACEHOLDER_SCAN_RE)) {
    add({ target: 'url', name: name[1]!, label: slotLabel(name[1]!), file: false });
  }
  return [...out.values()];
}

/**
 * 明文密钥扫描（T5-3）：找出会被**明文写入配置**的敏感值（未走 ${SLOT} 占位符）。
 * 仅覆盖明确场景：args 里的 `--password=xxx` / `PASSWORD=xxx`，以及含敏感键名且非占位符的值。
 * 返回人可读的中文描述，供创建前提示"建议改用槽位"——不阻断创建（窄域提示）。
 */
const SENSITIVE_NAME_RE = /password|passwd|secret|token|api[-_]?key|private[-_]?key|credential/i;

export function detectPlaintextSecrets(input: SlotScanInput): string[] {
  const hits: string[] = [];
  const isPlaceholder = (v: string) => hasPlaceholder(v);

  for (const a of input.args) {
    const m = /^--?([A-Za-z0-9_-]+)=(.+)$/.exec(a);
    if (m && SENSITIVE_NAME_RE.test(m[1]!) && !isPlaceholder(m[2]!)) {
      hits.push(`args 参数 ${m[1]} 的值将以明文进入启动命令`);
    }
  }
  for (const [k, v] of Object.entries(input.env)) {
    if (SENSITIVE_NAME_RE.test(k) && v.trim() && !isPlaceholder(v)) {
      hits.push(`环境变量 ${k} 的值将以明文写入资产配置`);
    }
  }
  for (const [k, v] of Object.entries(input.headers)) {
    if (SENSITIVE_NAME_RE.test(k) && v.trim() && !isPlaceholder(v)) {
      hits.push(`请求头 ${k} 的值将以明文写入资产配置`);
    }
  }
  return hits;
}
