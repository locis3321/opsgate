/**
 * 凭证值格式校验（保存前 fail-closed）。
 *
 * 为什么需要：kubeconfig / 私钥这类多行内容是**结构性文本**，一个缩进或换行错位就会让
 * 下游客户端解析失败，而错误往往在几千行之外才以"连不上"的形式冒出来。这里在保存点
 * 做最小但有效的结构检查，让问题在最早可判断的位置暴露（AGENTS.md §2 原则 5）。
 *
 * 不做完整 YAML 解析（项目未引入 YAML 依赖，且完整校验属于下游客户端职责），
 * 只拦截"明显坏掉"的形态：缺必需键、YAML 混用制表符、括号/引号明显不闭合。
 */

/** kubeconfig 的必需结构：apiVersion / kind / clusters / contexts（current-context 视客户端而定） */
export function validateKubeconfig(text: string): string | null {
  const t = text.trim();
  if (!t) return 'kubeconfig 内容为空';
  if (/^\t/m.test(t) || /^[ ]*\t/m.test(t)) {
    return 'kubeconfig 含制表符（Tab）缩进：YAML 不允许用 Tab 缩进，请改为空格';
  }
  if (!/^apiVersion\s*:/m.test(t)) return 'kubeconfig 缺少 apiVersion 字段';
  if (!/^kind\s*:\s*Config\s*$/m.test(t)) return 'kubeconfig 缺少 kind: Config';
  if (!/^clusters\s*:/m.test(t)) return 'kubeconfig 缺少 clusters 段';
  if (!/^contexts\s*:/m.test(t)) return 'kubeconfig 缺少 contexts 段';
  if (!/^users\s*:/m.test(t)) return 'kubeconfig 缺少 users 段';
  // 常见误操作：把整份 YAML 压成一行（含 \n 却全是 "apiVersion: v1 kind: Config ..." 这种）
  if (!t.includes('\n') && t.length > 120) {
    return 'kubeconfig 像是一行内容：请粘贴保留换行的原始 YAML（多行）';
  }
  return null;
}

/** PEM 私钥的基本形态检查 */
export function validatePrivateKey(text: string): string | null {
  const t = text.trim();
  if (!t) return '私钥内容为空';
  const hasBegin = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(t);
  const hasEnd = /-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(t);
  if (!hasBegin || !hasEnd) {
    return '私钥格式不正确：应以 -----BEGIN ... PRIVATE KEY----- 开头、-----END ... PRIVATE KEY----- 结尾';
  }
  if (!t.includes('\n')) return '私钥像是一行内容：请粘贴保留换行的原始内容（多行）';
  return null;
}

/** 按凭证类型/键名校验；返回 null 表示通过 */
export function validateCredentialValues(
  kind: string | null | undefined,
  values: Record<string, string>,
): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') continue;
    if (kind === 'kubeconfig' || /kubeconfig/i.test(key)) {
      const err = validateKubeconfig(value);
      if (err) return `${key}：${err}`;
      continue;
    }
    // 只有"装私钥的那一个键"才按私钥校验。ssh_key 凭证还有 username/passphrase 等普通值，
    // 按类型一刀切会把用户名当成私钥判坏（2026-11-17 加入 username 键时踩到）。
    const isKeyField = /private[_-]?key/i.test(key) || key === 'AUTH' || key === 'privateKey';
    if (!isKeyField) continue;
    // AUTH 既可能是私钥也可能是密码（user_password 也用 AUTH），只在看起来像 PEM 时才校验
    if (/-----BEGIN/.test(value) || kind === 'ssh_key') {
      const err = validatePrivateKey(value);
      if (err) return `${key}：${err}`;
    }
  }
  return null;
}
