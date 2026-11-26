import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Search, X } from 'lucide-react';

/** 候选凭证（GET /credentials/candidates） */
export interface CredCandidate {
  id: string; name: string; kind: string; valueHint: string; keys?: string[];
}

/** 归一化：去品类前缀（`NACOS_USERNAME` → `USERNAME`）+ 小写 + 去下划线，用于宽松匹配 */
const normalizeSlotKey = (s: string): string =>
  s.replace(/^[A-Z][A-Z0-9]*_/, '').toLowerCase().replace(/[_-]/g, '');

/** 认证类凭证类型：可用于 SSH/主机登录认证（密码或私钥） */
const AUTH_CRED_KINDS = new Set(['user_password', 'ssh_key']);

/** 槽位是否属于"认证类"：file 槽位（私钥/kubeconfig 文件）或名字含认证语义 */
const isAuthSlot = (slotName: string, isFile?: boolean): boolean => {
  if (isFile) return true;
  return /auth|credential|login|password|passwd|privatekey|pem/i.test(slotName);
};

/** 槽位是否 kubeconfig 槽位（这类只有 kubeconfig 凭证能绑，不参与认证兜底） */
const isKubeconfigSlot = (slotName: string, isFile?: boolean): boolean =>
  /kubeconfig/i.test(slotName) || (isFile === true && /kube/i.test(slotName));

/**
 * 槽位与凭证是否可绑定。
 *
 * 判定顺序（命中任一即可）：
 *  1. 键名完全相等；
 *  2. 归一化后相等（前缀/大小写/下划线不敏感：`NACOS_USERNAME` ≡ `username`）；
 *  3. 凭证只有一个键 → 允许（后端取值会回落到唯一值）；
 *  4. **认证槽位与认证类凭证互通**：槽位是认证类（file 或名字含 auth/login/password 等）时，
 *     `user_password` / `ssh_key` 凭证也允许绑定——两者的键名天然不同
 *     （凭证键是 username/password/AUTH，槽位常命名为 AUTH），只靠键名匹配会导致
 *     "账号密码凭证永远选不到 SSH 的认证槽位"。
 *     kubeconfig 槽位不走这条兜底（避免把 kubeconfig 凭证误绑成 SSH 认证）。
 */
export function slotMatches(c: CredCandidate, slotName: string, isFile?: boolean): boolean {
  const keys = c.keys ?? [];
  if (keys.length === 0) return false;
  const target = normalizeSlotKey(slotName);
  if (keys.some((k) => k === slotName || normalizeSlotKey(k) === target)) return true;
  // kubeconfig 凭证只能服务 kubeconfig 槽位：即便只有单键，也不能被 SSH/密码槽位选中
  if (c.kind === 'kubeconfig') return isKubeconfigSlot(slotName, isFile);
  if (keys.length === 1) return true;
  // 认证槽位与认证类凭证互通（账号密码/私钥）；键名天然不同（password vs AUTH），必须靠类型兜底
  if (isAuthSlot(slotName, isFile) && !isKubeconfigSlot(slotName, isFile) && AUTH_CRED_KINDS.has(c.kind)) {
    return true;
  }
  return false;
}

/** 下拉面板锚点（position:fixed 坐标） */
interface PanelAnchor { top: number; left: number; width: number }

/**
 * 候选凭证下拉面板：搜索框 + 可滚动列表 + 键盘导航。
 *
 * 为什么单独抽出来：资产详情（一槽多绑定）与创建弹窗（单槽绑定）两处都要用，
 * 早期各写一份，导致「能不能滚动 / 能不能搜索」的修复必须做两遍且容易漂移。
 */
function CredentialPickerPanel({
  anchor, panelRef, options, matchedIds, slotName, onPick, onClose,
}: {
  anchor: PanelAnchor;
  panelRef: React.RefObject<HTMLDivElement | null>;
  /** 全部候选（服务端已按归属过滤：仅本人凭证，admin 见全部） */
  options: CredCandidate[];
  /** 与槽位匹配的候选 id 集合（仅用于排序与标注，不用于过滤） */
  matchedIds: Set<string>;
  slotName: string;
  onPick: (credentialId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  /**
   * 候选全给、只按搜索词过滤，匹配项排在前面并打标。
   *
   * 为什么不按匹配规则过滤：规则再细也挡不住"用户知道自己要绑哪个"，
   * 过滤只会让本该可选的凭证消失（如 MySQL 的 host 槽位，规则会把它认为"不匹配"的凭证全藏起来）。
   * 排序+标注既保留了提示，又不夺走用户的选择权。
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byQuery = q
      ? options.filter((c) => c.name.toLowerCase().includes(q) || c.valueHint.toLowerCase().includes(q) || c.kind.toLowerCase().includes(q))
      : options;
    // 匹配项在前，同组内保持原序（服务端按名称排序）
    const matched = byQuery.filter((c) => matchedIds.has(c.id));
    const rest = byQuery.filter((c) => !matchedIds.has(c.id));
    return [...matched, ...rest];
  }, [options, query, matchedIds]);

  useEffect(() => { searchRef.current?.focus(); }, []);
  // 过滤结果变化后，高亮项可能越界
  useEffect(() => { setActive(0); }, [query]);

  const commit = (c: CredCandidate) => { onPick(c.id); onClose(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(filtered.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = filtered[active]; if (c) commit(c); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed', top: anchor.top, left: anchor.left,
        width: Math.max(anchor.width, 260), maxWidth: 380,
        zIndex: 200, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 6,
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
        // 高度按可视空间收紧：面板永远不会比视口高，列表区再自行滚动
        maxHeight: Math.max(160, Math.min(320, window.innerHeight - anchor.top - 12)),
      }}
    >
      <div style={{ padding: 6, borderBottom: '1px solid var(--border-soft)', display: 'flex', gap: 4, alignItems: 'center' }}>
        <Search size={12} strokeWidth={2} style={{ color: 'var(--meta)', flexShrink: 0 }} />
        <input
          ref={searchRef}
          className="input"
          style={{ height: 26, fontSize: 12, padding: '0 6px', flex: 1 }}
          placeholder="搜索凭证名 / 值提示 / 类型…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {/* 列表独立滚动区：高度受限 + overflow auto，滚动条可拖动（父层不再拦截自身滚动的关闭逻辑） */}
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '10px', color: 'var(--meta)', fontSize: 12, lineHeight: 1.7 }}>
            {options.length === 0 ? (
              <>
                <div style={{ fontWeight: 600, color: 'var(--fg-2)', marginBottom: 4 }}>还没有可用凭证</div>
                <div>绑定候选只含你自己创建的凭证（共享凭证只能使用、不能绑定）。</div>
                <a href="#/credentials" style={{ display: 'inline-block', marginTop: 6 }}>去创建凭证 →</a>
              </>
            ) : (
              <div>没有匹配「<b>{query.trim()}</b>」的凭证（共 {options.length} 个可选）</div>
            )}
          </div>
        ) : (
          filtered.map((c, i) => {
            const matched = matchedIds.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  // 高亮用 background：纯键盘操作时用户要能看见当前选中项
                  background: i === active ? 'var(--accent-soft)' : 'transparent',
                  border: 'none', borderBottom: '1px solid var(--border-soft)',
                  padding: '8px 10px', color: 'var(--fg)', fontSize: 'var(--text-sm)',
                }}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(c)}
              >
                <span className="mono">{c.name}</span>
                <span style={{ color: 'var(--meta)', marginLeft: 8 }}>{c.valueHint}</span>
                <span style={{ color: 'var(--meta)', marginLeft: 8, fontSize: 11 }}>{c.kind}</span>
                {matched && (
                  <span style={{ color: 'var(--accent)', marginLeft: 8, fontSize: 11 }} title={`含键 ${slotName}，绑定后无需改键`}>
                    匹配 {slotName}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 槽位取值编辑器：主控件是输入框（可直接填凭证值），右侧 + 打开已有凭证的选择下拉。
 * 两种取值方式互斥 —— 绑定凭证后输入框禁用（值由加密凭证提供）。
 * 下拉用 portal 渲染到 body：弹窗卡片是 overflow:auto 滚动容器，绝对定位会被裁剪。
 */
export default function SlotValueEditor({
  slotName, label, isFile, note, candidates, value, bound, dirty,
  onValueChange, onPick, onUnbind, onCommitValue, mode = 'full',
}: {
  slotName: string; label: string; isFile?: boolean;
  /** 槽位属性的补充说明（如「自动判定为文件」），渲染在标签下的小字 */
  note?: string;
  candidates: CredCandidate[];
  value: string;
  bound?: { id: string; name: string; valueHint: string };
  /** 有未保存改动（相对服务端已存值） */
  dirty?: boolean;
  onValueChange: (v: string) => void;
  onPick: (credentialId: string) => void;
  onUnbind: () => void;
  /** 提供时显示「保存」按钮（详情页即时落库；创建弹窗在提交时统一落库，不传） */
  onCommitValue?: (v: string) => void;
  /** full = 输入框 + 凭证下拉（默认）；pick-only = 只渲染「添加绑定」按钮（一槽多绑定场景） */
  mode?: 'full' | 'pick-only';
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<PanelAnchor | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const matchCandidates = candidates.filter((c) => slotMatches(c, slotName, isFile));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rowRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    // 面板是 position:fixed，页面滚动后会与锚点脱开，必须关闭；
    // 但**面板自身及其内部列表的滚动不能算**——否则候选一多就没法滚动查看（实测踩到）。
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const togglePicker = () => {
    if (open) { setOpen(false); return; }
    const r = rowRef.current?.getBoundingClientRect();
    if (r) {
      // 面板最大 320px：下方空间不足就向上展开，否则底部候选会被挤到视口外（无法够到）
      const PANEL_H = 320;
      const openUp = r.bottom + 4 + PANEL_H > window.innerHeight && r.top > PANEL_H;
      setAnchor({
        top: openUp ? Math.max(4, r.top - 4 - PANEL_H) : r.bottom + 4,
        left: r.left,
        width: r.width,
      });
    }
    setOpen(true);
  };

  // pick-only：只渲染「添加绑定」按钮 + 候选下拉（一槽多绑定场景；不显示输入框）
  if (mode === 'pick-only') {
    return (
      <div ref={rowRef} style={{ display: 'inline-flex', gap: 4 }}>
        <button
          type="button"
          className="btn"
          style={{ gap: 4, fontSize: 11, padding: '2px 8px' }}
          title="从自己创建的凭证中选择，追加一条绑定"
          onClick={togglePicker}
        >
          <Plus size={11} strokeWidth={2} /> 添加绑定
        </button>
        {open && anchor && (
          <CredentialPickerPanel
            anchor={anchor}
            panelRef={panelRef}
            options={candidates}
            matchedIds={new Set(matchCandidates.map((c) => c.id))}
            slotName={slotName}
            onPick={onPick}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>
        {label && label !== slotName ? `${label}（${slotName}）` : slotName}
        {isFile ? ' · 文件' : ''}
      </label>
      {note && <div style={{ color: 'var(--meta)', fontSize: 11, lineHeight: 1.5 }}>{note}</div>}
      <div ref={rowRef} style={{ display: 'flex', gap: 4 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          disabled={!!bound}
          placeholder={bound ? '值由绑定凭证提供' : '直接输入凭证值，或点右侧 + 选择已有凭证'}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onCommitValue && value.trim()) onCommitValue(value.trim());
          }}
        />
        <button
          type="button"
          className="btn"
          style={{ flexShrink: 0, padding: '0 10px', gap: 4, whiteSpace: 'nowrap' }}
          title="从自己创建的凭证中选择绑定"
          onClick={togglePicker}
        >
          <Plus size={13} strokeWidth={2} /> 选择凭证
        </button>
        {onCommitValue && dirty && !bound && (
          <button type="button" className="btn btn-primary" style={{ flexShrink: 0 }} onClick={() => onCommitValue(value)}>
            保存
          </button>
        )}
      </div>
      {bound && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--meta)' }}>
          <span>
            已绑定 <span className="mono" style={{ color: 'var(--fg-2)' }}>{bound.name}</span>（{bound.valueHint}）
          </span>
          <button type="button" className="btn" style={{ fontSize: 11, padding: '0 6px', gap: 3 }} onClick={onUnbind}>
            <X size={12} strokeWidth={2} /> 解除
          </button>
        </div>
      )}
      {open && anchor && (
        <CredentialPickerPanel
          anchor={anchor}
          panelRef={panelRef}
          options={candidates}
          matchedIds={new Set(matchCandidates.map((c) => c.id))}
          slotName={slotName}
          onPick={onPick}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
