import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * 并发上限（2026-11-20，用户要求）。
     *
     * 默认按 CPU 核数铺满 worker（本机 16 核 → 16 个），整套集成测试同时起十几个
     * better-sqlite3 + Fastify 实例，会把这台开发机 CPU 打满、影响用户其它工作。
     * 集成测试以 IO/等待为主，4 个 worker 足以饱和；代价只是整套跑完略慢。
     *
     * 另有已知副作用需要知悉：并发过高时 mcp.integration 的 AC-33/34 与
     * t2-t3 的 verify 会超时（隔离跑均通过）。降并发同时也压掉了这类噪声。
     */
    maxWorkers: 4,
    minWorkers: 1,
    fileParallelism: true,
  },
});
