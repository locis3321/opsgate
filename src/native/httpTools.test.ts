/**
 * 内置 HTTP 型原生工具回归（Zabbix / RocketMQ / Nacos）。
 *
 * 重点保护三件事：
 *  1. **安全边界**：Zabbix 的只读白名单必须挡住写方法；永久黑名单（账号/权限/脚本）
 *     必须挡住 raw 入口；两者互不替代。
 *  2. **风险分级**：写操作必须声明 write/destructive，不能一律 read。
 *  3. **工具注册**：三个品类的原子工具能被 barrel 自动加载，且满足 R1–R8 命名/描述规范。
 */
import { describe, expect, it } from 'vitest';
import { loadNativeTools } from './tools/index.js';
import { ZABBIX_DENIED_METHODS, ZABBIX_READ_METHODS } from './tools/zabbix/_shared.js';

describe('Zabbix 只读白名单', () => {
  it('白名单只含 .get / apiinfo.version / acknowledge.get，不含任何写方法', () => {
    for (const m of ZABBIX_READ_METHODS) {
      const ok = m === 'apiinfo.version' || m.endsWith('.get');
      expect(ok, `${m} 不是只读方法`).toBe(true);
    }
  });

  it('典型写方法不在只读白名单内', () => {
    const writes = ['host.create', 'host.update', 'host.delete', 'item.update', 'event.acknowledge', 'trigger.update'];
    for (const w of writes) {
      expect((ZABBIX_READ_METHODS as readonly string[]).includes(w), `${w} 不应被允许`).toBe(false);
    }
  });
});

describe('Zabbix 永久黑名单（raw 入口同样不可用）', () => {
  it('账号 / 权限 / 脚本类方法被永久拒绝', () => {
    const mustDeny = ['user.update', 'user.login', 'script.execute', 'role.update', 'token.create', 'configuration.import'];
    for (const m of mustDeny) {
      expect((ZABBIX_DENIED_METHODS as readonly string[]).includes(m), `${m} 必须在黑名单内`).toBe(true);
    }
  });

  it('黑名单不含只读方法与常用运维写方法（避免误伤）', () => {
    const mustAllow = ['host.get', 'problem.get', 'host.update', 'event.acknowledge', 'maintenance.create'];
    for (const m of mustAllow) {
      expect((ZABBIX_DENIED_METHODS as readonly string[]).includes(m), `${m} 不应在黑名单内`).toBe(false);
    }
  });

  it('只读白名单与黑名单无交集（两层闸门不互相覆盖）', () => {
    const deny = new Set<string>(ZABBIX_DENIED_METHODS);
    for (const m of ZABBIX_READ_METHODS) {
      expect(deny.has(m), `${m} 同时出现在白名单与黑名单`).toBe(false);
    }
  });
});

describe('三个品类的原子工具注册', () => {
  it('zabbix / rocketmq / nacos / redis / kafka 的工具都被自动加载且带正确 category 前缀', async () => {
    const tools = await loadNativeTools();
    for (const cat of ['zabbix', 'rocketmq', 'nacos', 'redis', 'kafka']) {
      const inCat = tools.filter((t) => t.category === cat);
      expect(inCat.length, `${cat} 应至少有一个工具`).toBeGreaterThan(0);
      for (const t of inCat) {
        // R1：工具名必须 {category}_ 前缀
        expect(t.name.startsWith(`${cat}_`), `${t.name} 缺少 ${cat}_ 前缀`).toBe(true);
      }
    }
  });

  it('写操作必须声明 write 或 destructive，不得伪装成 read', async () => {
    const tools = await loadNativeTools();
    // 已知的写/破坏性工具（2026-11-23 扩容）
    const writes = [
      'nacos_config_publish',
      'nacos_instance_update',
      'rocketmq_topic_save',
      'rocketmq_topic_delete',
      'rocketmq_consumer_reset',
      'zabbix_api_call',
      'zabbix_event_acknowledge',
      'zabbix_maintenance_create',
      'zabbix_host_update',
      'redis_command',
      'kafka_admin',
    ];
    for (const name of writes) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} 未加载`).toBeDefined();
      expect(['write', 'destructive'], `${name} 风险等级应为 write/destructive`).toContain(t!.risk);
    }
  });

  it('只读工具必须声明 read（防止把 destructive 当默认）', async () => {
    const tools = await loadNativeTools();
    const reads = [
      'nacos_config_get', 'nacos_health', 'nacos_service_list',
      'rocketmq_cluster_info', 'rocketmq_consumer_progress', 'rocketmq_topic_list',
      'zabbix_events_list', 'zabbix_host_search', 'zabbix_problems_list',
      'redis_info', 'redis_slowlog',
      'kafka_topic_list', 'kafka_consumer_lag',
    ];
    for (const name of reads) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} 未加载`).toBeDefined();
      expect(t!.risk, `${name} 应为 read`).toBe('read');
    }
  });

  it('destructive 工具的描述必须标注 destructive 且要求确认（R8）', async () => {
    const tools = await loadNativeTools();
    const destructive = tools.filter((t) => t.risk === 'destructive');
    expect(destructive.length, '应存在 destructive 工具').toBeGreaterThan(0);
    for (const t of destructive) {
      expect(t.description, `${t.name} 缺 destructive 标注`).toMatch(/destructive/i);
      expect(t.description, `${t.name} 缺确认要求`).toContain('确认');
    }
  });

  it('全部新工具的描述含 Use when 与 Required（R4）且不超 200 字（R6）', async () => {
    const tools = await loadNativeTools();
    const newOnes = tools.filter((t) => ['zabbix', 'rocketmq', 'nacos', 'redis', 'kafka'].includes(t.category));
    for (const t of newOnes) {
      expect(t.description, `${t.name} 缺 Use when`).toContain('Use when:');
      expect(t.description, `${t.name} 缺 Required`).toContain('Required:');
      expect(t.description.length, `${t.name} 描述超长`).toBeLessThanOrEqual(200);
    }
  });
});

describe('raw 工具的可审计性（guard_rules arg 维度能命中）', () => {
  it('redis_command / kafka_admin / zabbix_api_call 的动作参数都是顶层扁平字符串', async () => {
    const tools = await loadNativeTools();
    const cases: Array<[string, string]> = [
      ['redis_command', 'command'],
      ['kafka_admin', 'action'],
      ['zabbix_api_call', 'method'],
    ];
    for (const [toolName, paramName] of cases) {
      const t = tools.find((x) => x.name === toolName);
      expect(t, `${toolName} 未加载`).toBeDefined();
      const props = (t!.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }> }).properties ?? {};
      const prop = props[paramName];
      expect(prop, `${toolName} 缺少 ${paramName} 参数`).toBeDefined();
      // 必须是 string（不是 object/array），否则 guard_rules 的 arg 维度扫不到值
      expect(prop!.type, `${toolName}.${paramName} 必须是 string（顶层扁平）`).toBe('string');
    }
  });

  it('删除/重置类动作在枚举内且要求 confirm（写错动作名不会静默通过）', async () => {
    const tools = await loadNativeTools();
    const kafka = tools.find((x) => x.name === 'kafka_admin')!;
    const props = (kafka.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    const actionEnum = props.action?.enum ?? [];
    expect(actionEnum).toContain('delete_topic');
    expect(actionEnum).toContain('reset_offsets');
    const confirm = props.confirm_dangerous;
    expect(confirm, 'kafka_admin 必须有 confirm_dangerous 参数').toBeDefined();
  });
});
