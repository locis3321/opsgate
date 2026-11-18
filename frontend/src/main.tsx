import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';

/**
 * 构建版本自检：本页面已加载的入口脚本名 vs 服务端当前 index.html 引用的脚本名。
 *
 * 为什么需要：SPA 在 hash 路由下不会重新请求 index.html，升级后旧标签页会一直跑旧代码，
 * 而旧 chunk 已随构建删除 → 用户看到的界面与后端能力不一致（反复"改了没生效"）。
 * 检测到不一致就自动重载一次；用 sessionStorage 打标记避免重建后仍不一致时的无限刷新。
 */
const CURRENT_ENTRY = Array.from(document.scripts).find((s) => s.type === 'module')?.src ?? '';
const RELOAD_KEY = 'opsgate-build-reload';

async function checkBuildFreshness(): Promise<void> {
  if (!CURRENT_ENTRY) return;
  try {
    const res = await fetch(`/?_build=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const m = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html);
    if (!m) return;
    const servedEntry = m[1]!;
    if (servedEntry === new URL(CURRENT_ENTRY).pathname) return;
    // 已重载过一次仍是旧版（CDN/多实例）→ 不再自动刷新，交给用户决定
    if (sessionStorage.getItem(RELOAD_KEY) === servedEntry) return;
    sessionStorage.setItem(RELOAD_KEY, servedEntry);
    window.location.reload();
  } catch {
    // 自检失败不影响使用
  }
}

void checkBuildFreshness();

const qc = new QueryClient();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
