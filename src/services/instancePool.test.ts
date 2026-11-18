/**
 * T6 实例池测试：真实 spawn mock stdio MCP 进程（无网络依赖）。
 * 覆盖：拉起/键复用/凭证指纹新键(AC-23)/idle 回收(AC-11)/预算拦截(-32002)/队列 429/预热/失效。
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InstancePool,
  PoolBusyError,
  PoolTooManyRequestsError,
  type InstancePoolConfig,
} from './instancePool.js';
import { buildInstanceKey, buildPlan, type PlanSource } from './instancePlan.js';
import type { ResolvedCredential } from './credentials.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/mock-mcp-server.mjs', import.meta.url));

function makePool(overrides: Partial<InstancePoolConfig> = {}): InstancePool {
  return new InstancePool({
    globalBudget: 8,
    globalWeightBudget: 24,
    maxPerAsset: 2,
    queuePerUser: 1,
    globalConcurrency: 4,
    idleTtlMs: 500,
    queueTimeoutMs: 500,
    degradeWaitMs: 3000,
    prewarmConcurrency: 2,
    prewarmBackoffMs: 600_000,
    runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-runtime-')),
    ...overrides,
  });
}

function planFor(serverId: string, configHash: string, credUpdatedAt = 1): { plan: ReturnType<typeof buildPlan>; source: PlanSource } {
  const source: PlanSource = {
    id: serverId,
    configHash,
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    credentialSlots: [],
  };
  const resolved: ResolvedCredential[] = [
    { slotName: 'AUTH', value: 'v', credentialId: 'cred-1', updatedAtMs: credUpdatedAt },
  ];
  return { plan: buildPlan(source, resolved, mkdtempSync(path.join(tmpdir(), 'opsgate-creds-'))), source };
}

let pool: InstancePool;

beforeEach(() => {
  pool = makePool();
});

afterEach(async () => {
  await pool.releaseAll();
});

describe('T6 实例池（§5.4）热生效（ADR-024）', { timeout: 15_000 }, () => {
  it('settingsSrc 提供后：global_budget 逐次读取（改值即作用于 gate，不持启动快照）', async () => {
    const src = {
      get: <T>(key: string): T => {
        const map: Record<string, unknown> = {
          'instance_pool.global_budget': 1,
          'instance_pool.global_weight_budget': 3,
          'instance_pool.max_per_asset': 2,
          'instance_pool.queue_per_user': 8,
          'instance_pool.idle_ttl_sec': 60,
          'instance_pool.queue_timeout_sec': 1,
          'instance_pool.degrade_wait_sec': 3,
        };
        return map[key] as T;
      },
    };
    const hot = new InstancePool({
      globalBudget: 8, globalWeightBudget: 24, maxPerAsset: 2, queuePerUser: 8, globalConcurrency: 4,
      idleTtlMs: 60_000, queueTimeoutMs: 500, degradeWaitMs: 3_000, prewarmConcurrency: 1, prewarmBackoffMs: 600_000,
      runtimeCredsDir: mkdtempSync(path.join(tmpdir(), 'opsgate-rt-')),
    }, undefined, src);
    const a = planFor('hot-a', 'c1').plan;
    const b = planFor('hot-b', 'c1').plan;
    const h1 = await hot.acquire(a, 'u-1');
    // 预算=1（src 返回）：第二个不同资产 acquire 应排队超时 → PoolBusyError
    await expect(hot.acquire(b, 'u-1')).rejects.toThrow(PoolBusyError);
    await h1.release();
    await hot.releaseAll();
  });
});

describe('T6 实例池（§5.4）', { timeout: 15_000 }, () => {
  it('拉起 → ready → listTools 返回 echo（真实子进程）', async () => {
    const { plan } = planFor('srv-m-1', 'c1');
    const h = await pool.acquire(plan, 'u-1');
    const tools = await h.client.listTools();
    expect(tools.tools.some((t) => t.name === 'echo')).toBe(true);
    expect(pool.stats().instances).toBe(1);
    await h.release();
  });

  it('AC-23/键复用：同键两次 acquire 复用同一实例；凭证 updatedAt 变化 → 新键新实例', async () => {
    const longTtl = makePool({ idleTtlMs: 60_000 });
    const a = planFor('srv-m-2', 'c1', 100).plan;
    const h1 = await longTtl.acquire(a, 'u-1');
    const h2 = await longTtl.acquire(a, 'u-1');
    expect(h1.key).toBe(h2.key);
    expect(longTtl.stats().instances).toBe(1);
    await h1.release();
    await h2.release();

    // 凭证轮换：updatedAt 变 → 新键
    const b = planFor('srv-m-2', 'c1', 200).plan;
    expect(b.instanceKey).not.toBe(a.instanceKey);
    const h3 = await longTtl.acquire(b, 'u-1');
    expect(h3.key).toBe(b.instanceKey);
    expect(longTtl.stats().instances).toBe(2); // 旧键 idle 中 + 新键
    await h3.release();
    await longTtl.releaseAll();
  });

  it('AC-11 idle 回收：release 后 idle TTL 到期回收，稳态实例数回落', async () => {
    const { plan } = planFor('srv-m-3', 'c1');
    const h = await pool.acquire(plan, 'u-1');
    expect(pool.stats().instances).toBe(1);
    await h.release();
    await new Promise((r) => setTimeout(r, 900));
    expect(pool.stats().instances).toBe(0);
  });

  it('预算不足排队 → 15s(测试 500ms) PoolBusyError(-32002)', async () => {
    const tight = makePool({ globalBudget: 1, globalWeightBudget: 3, queueTimeoutMs: 400, idleTtlMs: 60_000 });
    const a = planFor('srv-m-4a', 'c1').plan;
    const b = planFor('srv-m-4b', 'c1').plan;
    const h1 = await tight.acquire(a, 'u-1');
    await expect(tight.acquire(b, 'u-1')).rejects.toThrow(PoolBusyError);
    await h1.release();
    await tight.releaseAll();
  });

  it('单用户排队超限 → 429 PoolTooManyRequestsError', async () => {
    // queuePerUser=1：第一个 acquire 在 spawn 窗口内占用队列，第二个并发进入即超限
    const q1 = makePool({ queuePerUser: 1, idleTtlMs: 60_000 });
    const a = planFor('srv-m-5', 'c1').plan;
    const p1 = q1.acquire(a, 'u-1');
    await expect(q1.acquire(a, 'u-1')).rejects.toThrow(PoolTooManyRequestsError);
    const h = await p1;
    await h.release();
    await q1.releaseAll();
  });

  it('预热：拉起→listTools→立即关闭；10min 退避内重复预热返回 false', async () => {
    const { plan } = planFor('srv-m-6', 'c1');
    const first = await pool.prewarm(plan);
    expect(first).toBe(true);
    expect(pool.stats().instances).toBe(0); // 预热即关
    expect(await pool.prewarm(plan)).toBe(false); // 退避
  });

  it('invalidate：同键实例立即关闭（AC-23 轮换联动）', async () => {
    const { plan } = planFor('srv-m-7', 'c1');
    const h = await pool.acquire(plan, 'u-1');
    expect(pool.stats().instances).toBe(1);
    pool.invalidate(plan.instanceKey);
    expect(pool.stats().instances).toBe(0);
    await h.release(); // double-release 安全
  });

  it('并发降级：实例被长调用占用超过降级阈值 → 再 acquire 开副本（maxPerAsset=2）', async () => {
    const multi = makePool({ maxPerAsset: 2, degradeWaitMs: 300, idleTtlMs: 60_000 });
    const { plan } = planFor('srv-m-8', 'c1');
    const h1 = await multi.acquire(plan, 'u-1');
    // 短时并发：仍在降级窗口内 → 复用同一实例（AC-11 稳态不随用户数增长）
    const hMid = await multi.acquire(plan, 'u-1');
    expect(multi.stats().instances).toBe(1);
    await hMid.release();
    // 首调用已持续超过 degrade_wait_sec → 再进来开副本，避免被长调用堵住
    await new Promise((r) => setTimeout(r, 400));
    const h2 = await multi.acquire(plan, 'u-1');
    expect(multi.stats().instances).toBe(2);
    await h1.release();
    await h2.release();
    await multi.releaseAll();
  });

  it('degrade_wait_sec 真实生效：阈值内复用，超过阈值才开副本', async () => {
    const { plan } = planFor('srv-m-9', 'c1');

    const eager = makePool({ maxPerAsset: 2, degradeWaitMs: 150, idleTtlMs: 60_000 });
    const a1 = await eager.acquire(plan, 'u-1');
    await new Promise((r) => setTimeout(r, 400)); // 已超过 150ms 阈值
    const a2 = await eager.acquire(plan, 'u-1');
    expect(eager.stats().instances).toBe(2);
    await a1.release();
    await a2.release();
    await eager.releaseAll();

    const lazy = makePool({ maxPerAsset: 2, degradeWaitMs: 5000, idleTtlMs: 60_000 });
    const b1 = await lazy.acquire(plan, 'u-1');
    await new Promise((r) => setTimeout(r, 400)); // 未达 5000ms 阈值
    const b2 = await lazy.acquire(plan, 'u-1');
    expect(lazy.stats().instances).toBe(1);
    await b1.release();
    await b2.release();
    await lazy.releaseAll();
  });

  it('degrade_wait 窗口内实例释放 → 复用而不是开副本', async () => {
    const multi = makePool({ maxPerAsset: 2, degradeWaitMs: 1500, idleTtlMs: 60_000 });
    const { plan } = planFor('srv-m-10', 'c1');
    const h1 = await multi.acquire(plan, 'u-1');
    // 200ms 后释放：在等待窗口内，应复用同一实例而不是开第二份
    setTimeout(() => { void h1.release(); }, 200);
    const h2 = await multi.acquire(plan, 'u-1');
    expect(multi.stats().instances).toBe(1);
    expect(h2.key).toBe(h1.key);
    await h2.release();
    await multi.releaseAll();
  });

  it('maxPerAsset=1 时不做降级：等满 degrade_wait 后仍排队', async () => {
    const multi = makePool({ maxPerAsset: 1, degradeWaitMs: 300, queueTimeoutMs: 2000, idleTtlMs: 60_000 });
    const { plan } = planFor('srv-m-11', 'c1');
    const h1 = await multi.acquire(plan, 'u-1');
    const t0 = Date.now();
    const p2 = multi.acquire(plan, 'u-1');
    await new Promise((r) => setTimeout(r, 500));
    await h1.release();
    const h2 = await p2;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    // 没有开副本：始终只有 1 个实例
    expect(multi.stats().instances).toBe(1);
    await h2.release();
    await multi.releaseAll();
  });

  it('closeByEntryKey：按 entryKey 关闭单个实例；未知键返回 false', async () => {
    const multi = makePool({ maxPerAsset: 2, idleTtlMs: 60_000 });
    const { plan } = planFor('srv-m-close', 'c1');
    const h = await multi.acquire(plan, 'u-1');
    const rows = multi.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pid).toBeGreaterThan(0);
    expect(multi.closeByEntryKey(rows[0]!.key)).toBe(true);
    expect(multi.stats().instances).toBe(0);
    expect(multi.closeByEntryKey(rows[0]!.key)).toBe(false);
    await h.release();
    await multi.releaseAll();
  });

  it('buildInstanceKey 稳定且区分资产/配置/凭证', () => {    const k1 = buildInstanceKey('s1', 'c1', [{ slotName: 'A', credentialId: 'c', updatedAtMs: 1 }]);
    expect(k1).toBe(buildInstanceKey('s1', 'c1', [{ slotName: 'A', credentialId: 'c', updatedAtMs: 1 }]));
    expect(k1).not.toBe(buildInstanceKey('s2', 'c1', [{ slotName: 'A', credentialId: 'c', updatedAtMs: 1 }]));
    expect(k1).not.toBe(buildInstanceKey('s1', 'c2', [{ slotName: 'A', credentialId: 'c', updatedAtMs: 1 }]));
    expect(k1).not.toBe(buildInstanceKey('s1', 'c1', [{ slotName: 'A', credentialId: 'c', updatedAtMs: 2 }]));
  });
});

describe('buildPlan 未绑定槽位（2026-11-17 取消必填拦截）', () => {
  const source = (): PlanSource => ({
    id: 'probe-1',
    configHash: 'ch-probe',
    command: 'echo',
    args: ['--flag', '${KUBECONFIG}', '--plain'],
    env: { ES_URL: '${ES_URL}', ES_API_KEY: '${ES_API_KEY}', LITERAL: 'plain' },
    headers: {},
    transport: 'stdio',
    credentialSlots: [
      { target: 'env', name: 'ES_URL', label: '地址', file: false },
      { target: 'env', name: 'ES_API_KEY', label: 'API Key', file: false },
      { target: 'args', name: 'KUBECONFIG', label: 'kubeconfig', file: true },
    ],
  });

  it('未绑定的槽位整条注入项被省略（不留空值，避免下游误判"已提供"）', () => {
    const plan = buildPlan(source(), [], mkdtempSync(path.join(tmpdir(), 'p-')));
    expect(plan.env).toEqual({ LITERAL: 'plain' });
    expect('ES_API_KEY' in plan.env).toBe(false);
    // `${KUBECONFIG}` 那条 arg 整个消失；不含占位符的 `--flag` 原样保留
    expect(plan.args).toEqual(['--flag', '--plain']);
    expect(plan.tempFiles).toEqual([]);
  });

  it('已绑定的槽位照常注入，未绑定的互不影响', () => {
    const resolved = [{ slotName: 'ES_API_KEY', value: 'k-123', credentialId: 'c1', updatedAtMs: 1 }];
    const plan = buildPlan(source(), resolved, mkdtempSync(path.join(tmpdir(), 'p-')));
    expect(plan.env.ES_API_KEY).toBe('k-123');
    // ES_URL 未绑定 → 整条省略；同事先绑的 API Key 不受影响
    expect('ES_URL' in plan.env).toBe(false);
    expect(plan.env.LITERAL).toBe('plain');
  });

  it('嵌入型占位符（Bearer ${TOKEN}）：槽位未绑定 → 整个 header 省略', () => {
    const plan = buildPlan(
      {
        ...source(),
        transport: 'http',
        command: null,
        args: [],
        env: {},
        url: 'https://es.example.com:9200',
        headers: { Authorization: 'Bearer ${ES_API_KEY}', 'X-Static': 'v' },
      },
      [],
      mkdtempSync(path.join(tmpdir(), 'p-')),
    );
    expect(plan.headers).toEqual({ 'X-Static': 'v' });
  });
});
