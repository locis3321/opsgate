/**
 * 内置 HTTP 型原生工具回归（Zabbix / RocketMQ / Nacos）。
 *
 * 重点保护两件事：
 *  1. **只读边界**：Zabbix 的 API 方法白名单必须挡住写操作（create/update/delete）。
 *     这是沿用旧版 opsgate `_ALLOWED_BRIDGE_METHODS` 的安全约束，不是可选配置。
 *  2. **工具注册**：三个品类的原子工具能被 barrel 自动加载，且满足 R1–R8 命名/描述规范。
 */
import { describe, expect, it } from 'vitest';
import { loadNativeTools } from './tools/index.js';
import { ZABBIX_READ_METHODS } from './tools/zabbix/_shared.js';

describe('Zabbix 只读白名单', () => {
  it('白名单只含 .get / apiinfo.version，不含任何写方法', () => {
    for (const m of ZABBIX_READ_METHODS) {
      const ok = m === 'apiinfo.version' || m.endsWith('.get');
      expect(ok, `${m} 不是只读方法`).toBe(true);
    }
  });

  it('典型写方法不在白名单内', () => {
    const writes = ['host.create', 'host.update', 'host.delete', 'item.update', 'problem.acknowledge', 'trigger.update'];
    for (const w of writes) {
      expect((ZABBIX_READ_METHODS as readonly string[]).includes(w), `${w} 不应被允许`).toBe(false);
    }
  });
});

describe('三个品类的原子工具注册', () => {
  it('zabbix / rocketmq / nacos 的工具都被自动加载且带正确 category 前缀', async () => {
    const tools = await loadNativeTools();
    for (const cat of ['zabbix', 'rocketmq', 'nacos']) {
      const inCat = tools.filter((t) => t.category === cat);
      expect(inCat.length, `${cat} 应至少有一个工具`).toBeGreaterThan(0);
      for (const t of inCat) {
        // R1：工具名必须 {category}_ 前缀
        expect(t.name.startsWith(`${cat}_`), `${t.name} 缺少 ${cat}_ 前缀`).toBe(true);
      }
    }
  });

  it('全部新工具声明 read 风险等级（无写操作）', async () => {
    const tools = await loadNativeTools();
    const newOnes = tools.filter((t) => ['zabbix', 'rocketmq', 'nacos'].includes(t.category));
    for (const t of newOnes) {
      expect(t.risk, `${t.name} 应为 read`).toBe('read');
    }
  });

  it('全部新工具的描述含 Use when 与 Required（R4）且不超 200 字（R6）', async () => {
    const tools = await loadNativeTools();
    const newOnes = tools.filter((t) => ['zabbix', 'rocketmq', 'nacos'].includes(t.category));
    for (const t of newOnes) {
      expect(t.description, `${t.name} 缺 Use when`).toContain('Use when:');
      expect(t.description, `${t.name} 缺 Required`).toContain('Required:');
      expect(t.description.length, `${t.name} 描述超长`).toBeLessThanOrEqual(200);
    }
  });
});
