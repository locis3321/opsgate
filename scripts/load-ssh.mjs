#!/usr/bin/env node
/**
 * 实测任务 N（U-1 / facts §4.2 校准）：300 台全活跃下 ssh2 连接池 RSS 与并发稳定性。
 * 用法：node scripts/load-ssh.mjs [--connections 300] [--concurrency 25]
 * 依赖：Docker sshd 容器（test/docker/sshd）监听 127.0.0.1:2222，用户 ops/ops-pass-123。
 * 输出：每连接平均 RSS 增量（MB）、建立耗时（ms）、峰值 RSS（MB）。
 */
import { Client } from 'ssh2';

const args = process.argv.slice(2);
const connTotal = Number(args[args.indexOf('--connections') + 1] ?? 300);
const concurrency = Number(args[args.indexOf('--concurrency') + 1] ?? 25);

const HOST = '127.0.0.1';
const PORT = Number(process.env.SSH_PORT ?? 2222);

function rssMB() {
  return process.memoryUsage().rss / 1024 / 1024;
}

const clients = [];
const latencies = [];

async function connectOne() {
  const t0 = performance.now();
  const c = new Client();
  await new Promise((resolve, reject) => {
    c.once('ready', resolve);
    c.once('error', reject);
    c.connect({
      host: HOST,
      port: PORT,
      username: 'ops',
      password: 'ops-pass-123',
      readyTimeout: 10_000,
      hostVerifier: (_key, verify) => verify(true), // 负载测试：接受未知指纹（连接管理是对象，与生产连接器无关）
    });
  });
  latencies.push(performance.now() - t0);
  clients.push(c);
}

const base = rssMB();
const startedAt = Date.now();
let done = 0;
while (done < connTotal) {
  const n = Math.min(concurrency, connTotal - done);
  const batch = [];
  for (let i = 0; i < n; i++) batch.push(connectOne());
  await Promise.all(batch);
  done += n;
  if (done % 50 === 0) {
    console.log(`connected ${done}/${connTotal} rss=${rssMB().toFixed(1)}MB`);
  }
}
const elapsed = Date.now() - startedAt;
const peak = rssMB();
const deltaPerConn = (peak - base) / connTotal;
const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

console.log('=== 实测 N 结果 ===');
console.log(JSON.stringify(
  {
    connections: connTotal,
    concurrency,
    baseRssMB: Number(base.toFixed(1)),
    peakRssMB: Number(peak.toFixed(1)),
    rssDeltaPerConnMB: Number(deltaPerConn.toFixed(3)),
    projected300MB: Number(deltaPerConn.toFixed(3) * 300).toFixed(1),
    avgConnectMs: Number(avgLatency.toFixed(0)),
    connectAllMs: elapsed,
  },
  null,
  2,
));

for (const c of clients) c.end();
process.exit(0);
