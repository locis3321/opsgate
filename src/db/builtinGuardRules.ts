/**
 * 内置 guard_rules 定义（§4.7 三条 block + 三条 mark，§5.5.7 扩展：敏感路径上传 block、落脚本 mark、命令注入 block）。
 * pattern 均为线性正则（无嵌套量词/回溯引用），满足 §4.7 的 ReDoS 要求。
 *
 * 为什么单独成模块：它同时被两处消费——
 *  - `src/db/seed.ts`（`pnpm run seed`，供开发/测试环境手动播种）
 *  - `src/server.ts` 首启 bootstrap（生产部署不会跑 seed，导致 guard_rules 一直是 0 行）
 * 两份定义会漂移，所以只留这一份。
 */
export interface BuiltinGuardRule {
  id: string;
  name: string;
  kind: 'block' | 'mark';
  target: 'arg' | 'tool';
  pattern: string;
  priority: number;
  description: string;
}

export const BUILTIN_GUARD_RULES: BuiltinGuardRule[] = [
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
