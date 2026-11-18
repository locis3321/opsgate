import { Fragment, type ReactNode } from 'react';

/**
 * 极简 Markdown 渲染（README 展示用）。
 *
 * 为什么不用第三方 markdown 库 + HTML 注入渲染：
 * README 来自 PyPI/npm/GitHub 等外部内容，属于不可信输入。本项目只依赖 React 元素渲染，
 * 全程不写入原始 HTML，因此不存在 HTML 注入面；链接也只放行 http/https。
 * 支持子集：标题 / 段落 / 围栏代码块 / 行内代码 / 无序与有序列表 / 引用 / 粗体 / 链接 / 分隔线。
 */
export default function MarkdownView({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const push = (node: ReactNode) => {
    blocks.push(<Fragment key={key++}>{node}</Fragment>);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // 围栏代码块
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // 跳过结束围栏
      push(
        <pre
          className="mono"
          data-lang={lang || undefined}
          style={{
            background: 'var(--surface-raise)',
            padding: 12,
            borderRadius: 'var(--radius)',
            overflowX: 'auto',
            fontSize: 'var(--text-xs)',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            margin: '6px 0',
          }}
        >
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const size = level === 1 ? 'var(--text-base)' : level === 2 ? 'var(--text-sm)' : 'var(--text-xs)';
      push(
        <div
          style={{
            fontWeight: 650,
            fontSize: size,
            margin: level <= 2 ? '12px 0 6px' : '8px 0 4px',
            color: 'var(--fg)',
          }}
        >
          {inline(h[2]!)}
        </div>,
      );
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      push(<hr style={{ border: 'none', borderTop: '1px solid var(--border-soft)', margin: '10px 0' }} />);
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      push(
        <blockquote
          style={{
            margin: '6px 0',
            padding: '4px 10px',
            borderLeft: '3px solid var(--border)',
            color: 'var(--muted)',
            fontSize: 'var(--text-xs)',
          }}
        >
          {inline(buf.join(' '))}
        </blockquote>,
      );
      continue;
    }

    // 列表（无序 / 有序连续项成组）
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const ordered = !!ol;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = ordered ? /^\s*(\d+)[.)]\s+(.*)$/.exec(cur) : /^\s*[-*+]\s+(.*)$/.exec(cur);
        if (!m) break;
        items.push(ordered ? m[2]! : m[1]!);
        i++;
      }
      push(
        ordered ? (
          <ol style={{ margin: '6px 0', paddingLeft: 20, fontSize: 'var(--text-xs)', lineHeight: 1.8 }}>
            {items.map((t, idx) => <li key={idx}>{inline(t)}</li>)}
          </ol>
        ) : (
          <ul style={{ margin: '6px 0', paddingLeft: 20, fontSize: 'var(--text-xs)', lineHeight: 1.8 }}>
            {items.map((t, idx) => <li key={idx}>{inline(t)}</li>)}
          </ul>
        ),
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 段落：连续非空行合并
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(#{1,4}\s|```|>\s?|[-*+]\s|\d+[.)]\s)/.test(lines[i]!)) {
      buf.push(lines[i]!);
      i++;
    }
    push(
      <p style={{ margin: '6px 0', fontSize: 'var(--text-xs)', lineHeight: 1.7, color: 'var(--fg-2)' }}>
        {inline(buf.join(' '))}
      </p>,
    );
  }

  return <div>{blocks}</div>;
}

/** 行内元素：粗体 / 行内代码 / 链接。全部走 React 元素，不拼 HTML 字符串。 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 交替匹配：`code` | **bold** | [text](url)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(
        <code
          key={key++}
          className="mono"
          style={{ background: 'var(--surface-raise)', padding: '1px 5px', borderRadius: 4, fontSize: '0.95em' }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key++} style={{ color: 'var(--fg)', fontWeight: 650 }}>{tok.slice(2, -2)}</strong>);
    } else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const href = lm?.[2] ?? '';
      out.push(safeHref(href)
        ? <a key={key++} href={href} target="_blank" rel="noreferrer noopener">{label}</a>
        : <span key={key++}>{label}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 只放行 http/https（阻止 javascript: 等协议） */
function safeHref(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
