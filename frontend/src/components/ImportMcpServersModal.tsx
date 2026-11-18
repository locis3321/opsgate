import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Upload, FileJson, CheckCircle2, XCircle } from 'lucide-react';
import { api, ApiError } from '../api';
import Modal from './Modal';
import StatusBadge from './StatusBadge';
import { detectSlots } from '../slots';

/**
 * 标准 mcpServers JSON 批量导入（T3）。
 * 形状：{ "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...}, "url": "...", "headers": {...} } } }
 * 逐条创建并回显成功/失败（不因一条失败而中断整批）；占位符 ${VAR} 自动识别为凭证槽位（未绑 → 该变量不注入）。
 */

interface McpServerSpec {
  command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown;
  type?: unknown;
}

interface ParsedItem {
  name: string;
  error?: string;
  spec?: { type: 'stdio' | 'http' | 'sse'; command?: string; args: string[]; env: Record<string, string>; url?: string; headers: Record<string, string> };
  slots?: Array<{ target: string; name: string; label: string; file: boolean }>;
}

const NAME_OK = /^[a-z0-9.-]+$/;

function asStringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, typeof val === 'string' ? val : String(val)]));
}

/** 解析并逐条校验；错误就地标出，不影响其它条目 */
function parseServers(text: string): ParsedItem[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 解析失败：' + (e instanceof Error ? e.message : String(e)));
  }
  const servers = (root as { mcpServers?: unknown })?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('缺少 mcpServers 对象（示例：{"mcpServers":{"my-server":{"command":"npx","args":["-y","pkg"]}}}）');
  }
  return Object.entries(servers as Record<string, McpServerSpec>).map(([name, raw]) => {
    const spec = (raw ?? {}) as McpServerSpec;
    if (!NAME_OK.test(name)) {
      return { name, error: '名称需为小写字母/数字/-/.（DNS-1123）' };
    }
    const url = typeof spec.url === 'string' ? spec.url.trim() : '';
    const command = typeof spec.command === 'string' ? spec.command.trim() : '';
    const args = Array.isArray(spec.args) ? spec.args.map((a) => String(a)) : [];
    const env = asStringRecord(spec.env);
    const headers = asStringRecord(spec.headers);
    if (!url && !command) return { name, error: '需 command（stdio）或 url（HTTP/SSE）' };
    if (command && url) return { name, error: 'command 与 url 只能二选一' };
    const explicitType = typeof spec.type === 'string' ? spec.type : '';
    const type = (url ? (explicitType === 'sse' ? 'sse' : 'http') : 'stdio') as 'stdio' | 'http' | 'sse';
    const slots = detectSlots({ env, args, headers }).map((s) => ({ target: s.target, name: s.name, label: s.label, file: s.file }));
    return {
      name,
      spec: { type, ...(command ? { command } : {}), args, env, url: url || undefined, headers },
      slots,
    };
  });
}

interface ResultRow { name: string; ok: boolean; message: string }

export default function ImportMcpServersModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [parseErr, setParseErr] = useState('');
  const [items, setItems] = useState<ParsedItem[] | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);

  const parsed = useMemo(() => items, [items]);

  const run = useMutation({
    mutationFn: async () => {
      const list = parseServers(text);
      if (list.length === 0) throw new Error('mcpServers 为空');
      setItems(list);
      let createdAny = false;
      const out: ResultRow[] = [];
      for (const it of list) {
        if (it.error || !it.spec) {
          out.push({ name: it.name, ok: false, message: it.error ?? '解析失败' });
          setResults([...out]);
          continue;
        }
        const body = {
          name: it.name,
          displayName: it.name,
          type: it.spec.type,
          executionMode: 'mcp',
          category: 'other',
          ...(it.spec.url
            ? { url: it.spec.url, headers: it.spec.headers }
            : { command: it.spec.command, args: it.spec.args, env: it.spec.env }),
          credentialSlots: it.slots ?? [],
        };
        try {
          await api('/api/v1/servers', { method: 'POST', body: JSON.stringify(body) });
          out.push({ name: it.name, ok: true, message: '已创建' });
          createdAny = true;
        } catch (e) {
          out.push({ name: it.name, ok: false, message: e instanceof ApiError ? e.message : String(e) });
        }
        setResults([...out]);
      }
      // 有任意一条创建成功即通知父级刷新列表（用户可能直接关闭弹窗）
      if (createdAny) onImported();
      return out;
    },
    onError: (e) => setParseErr(e instanceof Error ? e.message : String(e)),
  });

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  const done = results.length > 0 && !run.isPending;

  return (
    <Modal title="批量导入 mcpServers" onClose={onClose} width={720} dirty={text.trim().length > 0 && results.length === 0}>
      <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
        粘贴标准 <code className="mono">mcpServers</code> JSON（与 Claude Desktop / Cursor 配置同形状）。
        逐条创建并回显结果；env/args/headers 中的 <code className="mono">{'${VAR}'}</code> 会自动识别为凭证槽位，
        导入后可在资产详情补齐取值。
      </div>
      <textarea
        className="input mono"
        rows={12}
        spellCheck={false}
        placeholder={'{\n  "mcpServers": {\n    "my-server": { "command": "npx", "args": ["-y", "some-mcp@1.0.0"], "env": { "TOKEN": "${TOKEN}" } }\n  }\n}'}
        value={text}
        onChange={(e) => { setText(e.target.value); setParseErr(''); setItems(null); setResults([]); }}
        style={{ fontSize: 12 }}
      />
      {parseErr && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{parseErr}</div>}

      {parsed && parsed.length > 0 && (
        <div className="card" style={{ overflow: 'auto', boxShadow: 'none' }}>
          <table className="dt">
            <thead><tr><th>名称</th><th>协议</th><th>槽位</th><th>结果</th></tr></thead>
            <tbody>
              {parsed.map((it) => {
                const r = results.find((x) => x.name === it.name);
                return (
                  <tr key={it.name}>
                    <td className="mono">{it.name}</td>
                    <td>{it.spec?.type ?? '—'}</td>
                    <td className="mono" style={{ fontSize: 'var(--text-xs)' }}>
                      {it.slots && it.slots.length > 0 ? it.slots.map((s) => s.name).join('、') : '无'}
                    </td>
                    <td>
                      {!r
                        ? <StatusBadge kind="disabled" label="待导入" />
                        : r.ok
                          ? <StatusBadge kind="success" label="成功" />
                          : <StatusBadge kind="error" label={r.message} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {done && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--text-sm)' }}>
          {okCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--success)' }}><CheckCircle2 size={14} /> {okCount} 条成功</span>}
          {failCount > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--danger)' }}><XCircle size={14} /> {failCount} 条失败</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {done && <button className="btn" onClick={() => { onImported(); onClose(); }}>查看资产列表</button>}
        <button className="btn" onClick={onClose}>关闭</button>
        <button className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending || !text.trim()}>
          {run.isPending ? <FileJson size={14} className="spin" /> : <Upload size={14} strokeWidth={1.8} />}
          {run.isPending ? '导入中…' : '解析并导入'}
        </button>
      </div>
    </Modal>
  );
}
