/**
 * T11 单元测试：槽位自动识别（AC-63，与 SLOT_PLACEHOLDER_RE 同源）/ 目录版本固化（AC-62）/ 展开与注入。
 */
import { describe, expect, it } from 'vitest';
import { SLOT_PLACEHOLDER_SCAN_RE } from '../config/constants.js';
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
      // 原生条目（网关内建 HTTP 工具）、CLI 条目（二进制由主机预装）与 HTTP/SSE 型条目
      // 都没有本地包可固定版本，豁免
      if (e.executionMode === 'native' || e.executionMode === 'cli' || inst.url) continue;
      const pinned = (inst.args ?? []).some((a) => /@\d+\.\d+\.\d+$/.test(a) || /==\d+\.\d+\.\d+$/.test(a));
      expect(pinned).toBe(true); // 每个本地执行型条目至少一个 args 携带显式版本（AC-62：严禁裸 -y pkg）
    }
  });
  it('目录条目数（AC-62：≥12）——2026-10-21 实测批次 13 条', () => {
    expect(loadCatalog().length).toBeGreaterThanOrEqual(12);
  });
  it('内置目录 = 管理员整理后的 23 条（2026-11-25 固化，防止已删条目被重新种回）', () => {
    // 背景：管理员在管理端删掉 7 条（fetch/time/playwright/everything/filesystem/memory/
    // sequential-thinking）并新增 3 条（elasticsearch/minio×2）。种子文件若不同步，
    // 新环境首启会把删掉的重新种进去。此用例把这份人工决策固化为回归门禁。
    // 2026-11-23：新增 cr7258-elasticsearch-mcp-server（官方 @elastic 版已弃用，社区版带写能力与 API 兜底）。
    // 2026-11-24：新增 redis-native / kafka-native（原生工具在 Market 里可直接选，不必走自定义表单）。
    // 2026-11-25：新增 kubectl-cli / kafka-topics-cli / mysql-cli / redis-cli-cli（CLI 模板，ADR-037）。
    expect(loadCatalog().map((e) => e.key).sort()).toEqual([
      'baota-mcp-server',
      'cr7258-elasticsearch-mcp-server',
      'kafka-native',
      'kafka-topics-cli',
      'kubectl-cli',
      'kubernetes-mcp-server',
      'mcp-kafka',
      'mcp-server-docker',
      'mcp-server-elasticsearch',
      'mcp-server-ssh',
      'minio-mcp-server',
      'mysql-cli',
      'mysql-mcp-server',
      'nacos-native',
      'pickstar-2002-minio-mcp',
      'prometheus-mcp',
      'prometheus-mcp-server',
      'rabbitmq-mcp-server',
      'redis-cli-cli',
      'redis-mcp-server',
      'redis-native',
      'rocketmq-native',
      'zabbix-native',
    ]);
  });
  it('CLI 条目（executionMode=cli）声明 cli.bin，且槽位与 env 模板一致（ADR-037）', () => {
    const cli = loadCatalog().filter((e) => e.executionMode === 'cli');
    // 四条 CLI 模板：k8s / mysql / redis / kafka 各一条
    expect(cli.map((e) => e.key).sort()).toEqual(['kafka-topics-cli', 'kubectl-cli', 'mysql-cli', 'redis-cli-cli']);
    const kubectl = cli.find((e) => e.key === 'kubectl-cli')!;
    expect(kubectl.cli?.bin).toBe('kubectl');
    expect(kubectl.cli?.env).toEqual({ KUBECONFIG: '${KUBECONFIG}' });
    for (const e of cli) {
      // bin 是必填业务事实：缺失会让实例化落出一个跑不起来的资产
      expect(e.cli?.bin?.trim(), `${e.key} 缺少 cli.bin`).toBeTruthy();
      // env 模板引用的槽位必须在 slotLabels 里声明（否则用户无处填值）。
      // 例外：OPSGATE_TARGET 是**资产 url** 的渲染占位（不是凭证槽位），由实例化时填的目标地址提供。
      for (const value of Object.values(e.cli?.env ?? {})) {
        for (const m of value.matchAll(SLOT_PLACEHOLDER_SCAN_RE)) {
          if (m[1] === 'OPSGATE_TARGET') continue;
          expect(e.slotLabels, `${e.key} 的 env 模板引用了未声明的槽位 ${m[1]}`).toHaveProperty(m[1]!);
        }
      }
    }
    // url 只经 env 模板的 ${OPSGATE_TARGET} 生效：承接它的条目才能在详情页填目标地址。
    // mysql-cli 的 MYSQL_HOST 承接（填的地址真成为 MySQL 主机）；其余三条没有承接地址的环境变量，
    // 条目描述里也不得承诺"可选填目标地址"（否则是空承诺）。
    expect(cli.find((e) => e.key === 'mysql-cli')?.cli?.env).toEqual({
      MYSQL_HOST: '${OPSGATE_TARGET}',
      MYSQL_PWD: '${MYSQL_PWD}',
    });
    for (const e of cli.filter((x) => x.key !== 'mysql-cli')) {
      const takesTarget = Object.values(e.cli?.env ?? {}).some((v) => v.includes('${OPSGATE_TARGET}'));
      expect(takesTarget, `${e.key} 不应声明承接 url 的环境变量`).toBe(false);
      expect(e.cli?.urlEnv, `${e.key} 没有 env 承接 url，不应声明 urlEnv`).toBeUndefined();
      expect(e.description, `${e.key} 的描述不得承诺可填写目标地址`).not.toMatch(/目标地址可选填|目标实例地址可选填/);
    }
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
      // 2026-11-23 新增（PyPI 2.1.9 已复核；官方 @elastic 版已弃用）
      'cr7258-elasticsearch-mcp-server': 'elasticsearch-mcp-server==2.1.9',
    };
    for (const e of loadCatalog()) {
      const inst = e.installations[e.runtime]!;
      // 原生/CLI/HTTP 型条目无本地包版本（CLI 二进制由主机预装，不进 registry）
      if (e.executionMode === 'native' || e.executionMode === 'cli' || inst.url) continue;
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

  it('CLI 条目（executionMode=cli）的槽位来自 slotLabels 声明，文件类值落临时文件', () => {
    // kubeconfig 是文件内容：必须落 0600 临时文件（env 只给路径），否则 kubectl 拿到的是乱码路径
    const kubectl = loadCatalog().find((e) => e.key === 'kubectl-cli')!;
    expect(detectSlots(kubectl)).toEqual([
      expect.objectContaining({ name: 'KUBECONFIG', label: 'kubeconfig 文件', target: 'env', file: true }),
    ]);
    // 密码类不是文件：直接进 env（mysql/redis-cli 原生支持对应的密码环境变量）
    const mysql = loadCatalog().find((e) => e.key === 'mysql-cli')!;
    expect(detectSlots(mysql)).toEqual([
      expect.objectContaining({ name: 'MYSQL_PWD', target: 'env', file: false, sensitive: false }),
    ]);
    // kafka-topics.sh 条目不注环境变量，槽位为空（broker 地址由 argv 显式给出）
    const kafka = loadCatalog().find((e) => e.key === 'kafka-topics-cli')!;
    expect(detectSlots(kafka)).toEqual([]);
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
