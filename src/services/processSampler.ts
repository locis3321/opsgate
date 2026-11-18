/**
 * 实例进程资源采样（2026-11-18 T4）：主进程快照，不含进程树。
 *
 * 只做一件事：给定 pid 列表，返回每个 pid 的 CPU% 与 RSS。采样失败一律返回 null，
 * 前端显示「—」——运行时观测值的"假 0"会让人误判成实例空闲，比缺值更危险。
 *
 * CPU% 需要两次采样求差（累计 CPU 时间 / 间隔）；没有上一采样点时返回 null，
 * 不做"自进程启动以来的平均占用"这类换口径的替代值。
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export interface ProcSample {
  cpuPercent: number | null;
  rssBytes: number | null;
}

/** pid → 上一次累计 CPU 秒数与采样时刻，用于换算区间占用率 */
const lastCpu = new Map<number, { cpuSec: number; at: number }>();

/**
 * PowerShell 冷启动在空载时约 0.6s，但并发负载下会明显变慢；3s 会把"机器忙"误判成
 * "进程采不到"。放宽到 8s——本端点只有管理员每 5s 轮询一次，同一查询不会并发叠加，
 * 超时上限放宽不会造成进程堆积。
 */
const PS_TIMEOUT_MS = 8000;

interface PsRow { Id?: number; CPU?: number | null; WorkingSet64?: number | null }

function readWindows(pids: number[]): Promise<Map<number, { cpuSec: number; rssBytes: number | null }>> {
  const out = new Map<number, { cpuSec: number; rssBytes: number | null }>();
  if (pids.length === 0) return Promise.resolve(out);
  const script =
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ` +
    'Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve(out);
        let parsed: PsRow | PsRow[];
        try {
          parsed = JSON.parse(stdout) as PsRow | PsRow[];
        } catch {
          return resolve(out);
        }
        for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
          // CPU 为 null 时进程刚启动还无统计 —— 当作"无采样点"，由调用方给 null
          if (typeof row.Id !== 'number' || typeof row.CPU !== 'number') continue;
          out.set(row.Id, { cpuSec: row.CPU, rssBytes: typeof row.WorkingSet64 === 'number' ? row.WorkingSet64 : null });
        }
        resolve(out);
      },
    );
  });
}

async function readPosix(pid: number): Promise<{ cpuSec: number; rssBytes: number | null } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // comm 可能含空格与括号，必须从最后一个 ')' 之后切分再数字段
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = Number(tail[11]);
    const stime = Number(tail[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    let rssBytes: number | null = null;
    try {
      const statm = await readFile(`/proc/${pid}/statm`, 'utf8');
      const pages = Number(statm.split(' ')[1]);
      if (Number.isFinite(pages)) rssBytes = pages * 4096;
    } catch {
      rssBytes = null;
    }
    // Linux 的 CLK_TCK 在主流发行版与容器基础镜像中固定为 100
    return { cpuSec: (utime + stime) / 100, rssBytes };
  } catch {
    return null;
  }
}

async function readAll(pids: number[]): Promise<Map<number, { cpuSec: number; rssBytes: number | null }>> {
  if (process.platform === 'win32') return readWindows(pids);
  const out = new Map<number, { cpuSec: number; rssBytes: number | null }>();
  await Promise.all(
    pids.map(async (pid) => {
      const r = await readPosix(pid);
      if (r) out.set(pid, r);
    }),
  );
  return out;
}

/** 批量采样。任一 pid 采不到 → 该 pid 的结果字段为 null（不抛错，不影响其它 pid） */
export async function sampleProcesses(pids: number[]): Promise<Map<number, ProcSample>> {
  const valid = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  const result = new Map<number, ProcSample>();
  if (valid.length === 0) return result;
  const now = Date.now();
  const raw = await readAll(valid);
  for (const pid of valid) {
    const cur = raw.get(pid);
    if (!cur) {
      lastCpu.delete(pid);
      result.set(pid, { cpuPercent: null, rssBytes: null });
      continue;
    }
    const prev = lastCpu.get(pid);
    lastCpu.set(pid, { cpuSec: cur.cpuSec, at: now });
    const elapsed = prev ? (now - prev.at) / 1000 : 0;
    const deltaCpu = prev ? cur.cpuSec - prev.cpuSec : 0;
    const cpuPercent = prev && elapsed > 0 && deltaCpu >= 0
      ? Math.round((deltaCpu / elapsed) * 1000) / 10
      : null;
    result.set(pid, { cpuPercent, rssBytes: cur.rssBytes });
  }
  // 已退出的 pid 不留在基线表里（pid 会被系统复用）
  for (const pid of [...lastCpu.keys()]) if (!valid.includes(pid)) lastCpu.delete(pid);
  return result;
}

/** 仅供测试重置内部基线 */
export function resetProcessSampler(): void {
  lastCpu.clear();
}
