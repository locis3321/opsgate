import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Package, RefreshCw, Settings2 } from 'lucide-react';
import { api } from '../api';
import Combobox from '../components/Combobox';

interface CatalogItem {
  key: string; name: string; displayName: string; description: string;
  categories: string[]; tags: string[]; runtime: string; addedCount: number;
}

interface CategoryCount { category: string; count: number }

/** Market 目录（ADR-029 / §8.5 /market）：搜索 + 动态分类 + 卡片网格 + 已添加徽章；管理员可进条目管理。 */
export default function Market() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [retry, setRetry] = useState(0);
  const nav = useNavigate();
  // 管理入口仅管理员可见；会话由后端校验，前端只做展示控制
  const session = useQuery({
    queryKey: ['session-isadmin'],
    queryFn: async () => {
      const r = await fetch('/api/v1/auth/get-session', { credentials: 'include' });
      const j = (await r.json()) as { user?: { isAdmin?: boolean } };
      return Boolean(j?.user?.isAdmin);
    },
    staleTime: 60_000,
  });
  const isAdmin = session.data === true;
  const query = useQuery({
    queryKey: ['market', q, cat, retry],
    queryFn: () => api<{ items: CatalogItem[]; total: number }>(`/api/v1/market/catalog?q=${encodeURIComponent(q)}${cat ? `&category=${cat}` : ''}`),
  });
  // 分类由条目数据聚合（T7），不再硬编码
  const cats = useQuery({
    queryKey: ['market-categories'],
    queryFn: () => api<CategoryCount[]>('/api/v1/market/categories'),
  });

  return (
    <div className="page animate-slide-up">
      <div className="page-toolbar">
        <div className="page-toolbar-main">
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, marginBottom: 4 }}>Market 目录</h1>
          <p style={{ color: 'var(--muted)', margin: 0, fontSize: 'var(--text-sm)' }}>
            实测通过的 MCP 服务目录，版本固化，一键实例化
          </p>
        </div>
        <div className="page-toolbar-actions">
          <div style={{ position: 'relative', flex: '0 1 220px', minWidth: 140 }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--meta)', pointerEvents: 'none' }} strokeWidth={1.8} />
            <input className="input" style={{ paddingLeft: 34 }} placeholder="搜索名称或描述…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ minWidth: 128, flexShrink: 0 }}><Combobox
            ariaLabel="分类筛选"
            value={cat}
            onChange={setCat}
            placeholder="全部分类"
            options={[{ value: '', label: '全部分类' }, ...(cats.data ?? []).map((c) => ({ value: c.category, label: c.category, hint: String(c.count) }))]}
          /></div>
          <button className="btn" style={{ flexShrink: 0, gap: 6 }} onClick={() => { void query.refetch(); void cats.refetch(); }} disabled={query.isFetching} title="重新拉取目录与分类">
            <RefreshCw size={14} strokeWidth={1.8} className={query.isFetching ? 'spin' : ''} /> 刷新
          </button>
          {isAdmin && (
            <button className="btn" style={{ flexShrink: 0, gap: 6 }} onClick={() => nav('/market/entries')}>
              <Settings2 size={14} strokeWidth={1.8} /> 管理目录
            </button>
          )}
        </div>
      </div>

      {query.isError && (
        <div className="card animate-scale-in" style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>加载失败</span>
          <button className="btn" onClick={() => setRetry(retry + 1)}>
            <RefreshCw size={14} /> 重试
          </button>
        </div>
      )}

      {query.isLoading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="card" style={{ padding: 20 }}>
              <div className="skeleton" style={{ height: 18, width: '60%', marginBottom: 12 }} />
              <div className="skeleton" style={{ height: 14, width: '100%', marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 14, width: '80%', marginBottom: 16 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <div className="skeleton" style={{ height: 22, width: 50, borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 22, width: 40, borderRadius: 6 }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {query.data?.items.length === 0 && (
        <div className="empty">
          <Package size={32} style={{ color: 'var(--meta)', marginBottom: 8 }} strokeWidth={1.5} />
          <div>{q || cat ? '没有匹配的条目' : '目录为空'}</div>
          <div className="hint">
            {isAdmin ? '点击右上角「管理目录」新增或导入 MCP 条目' : '请联系管理员在「管理目录」中添加条目'}
          </div>
        </div>
      )}

      {query.data && query.data.items.length > 0 && (
        <div className="card-grid">
          {query.data.items.map((it, idx) => (
            <div
              key={it.key}
              className="card animate-slide-up"
              style={{
                padding: 20,
                cursor: 'pointer',
                animationDelay: `${idx * 40}ms`,
                animationFillMode: 'backwards',
              }}
              onClick={() => nav(`/market/${it.key}`)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 'var(--text-base)', color: 'var(--fg)' }}>{it.displayName}</span>
                {it.addedCount > 0 && <span className="tag">已添加 {it.addedCount}</span>}
              </div>
              <div style={{
                color: 'var(--fg-2)',
                fontSize: 'var(--text-sm)',
                lineHeight: 1.6,
                marginBottom: 14,
                minHeight: 40,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>{it.description}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {it.categories.map((c) => <span key={c} className="tag">{c}</span>)}
                <span className="tag" style={{ background: 'var(--surface-raise)', color: 'var(--muted)' }}>{it.runtime}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
