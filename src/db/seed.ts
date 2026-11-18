/**
 * 种子数据（T2 / §4.7 + §5.5.7）：内置 guard_rules（locked=1）。
 * 幂等（onConflictDoNothing），可重复执行；先跑迁移（fresh 环境一条命令建库+播种）。
 * 不播种任何分组：分组是自由组织单元，由管理员按需创建（ADR-026，取代 ADR-015 前半「默认分组按资产类型」）。
 * 注意：system_settings **不播种任何行**（ADR-024：DB 只存偏离默认值的行，默认值在 SETTINGS_SCHEMA，AC-56）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readBootstrap } from '../config/bootstrap.js';
import { guardRules, marketEntries } from './schema.js';
import { entryToRow } from './marketEntries.js';
import { loadCatalog } from '../services/marketCatalog.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * 内置规则（§4.7 三条 block + 三条 mark，§5.5.7 扩展：敏感路径上传 block、落脚本 mark、命令注入 block）。
 * pattern 均为线性正则（无嵌套量词/回溯引用），满足 §4.7 的 ReDoS 要求。
 */
const SEED_RULES = [
  {
    id: 'gr-block-ssrf-metadata',
    name: '云元数据地址 SSRF',
    kind: 'block',
    target: 'arg',
    pattern: '169\\.254\\.169\\.254|metadata\\.google\\.internal',
    priority: 1000,
    description: 'SSRF 底线：云元数据地址 / 链路本地地址（mcphub always-on 规则等价物）',
  },
  {
    id: 'gr-block-cred-path',
    name: '凭据路径读取',
    kind: 'block',
    target: 'arg',
    pattern: '\\.ssh/id_|\\.aws/credentials|\\.kube/config|/etc/shadow',
    priority: 900,
    description: '凭据文件读取（SSH 私钥 / AWS 凭证 / kubeconfig / shadow）',
  },
  {
    id: 'gr-block-rce',
    name: '命令注入 RCE 特征',
    kind: 'block',
    target: 'arg',
    pattern: ';\\s*rm\\s+-rf|\\|\\s*sh\\b|\\$\\([^)]*\\)|`[^`]*`',
    priority: 800,
    description: '命令注入模式：; rm -rf、| sh、$()、反引号',
  },
  {
    id: 'gr-block-sens-upload',
    name: '敏感路径上传（持久化后门）',
    kind: 'block',
    target: 'arg',
    pattern: '^/etc/|^/root/\\.ssh/|^/var/spool/cron/|crontab$|\\.bashrc$|\\.profile$|\\.zshrc$|\\.bash_profile$',
    priority: 700,
    description: '上传到 /etc/、/root/.ssh/、cron 目录、shell rc 文件 = 持久化后门，申请阶段即拦截',
  },
  {
    id: 'gr-mark-destructive',
    name: '写删类工具名',
    kind: 'mark',
    target: 'tool',
    pattern: '(delete|drop|truncate|kill|restart|reboot|shutdown|scale|patch|apply|exec)$',
    priority: 600,
    description: '写删类工具名命中 → risk=high',
  },
  {
    id: 'gr-mark-sql-write',
    name: 'SQL 写操作',
    kind: 'mark',
    target: 'arg',
    pattern: '\\b(DROP|DELETE|TRUNCATE|ALTER|GRANT|INSERT|UPDATE)\\b',
    priority: 500,
    description: 'SQL 写语句 → risk=high',
  },
  {
    id: 'gr-mark-host-danger',
    name: '主机高危命令',
    kind: 'mark',
    target: 'arg',
    pattern: '\\b(rm\\s+-rf|mkfs|dd\\s+if=|shutdown|reboot|kill\\s+-9)\\b',
    priority: 400,
    description: '主机高危命令 → risk=high',
  },
  {
    id: 'gr-mark-drop-script',
    name: '上传落脚本',
    kind: 'mark',
    target: 'arg',
    pattern: '\\.(sh|py|service)$',
    priority: 300,
    description: 'host_request_upload 路径后缀 .sh/.py/.service → risk=high',
  },
];

async function main(): Promise<void> {
  const cfg = readBootstrap();
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const sqlite = new Database(cfg.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);

  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  for (const r of SEED_RULES) {
    db.insert(guardRules)
      .values({ ...r, enabled: true, locked: true, builtin: true, hitCount: 0 })
      .onConflictDoNothing({ target: guardRules.id })
      .run();
  }

  const ruleCount = db.select().from(guardRules).all().length;

  // Market 目录条目（ADR-029）：JSON 仅作种子源，运行时读 market_entries 表。
  // onConflictDoNothing —— 后台改过的条目不能被重跑 seed 覆盖。
  let marketSeeded = 0;
  for (const entry of loadCatalog()) {
    const res = db
      .insert(marketEntries)
      .values(entryToRow(entry, 'verified'))
      .onConflictDoNothing({ target: marketEntries.key })
      .run();
    if (res.changes > 0) marketSeeded++;
  }
  const marketTotal = db.select().from(marketEntries).all().length;

  console.log(
    `seed 完成：内置规则 ${ruleCount}（locked=1）；Market 目录 ${marketTotal} 条` +
      (marketSeeded > 0 ? `（本次新增 ${marketSeeded}）` : '（均为已有，跳过）') +
      '；分组由管理员按需创建（ADR-026）',
  );
  sqlite.close();
}

main().catch((err) => {
  console.error('seed 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
