/** CLI 资产的工具名与 schema（单一真值源；toolsOfAsset 与 mcpEndpoint 共用，避免两处漂移）。 */

export const CLI_ARGV_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    argv: {
      type: 'array',
      items: { type: 'string' },
      description: '子命令与参数按顺序传，如 ["get","pods","-n","prod"]；不要写 shell 语法（不经 shell）',
    },
  },
  required: ['argv'],
};

export interface CliExposedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: 'cli';
  category: string;
  impl: 'opsgate';
  toolRef: string;
}

export function cliToolNameOf(category: string): string {
  const c = category.trim();
  if (!c) throw new Error('CLI 工具名派生需要品类，但品类为空');
  return `${c}_run`;
}

/** 描述插值裁剪：保证总长可证明 ≤ R6 上限（200），不依赖资产名/路径长短 */
function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function cliExposedTool(asset: {
  id: string;
  name: string;
  category: string;
  command: string | null;
}): CliExposedTool {
  const bin = asset.command?.trim();
  if (!bin) {
    // 二进制是必填业务事实：缺失时源头显式失败，不把它伪装成可调用工具（§2 原则 2/5）
    throw new Error(`CLI 资产「${asset.name}」未配置二进制（command），无法暴露工具`);
  }
  const toolName = cliToolNameOf(asset.category);
  const name = clip(asset.name, 16);
  const binShort = clip(bin, 16);
  return {
    name: toolName,
    description:
      `在 CLI 资产「${name}」执行 ${binShort}（argv 直执行，不经 shell）。` +
      `Use when: 查看资源、排障等需跑该子命令时。` +
      `Required: asset 取自 opsgate_list_assets（cli）；argv 为字符串数组，按顺序传，不写 shell 语法。` +
      `Risk: 写删类命中规则标高危，执行前复述 argv 与目标资产。`,
    inputSchema: CLI_ARGV_SCHEMA,
    source: 'cli',
    category: asset.category,
    impl: 'opsgate',
    toolRef: toolName,
  };
}
