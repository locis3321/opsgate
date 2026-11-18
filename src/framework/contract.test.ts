/**
 * 契约测试：遍历注册表（真实已加载工具 + mock 注入），三组断言自动生效（AC-51，§5.9.4）。
 * 场景 A：无权/不存在 asset → -32006；场景 B：审计不可用 → -32003 且 execute 未调用；
 * 场景 C：block 命中 → -32004 且 acquire 未调用；场景 D：正向路径 → execute 调用、审计回填。
 * 工具作者无需写用例；新增工具自动被覆盖。
 */
import { describe, expect, it } from 'vitest';
import type { NativeToolDefinition, AssetView } from './types.js';
import {
  dispatchNativeTool,
  type DispatchServices,
  type GuardHit,
} from './dispatch.js';
import { buildToolRegistry } from './registry.js';
import { validateDescription } from './validate.js';
import { loadNativeTools } from '../native/tools/index.js';
import { registerConnector, CONNECTOR_REGISTRY } from '../native/connectors/index.js';
import mockEcho from '../native/tools/host/_mock_echo.js';

const PRINCIPAL = { userId: 'u-1', isAdmin: false };
const ASSET: AssetView = {
  id: 'a-1',
  name: 'web-01',
  category: 'host',
  ownerId: 'u-1',
  executionMode: 'native',
  credentialSlots: [],
  configHash: 'cfg',
};

function makeServices(overrides: Partial<DispatchServices> = {}): {
  services: DispatchServices;
  calls: { execute: number; acquire: number; auditWrite: number; auditFill: number };
} {
  const calls = { execute: 0, acquire: 0, auditWrite: 0, auditFill: 0 };
  const services: DispatchServices = {
    resolveAsset: async () => ASSET,
    canInvoke: async () => true,
    evaluateRules: async () => null,
    writeAuditIntent: async () => {
      calls.auditWrite++;
      return { intentId: 'intent-1' };
    },
    fillAudit: async () => {
      calls.auditFill++;
    },
    resolveCredentials: async () => ({}),
    resolveSlotValues: () => [],
    resolveRefValue: () => null,
    redact: (v) => v,
    truncate: (s) => s.slice(0, 4096),
    normalizeError: (err) => ({ code: -32002, message: err instanceof Error ? err.message : String(err) }),
    outputTruncateBytes: 4096,
    getSetting: <T>(_key: string) => 30 as unknown as T,
    ...overrides,
  };
  return { services, calls };
}

/** 包装 execute 以便观测是否被调用 */
function traced(t: NativeToolDefinition, counter: { n: number }): NativeToolDefinition {
  return { ...t, execute: async (ctx, args) => { counter.n++; return t.execute(ctx, args); } };
}

/** 组装测试注册表：真实加载工具 + mock 注入；connector 用 stub 补位 */
async function buildTestRegistry(): Promise<NativeToolDefinition[]> {
  const tools = [...(await loadNativeTools()), mockEcho];
  for (const t of tools) {
    if (!CONNECTOR_REGISTRY.has(t.connector)) {
      registerConnector({
        type: t.connector,
        // 场景 A/B/C 不会走到 acquire；正向场景由用例替换
        acquire: async () => ({ __stub: true }),
        release: () => undefined,
        invalidate: () => undefined,
        stats: () => ({ active: 0, idle: 0, total: 0 }),
      });
    }
  }
  return tools;
}

describe('契约测试遍历注册表（AC-51）', () => {
  it('注册表含真实工具与 mock 注入，且无启动违规', async () => {
    const tools = await buildTestRegistry();
    const { errors } = buildToolRegistry(tools);
    expect(errors).toEqual([]);
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.id === 'mock.echo')).toBe(true);
  });

  it('场景 A：无权/不存在 asset → -32006，execute 未调用', async () => {
    const tools = await buildTestRegistry();
    const { services } = makeServices({ resolveAsset: async () => null });
    for (const t of tools) {
      const seen = { n: 0 };
      const out = await dispatchNativeTool(traced(t, seen), { asset: 'ghost', message: 'x' }, PRINCIPAL, services);
      expect(out.ok).toBe(false);
      expect(out.code).toBe(-32006);
      expect(out.message).toContain('不存在或无权');
      expect(seen.n).toBe(0);
    }
  });

  it('场景 B：审计不可用 → -32003，execute 未调用', async () => {
    const tools = await buildTestRegistry();
    const { services } = makeServices({
      writeAuditIntent: async () => {
        throw new Error('audit down');
      },
    });
    for (const t of tools) {
      const seen = { n: 0 };
      const out = await dispatchNativeTool(traced(t, seen), { asset: 'a-1', message: 'x' }, PRINCIPAL, services);
      expect(out.ok).toBe(false);
      expect(out.code).toBe(-32003);
      expect(seen.n).toBe(0);
    }
  });

  it('场景 C：block 命中 → -32004（含 ruleId/ruleName，不含 pattern），execute 未调用', async () => {
    const tools = await buildTestRegistry();
    const { services, calls } = makeServices({
      evaluateRules: async (): Promise<GuardHit> => ({
        kind: 'block',
        ruleId: 'gr-block-rce',
        ruleName: '命令注入 RCE 特征',
      }),
    });
    for (const t of tools) {
      const seen = { n: 0 };
      const out = await dispatchNativeTool(traced(t, seen), { asset: 'a-1', message: 'x' }, PRINCIPAL, services);
      expect(out.ok).toBe(false);
      expect(out.code).toBe(-32004);
      expect(out.rule?.ruleId).toBe('gr-block-rce');
      expect(JSON.stringify(out.rule)).not.toContain('pattern');
      expect(seen.n).toBe(0);
      // block 命中仍先写 intent（status=blocked，AC-18）
      expect(calls.auditWrite).toBeGreaterThan(0);
    }
  });

  it('场景 D：正向路径 → execute 调用、审计回填、输出返回', async () => {
    const tools = await buildTestRegistry();
    const { services, calls } = makeServices();
    const tool = tools.find((t) => t.id === 'mock.echo')!;
    const seen = { n: 0 };
    const out = await dispatchNativeTool(traced(tool, seen), { asset: 'a-1', message: 'hello' }, PRINCIPAL, services);
    expect(out.ok).toBe(true);
    expect(seen.n).toBe(1);
    expect(out.data).toMatchObject({ content: { echo: 'hello', host: 'web-01' } });
    expect(calls.auditFill).toBeGreaterThan(0);
  });
});

describe('R1–R8 描述规范校验器', () => {
  it('mock 工具通过全部校验', () => {
    expect(validateDescription(mockEcho)).toEqual([]);
  });

  it('违规工具被逐项指出（前缀/R3/R4/R6/R7/R8）', () => {
    const bad: NativeToolDefinition = {
      id: 'x.y',
      category: 'host',
      connector: 'mock',
      risk: 'destructive',
      audit: {},
      name: 'y',
      description: 'x'.repeat(210),
      inputSchema: {
        type: 'object',
        properties: { p: { type: 'string' } },
      },
      async execute() {
        return { content: {} };
      },
    };
    const errors = validateDescription(bad);
    expect(errors.join('\n')).toContain('R1');
    expect(errors.join('\n')).toContain('R3');
    expect(errors.join('\n')).toContain('R4');
    expect(errors.join('\n')).toContain('R6');
    expect(errors.join('\n')).toContain('R7');
    expect(errors.join('\n')).toContain('R8');
  });
});

describe('注册表启动 fail-fast（§5.9.4，AC-52）', () => {
  it('id 重复 → 违规', () => {
    const { errors } = buildToolRegistry([mockEcho, { ...mockEcho }]);
    expect(errors.some((e) => e.includes('id 重复'))).toBe(true);
  });

  it('声明不存在的 connector → 违规', () => {
    const { errors } = buildToolRegistry([{ ...mockEcho, connector: 'nope' }]);
    expect(errors.some((e) => e.includes('connector'))).toBe(true);
  });

  it('与派生工具同名 → 违规（原生优先原则）', () => {
    const { errors } = buildToolRegistry([mockEcho], ['host_mock_echo']);
    expect(errors.some((e) => e.includes('派生工具同名'))).toBe(true);
  });
});
