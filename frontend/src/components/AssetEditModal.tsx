import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Save } from 'lucide-react';
import { api, ApiError } from '../api';
import Modal from './Modal';
import TagEditor from './TagEditor';

/** 详情页返回的资产（只取编辑需要的字段） */
export interface EditableAsset {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  type: string;
  executionMode: string;
  category: string;
  tags: string[] | null;
  url: string | null;
  allowPrivateNetwork?: boolean;
  hostConn: Record<string, unknown> | null;
}

/**
 * 编辑资产：只改「名称 / 显示名 / 说明 / 标签 + 连接目标」。
 *
 * 形态三件套（品类 / 执行模式 / 协议）与执行配置（命令 / 参数 / 环境变量）**不开放**：
 * 它们决定"这个资产是什么"和"怎么跑起来"，改错会连带工具名前缀、策略作用域、
 * 实例计划一起变；建错了应当重建资产，而不是在旧资产上换形态。
 * 后端 PATCH 同样拒绝这些字段，避免留下无 UI 的写入口。
 *
 * 连接目标仍开放：填错端口/地址是常见操作失误，而目标本身可校验（改 host/port 清指纹）。
 * 安全开关（允许私网访问）随连接地址一起，属于"同一个目标是否可达"的判断；
 * 允许不安全 TLS 这类纯安全策略仍留在详情页「可见性」，不挤进编辑弹窗。
 * 提交只带**变了的**字段，未编辑内容不会被原样写回（避免无意义审计与实例回收）。
 */
export default function AssetEditModal({
  asset, onClose, onSaved,
}: {
  asset: EditableAsset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const isSsh = asset.executionMode === 'native' && asset.category === 'host';
  const hasUrl = !isSsh && asset.type !== 'stdio';
  const hc = (asset.hostConn ?? {}) as Record<string, unknown>;

  const [name, setName] = useState(asset.name);
  const [displayName, setDisplayName] = useState(asset.displayName ?? '');
  const [description, setDescription] = useState(asset.description ?? '');
  const [tags, setTags] = useState<string[]>(asset.tags ?? []);
  const [url, setUrl] = useState(asset.url ?? '');
  const [allowPrivate, setAllowPrivate] = useState(Boolean(asset.allowPrivateNetwork));
  const [host, setHost] = useState(String(hc.host ?? ''));
  const [port, setPort] = useState(String(hc.port ?? ''));
  const [username, setUsername] = useState(String(hc.username ?? ''));
  const [err, setErr] = useState('');

  /** 只在提交时算 diff：未改动的字段不发送 */
  const payload = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (name.trim() !== asset.name) out.name = name.trim();
    if (displayName.trim() !== (asset.displayName ?? '')) out.displayName = displayName.trim();
    if (description.trim() !== (asset.description ?? '')) out.description = description.trim();
    const tagsChanged = JSON.stringify(tags.slice().sort()) !== JSON.stringify((asset.tags ?? []).slice().sort());
    if (tagsChanged) out.tags = tags;
    if (hasUrl && url.trim() !== (asset.url ?? '')) out.url = url.trim();
    // 私网开关只在填了地址时才有意义；同批携带，后端按"变更后的最终值"做 SSRF 校验
    if (hasUrl && allowPrivate !== Boolean(asset.allowPrivateNetwork)) out.allowPrivateNetwork = allowPrivate;
    if (isSsh) {
      const hcNext: Record<string, unknown> = {};
      if (host.trim() !== String(hc.host ?? '')) hcNext.host = host.trim();
      if (port.trim() !== String(hc.port ?? '')) hcNext.port = Number(port);
      if (username.trim() !== String(hc.username ?? '')) hcNext.username = username.trim();
      if (Object.keys(hcNext).length > 0) out.hostConn = hcNext;
    }
    return out;
  }, [name, displayName, description, tags, url, allowPrivate, host, port, username, asset, hc, isSsh, hasUrl]);

  const dirtyKeys = Object.keys(payload);
  const willResetFingerprint = Boolean(payload.hostConn) && (
    'host' in (payload.hostConn as object) || 'port' in (payload.hostConn as object)
  ) && Boolean(hc.hostFingerprint);

  const save = useMutation({
    mutationFn: () => api(`/api/v1/servers/${asset.id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['asset', asset.id] });
      void qc.invalidateQueries({ queryKey: ['assets'] });
      void qc.invalidateQueries({ queryKey: ['server-tags'] });
      onSaved();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : '保存失败'),
  });

  const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div style={{ display: 'grid', gap: 4 }}>
      <label style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{label}</label>
      {children}
      {hint && <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>{hint}</div>}
    </div>
  );

  return (
    <Modal title="编辑资产" onClose={onClose} width={640} dirty={dirtyKeys.length > 0}>
      <Field label="资产名称" hint="DNS-1123：小写字母/数字/连字符/点">
        <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="显示名（可选）">
        <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="展示用名称" />
      </Field>
      <Field label="说明（可选）">
        <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="用途、注意事项等" />
      </Field>
      <Field label="标签" hint="用于 MCP ?tag= 收窄与筛选，按精确值匹配">
        <TagEditor value={tags} onChange={setTags} />
      </Field>

      {isSsh && (
        <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'grid', gap: 8 }}>
          <span style={{ color: 'var(--fg-2)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>连接目标</span>
          {/* 三列宽度用「可收缩的最小宽度」而不是固定宽度：input 的固有宽度不会再顶开整行，
              窗口收窄时先缩输入框、再换行，不会出现横向滚动条 */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: '2 1 200px', minWidth: 0 }}><Field label="主机地址"><input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} /></Field></div>
            <div style={{ flex: '0 0 104px' }}><Field label="端口"><input className="input mono" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} /></Field></div>
            <div style={{ flex: '1 1 140px', minWidth: 0 }}><Field label="登录用户名"><input className="input mono" value={username} onChange={(e) => setUsername(e.target.value)} /></Field></div>
          </div>
          {willResetFingerprint && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: 'var(--warn)', fontSize: 'var(--text-xs)' }}>
              <AlertTriangle size={13} strokeWidth={2} style={{ marginTop: 1, flexShrink: 0 }} />
              改了主机或端口 → 已信任的主机指纹会被清空，保存后需重新「信任主机指纹」。
            </div>
          )}
        </div>
      )}

      {!isSsh && (
        <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'grid', gap: 8 }}>
          <span style={{ color: 'var(--fg-2)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>连接目标</span>
          {hasUrl && (
            <>
              <Field label="连接地址" hint="内网地址需同时勾选「允许私网访问」；变更会回收运行实例">
                <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://host:port/mcp" />
              </Field>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                <input type="checkbox" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} />
                允许私网访问
              </label>
            </>
          )}
          {!hasUrl && (
            <div style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
              stdio 资产无连接地址；TLS 校验开关在「可见性」页。
            </div>
          )}
        </div>
      )}

      {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ color: 'var(--meta)', fontSize: 'var(--text-xs)' }}>
          {dirtyKeys.length > 0 ? `将修改 ${dirtyKeys.length} 项` : '未做修改'}
        </span>
        <button className="btn" onClick={onClose}>取消</button>
        <button
          className="btn btn-primary"
          disabled={dirtyKeys.length === 0 || save.isPending}
          onClick={() => { setErr(''); save.mutate(); }}
          style={{ gap: 6 }}
        >
          <Save size={14} strokeWidth={1.8} /> {save.isPending ? '保存中…' : '保存'}
        </button>
      </div>
    </Modal>
  );
}
