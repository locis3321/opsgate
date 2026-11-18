#!/usr/bin/env node
/**
 * 红线静态检查（任何一条失败 → 退出码 1，CI 即失败）：
 *  1. AC-61：src/ 下除 src/config/ 外不得出现 `process.env`（配置必须走 settings.get()）
 *  2. AC-58：SETTINGS_SCHEMA 不得出现匹配 /audit.*(enable|disable|skip)|accessMode|authorize/i 的 key
 *  3. P0 红线：src/ 下禁止 emoji（功能图标只允许 lucide-react）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const FE_SRC = join(ROOT, 'frontend', 'src');

const FORBIDDEN_KEY_RE = /audit.*(enable|disable|skip)|accessMode|authorize/i;
const PROCESS_ENV_RE = /process\.env/;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;

const errors = [];

function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...tsFiles(p));
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function lineCol(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - before.lastIndexOf('\n');
  return { line, col };
}

// —— 1. process.env 泄漏（AC-61）——
const configDir = join(SRC, 'config') + sep;
for (const file of tsFiles(SRC)) {
  if (file.startsWith(configDir)) continue;
  // 测试文件豁免：测试门控读 env（如 SSH_E2E）不是业务代码，AC-61 约束业务代码
  if (/\.test\.ts$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  const m = PROCESS_ENV_RE.exec(text);
  if (m) {
    const { line } = lineCol(text, m.index);
    errors.push(`[AC-61] ${rel(file)}:${line} 出现 process.env（只允许存在于 src/config/）`);
  }
}

// —— 2. 配置红线 key（AC-58）——
const schemaFile = join(configDir, 'settingsSchema.ts');
const schemaText = readFileSync(schemaFile, 'utf8');
for (const m of schemaText.matchAll(/key:\s*['"]([^'"]+)['"]/g)) {
  const key = m[1];
  if (FORBIDDEN_KEY_RE.test(key)) {
    const { line } = lineCol(schemaText, m.index);
    errors.push(`[AC-58] ${rel(schemaFile)}:${line} 配置 key "${key}" 命中不可配置红线`);
  }
}

// —— 2.5 配置引用闸门（ADR-024 / AC-55）：SETTINGS_SCHEMA 每项必须被 settings.get/hot/getSetting 消费 ——
function hasUsage(text, key) {
  for (const needle of ["'" + key + "'", '"' + key + '"']) {
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      const before = text.slice(Math.max(0, idx - 80), idx);
      if (/get(?:<[^>]*>)?\(/.test(before) || /hot\(/.test(before) || /getSetting\(/.test(before)) {
        return true;
      }
      idx = text.indexOf(needle, idx + 1);
    }
  }
  return false;
}
for (const m of schemaText.matchAll(/key:\s*['"]([^'"]+)['"]/g)) {
  const key = m[1];
  let found = false;
  for (const file of tsFiles(SRC)) {
    if (file.startsWith(configDir) && file.endsWith('settingsSchema.ts')) continue;
    if (hasUsage(readFileSync(file, 'utf8'), key)) {
      found = true;
      break;
    }
  }
  if (!found) {
    errors.push(`[AC-55-ref] 配置项 "${key}" 无任何 settings.get/hot/getSetting 引用（零引用 = 假配置）`);
  }
}


// —— 2.6 生产装配闸门（E2E-R4）：src/server.ts 中 TransferService/InstancePool/SshConnector/AuditService 构造必须传 settings 源 ——
const serverText = readFileSync(join(SRC, 'server.ts'), 'utf8');
function constructorBlock(text, startIdx) {
  // 括号深度扫描定位构造结束（避免配置体内 `]);` 之类的字符串提前截断）
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return text.slice(startIdx);
}
for (const ctorName of ['TransferService', 'InstancePool', 'SshConnector', 'AuditService']) {
  let idx = serverText.indexOf('new ' + ctorName + '(');
  while (idx !== -1) {
    const block = constructorBlock(serverText, idx);
    // settings 源必须作为构造参数出现（, settings 或 , undefined, settings）——不能仅凭配置体内 settings.get（恒真）
    if (!/,\s*(?:undefined\s*,)?\s*settings\s*\)/.test(block)) {
      errors.push('[AC-55-wire] server.ts 中 ' + ctorName + ' 构造未传 settings 源（启动快照=热生效失效）');
    }
    idx = serverText.indexOf('new ' + ctorName + '(', idx + 1);
  }
}

// —— 3. emoji 扫描（P0，src/ + frontend/src/）——
for (const file of [...tsFiles(SRC), ...tsFiles(FE_SRC)]) {
  const text = readFileSync(file, 'utf8');
  const m = EMOJI_RE.exec(text);
  if (m) {
    const { line, col } = lineCol(text, m.index);
    errors.push(`[P0-emoji] ${rel(file)}:${line}:${col} 出现 emoji "${m[0]}"（功能图标只允许 lucide-react）`);
  }
}

function rel(p) {
  const root = ROOT.endsWith(sep) ? ROOT : ROOT + sep;
  return p.slice(root.length).split(sep).join('/');
}

if (errors.length > 0) {
  console.error('红线检查未通过：');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log('红线检查通过（AC-58 / AC-61 / emoji）。');
