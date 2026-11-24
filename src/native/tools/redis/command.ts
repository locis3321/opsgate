/**
 * redis_command：执行任意 Redis 原生命令（raw 兜底）。
 *
 * 为什么需要 raw：社区 MCP 的 53 个工具全是数据命令，运维排障要用的
 * `SLOWLOG` / `MEMORY USAGE` / `CLIENT LIST` / `CONFIG GET` / `SCAN` 都不在其中。
 *
 * 安全设计：
 *  1. `command` 与 `args` 都是**顶层扁平**入参 —— guard_rules 的 arg 维度只展开值不展开键名，
 *     藏在嵌套对象里会匹配不到，等于开出无审计后门；
 *  2. 命中 `REDIS_DANGEROUS_COMMANDS`（FLUSHALL/KEYS/CONFIG/SHUTDOWN…）时**强制** confirm_dangerous=true；
 *  3. guard_rules 仍会扫到命令字符串（内置 `gr-mark-destructive` 等规则的 arg 维度）。
 *
 * 默认启用（用户决策 D3），危险命令的二次确认是最后一道闸。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { isDangerousRedisCommand, redisHandle, trimRedisResult } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'redis.command',
  category: 'redis',
  connector: 'redis',
  risk: 'destructive',
  audit: { fields: ['command'], includeCommand: true },
  name: 'redis_command',
  description:
    '执行任意 Redis 原生命令（destructive，危险命令须确认并复述）。Use when: 无具名工具的命令（SLOWLOG、MEMORY USAGE、CLIENT LIST、CONFIG GET）。Required: asset 取自 opsgate_list_assets(category="redis")，不要编造；command 必填。',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Redis 命令名（如 GET、SCAN、SLOWLOG、MEMORY、CONFIG、CLIENT）',
      },
      args: {
        type: 'array',
        items: { type: ['string', 'number'] },
        description: '命令参数数组（按 Redis 协议顺序，如 ["USAGE","bigkey"]）',
      },
      confirm_dangerous: {
        type: 'boolean',
        description: '危险命令确认：命中危险清单时必须为 true',
      },
    },
    required: ['command'],
  },
  async execute(ctx, args) {
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('command 必填');
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(command)) {
      throw new Error(`command 非法："${command}"（只允许单段命令名，如 GET / SLOWLOG；子命令放 args）`);
    }

    const rawArgs = args.args;
    const argv: Array<string | number> = [];
    if (rawArgs !== undefined) {
      if (!Array.isArray(rawArgs)) throw new Error('args 必须是数组（无参数请省略）');
      for (const a of rawArgs) {
        if (typeof a !== 'string' && typeof a !== 'number') {
          throw new Error('args 的元素只能是字符串或数字');
        }
        argv.push(a);
      }
    }

    if (isDangerousRedisCommand(command) && args.confirm_dangerous !== true) {
      throw new Error(
        `命令 ${command.toUpperCase()} 属危险操作：请把 confirm_dangerous 设为 true，并在执行前向用户复述完整命令与目标实例。`,
      );
    }

    const handle = redisHandle(ctx);
    const result = await handle.command(command, argv);
    return {
      content: { command: command.toUpperCase(), args: argv, result: trimRedisResult(result) },
      meta: { command: command.toUpperCase(), argCount: argv.length },
    };
  },
};

export default tool;
