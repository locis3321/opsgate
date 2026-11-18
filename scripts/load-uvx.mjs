#!/usr/bin/env node
/**
 * 实测任务 F（U-2/U-3 校准）：uvx 实例真实 RSS / 冷启动耗时 / 真实 tools/list 工具数。
 * 以生产同形 StdioClientTransport 拉起 `uvx --from mysql-mcp-server mysql_mcp_server`。
 * 用法：node scripts/load-uvx.mjs [--count 2]
 * 网络：需 PyPI 可达（uvx 首次下载）。
 */
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const count = Number(args[args.indexOf('--count') + 1] ?? 2);

function rssMB() {
  return process.memoryUsage().rss / 1024 / 1024;
}

const results = [];
const base = rssMB();

for (let i = 0; i < count; i++) {
  const t0 = performance.now();
  const before = rssMB();
  const c = new Client({ name: 'opsgate-f-probe', version: '0' });
  const t = new StdioClientTransport({
    command: 'uvx',
    args: ['--from', 'mysql-mcp-server', 'mysql_mcp_server'],
    stderr: 'pipe',
  });
  try {
    await c.connect(t);
    const readyMs = Math.round(performance.now() - t0);
    const tools = await c.listTools();
    const after = rssMB();
    // SDK close 只杀父进程；uv/python 孙进程需 tree-kill（Windows 用 taskkill /T 整树）
    try {
      const pid = t._process?.pid;
      if (pid) execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch { /* 已退出 */ }
    results.push({
      instance: i + 1,
      coldStartMs: readyMs,
      rssDeltaMB: Number((after - before).toFixed(1)),
      toolCount: tools.tools.length,
    });
    void c.close();
  } catch (err) {
    results.push({ instance: i + 1, error: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((r) => setTimeout(r, 1_000)); // 让子进程退出/回收
}

console.log('=== 实测 F 结果（uvx mysql_mcp_server）===');
console.log(JSON.stringify({ baseRssMB: Number(base.toFixed(1)), results }, null, 2));
