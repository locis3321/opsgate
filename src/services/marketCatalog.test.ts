/**
 * T11 单元测试：槽位自动识别（AC-63，与 SLOT_PLACEHOLDER_RE 同源）/ 目录版本固化（AC-62）/ 展开与注入。
 */
import { describe, expect, it } from 'vitest';
import { detectSlots, expandConfig, injectSlots, loadCatalog, type CatalogEntry } from './marketCatalog.js';

const entry: CatalogEntry = {
  key: 't-mysql',
  name: 't-mysql',
  displayName: 'T MySQL',
  description: 'test',
  repository: 'https://example.invalid',
  categories: ['mysql'],
  tags: [],
  runtime: 'npm',
  slotLabels: { MYSQL_PASSWORD: '密码' },
  installations: {
    npm: {
      command: 'npx',
      args: ['-y', 't@1.0.0', '--host', '${host}'],
      env: { MYSQL_HOST: '${host}', MYSQL_PASSWORD: '${password}', MYSQL_SSH_KEY: '${key_file}', PLAIN: 'x' },
    },
  },
};

describe('market 槽位识别（AC-63，SLOT_PLACEHOLDER_RE 同源）', () => {
  it('env 占位符全覆盖 + 敏感键 + file 推断 + label 回落', () => {
    const slots = detectSlots(entry);
    expect(slots.map((s) => s.name)).toEqual(expect.arrayContaining(['host', 'password', 'key_file']));
    const envHost = slots.find((s) => s.name === 'host' && s.target === 'env')!;
    expect(slots.find((s) => s.name === 'password')!).toMatchObject({ sensitive: true, target: 'env', label: '密码' });
    expect(slots.find((s) => s.name === 'key_file')!).toMatchObject({ file: true }); // 敏感判定按 facts 契约正则（key 非敏感词）
    expect(envHost).toMatchObject({ target: 'env', label: '主机地址' });
  });

  it('args 里的占位符同样识别；同名槽位只保留首次出现（槽位名在资产内唯一）', () => {
    const slots = detectSlots(entry);
    // ${host} 同时出现在 env 与 args：只保留一条（注入按名替换全部出现处）
    expect(slots.filter((s) => s.name === 'host')).toHaveLength(1);
    expect(slots.find((s) => s.name === 'host')!.target).toBe('env');
    // args 独有的占位符仍能被识别
    const argsOnly = detectSlots({
      ...entry,
      installations: { npm: { command: 'npx', args: ['-y', 't@1.0.0', '--token', '${only_in_args}'], env: {} } },
    });
    expect(argsOnly.some((s) => s.name === 'only_in_args' && s.target === 'args')).toBe(true);
  });

  it('非占位符键不生成槽位', () => {
    const slots = detectSlots(entry);
    expect(slots.some((s) => s.name === 'PLAIN')).toBe(false);
  });
});

describe('目录数据（AC-62）', () => {
  it('全部条目 command 不含裸版本漂移（含显式 @x.y.z / ==x.y.z），key 唯一', () => {
    const entries = loadCatalog();
    const keys = new Set(entries.map((e) => e.key));
    expect(keys.size).toBe(entries.length);
    for (const e of entries) {
      const inst = e.installations[e.runtime]!;
      // 原生条目（网关内建 HTTP 工具）与 HTTP/SSE 型条目都没有本地包可固定版本，豁免
      if (e.executionMode === 'native' || inst.url) continue;
      const pinned = (inst.args ?? []).some((a) => /@\d+\.\d+\.\d+$/.test(a) || /==\d+\.\d+\.\d+$/.test(a));
      expect(pinned).toBe(true); // 每个本地执行型条目至少一个 args 携带显式版本（AC-62：严禁裸 -y pkg）
    }
  });
  it('目录条目数（AC-62：≥12）——2026-10-21 实测批次 13 条', () => {
    expect(loadCatalog().length).toBeGreaterThanOrEqual(12);
  });
  it('内置目录 = 管理员整理后的 16 条（2026-11-19 固化，防止已删条目被重新种回）', () => {
    // 背景：管理员在管理端删掉 7 条（fetch/time/playwright/everything/filesystem/memory/
    // sequential-thinking）并新增 3 条（elasticsearch/minio×2）。种子文件若不同步，
    // 新环境首启会把删掉的重新种进去。此用例把这份人工决策固化为回归门禁。
    expect(loadCatalog().map((e) => e.key).sort()).toEqual([
      'baota-mcp-server',
      'kubernetes-mcp-server',
      'mcp-kafka',
      'mcp-server-docker',
      'mcp-server-elasticsearch',
      'mcp-server-ssh',
      'minio-mcp-server',
      'mysql-mcp-server',
      'nacos-native',
      'pickstar-2002-minio-mcp',
      'prometheus-mcp',
      'prometheus-mcp-server',
      'rabbitmq-mcp-server',
      'redis-mcp-server',
      'rocketmq-native',
      'zabbix-native',
    ]);
  });
  it('固定版本必须是已核验存在的版本（2026-11-05 复核 PyPI/npm registry）', () => {
    // 回归：mysql-mcp-server 曾固定为 PyPI 不存在的 0.1.4 → uvx 解析失败 → 实例拉起即退，
    // 连通性测试只报无用的 "Connection closed"。此处锁定经 registry 复核存在的版本组合。
    const VERIFIED: Record<string, string> = {
      'mysql-mcp-server': 'mysql-mcp-server==0.4.5',
      'mcp-server-docker': 'mcp-server-docker==0.3.0',
      'prometheus-mcp': 'prometheus-mcp==0.5.0',
      'redis-mcp-server': 'redis-mcp-server==0.5.1',
      'mcp-server-ssh': 'mcp-server-ssh==2.0.0',
      'kubernetes-mcp-server': 'kubernetes-mcp-server@0.0.67',
      'rabbitmq-mcp-server': 'rabbitmq-mcp@0.2.0',
      'mcp-kafka': 'mcp-kafka@1.2.6',
      'prometheus-mcp-server': 'prometheus-mcp-server@1.0.1',
      // 2026-11-19 新增（原为未固定版本，违反 AC-62；版本已 npm registry 复核）
      'mcp-server-elasticsearch': '@elastic/mcp-server-elasticsearch@0.3.1',
      'minio-mcp-server': 'minio-mcp-server@0.1.0',
      'pickstar-2002-minio-mcp': '@pickstar-2002/minio-mcp@1.1.2',
    };
    for (const e of loadCatalog()) {
      const inst = e.installations[e.runtime]!;
      if (e.executionMode === 'native' || inst.url) continue; // 原生/HTTP 型条目无本地包版本
      const args = inst.args ?? [];
      const spec = args.find((a) => /==[\w.]+$|@[\w.]+$/.test(a) && !a.startsWith('-'));
      expect(spec, `${e.key} 未找到版本固定串`).toBeDefined();
      expect(spec, `${e.key} 固定版本与已核验版本不一致`).toBe(VERIFIED[e.key]);
    }
  });
});

describe('展开与注入', () => {
  it('expandConfig 返回快照；injectSlots 注入占位符', () => {
    const config = expandConfig(entry);
    const slots = detectSlots(entry);
    const injected = injectSlots(config, slots, { host: '10.0.0.1', password: 'p' });
    expect(injected.env.MYSQL_HOST).toBe('10.0.0.1');
    expect(injected.env.MYSQL_PASSWORD).toBe('p');
    expect(injected.args.join(' ')).toContain('10.0.0.1'); // 注入生效（运行时以快照为准）
  });

  it('嵌入占位符（Bearer ${TOKEN}）与 url 占位符都能识别并注入', () => {
    const httpEntry: CatalogEntry = {
      key: 't-http',
      name: 't-http',
      displayName: 'T HTTP',
      description: 'test',
      repository: 'https://example.invalid',
      categories: ['other'],
      tags: [],
      runtime: 'npm',
      slotLabels: { MCP_URL: 'MCP 地址', TOKEN: '授权令牌' },
      installations: {
        npm: {
          url: '${MCP_URL}',
          headers: { Authorization: 'Bearer ${TOKEN}' },
        },
      },
    };
    const config = expandConfig(httpEntry);
    const slots = detectSlots(httpEntry);
    // 两个都必须被识别（此前 `${MCP_URL}` 与 `Bearer ${TOKEN}` 都漏判 → 用户无处填写）
    expect(slots.map((s) => s.name).sort()).toEqual(['MCP_URL', 'TOKEN']);
    expect(slots.find((s) => s.name === 'MCP_URL')!.target).toBe('url');

    const injected = injectSlots(config, slots, {
      MCP_URL: 'https://mcp.example.invalid/mcp',
      TOKEN: 'secret-token',
    });
    expect(injected.url).toBe('https://mcp.example.invalid/mcp');
    expect(injected.headers.Authorization).toBe('Bearer secret-token');
  });

  it('原生条目（executionMode=native）的槽位来自 slotLabels 声明', () => {
    const nativeEntry: CatalogEntry = {
      key: 't-native',
      name: 't-native',
      displayName: 'T Native',
      description: 'test',
      repository: 'https://example.invalid',
      categories: ['zabbix'],
      tags: [],
      runtime: 'npm',
      executionMode: 'native',
      slotLabels: { ZABBIX_TOKEN: 'Zabbix API Token' },      installations: { npm: {} },
    };
    const slots = detectSlots(nativeEntry);
    expect(slots).toEqual([
      expect.objectContaining({ name: 'ZABBIX_TOKEN', label: 'Zabbix API Token', target: 'env', file: false }),
    ]);
  });
});
