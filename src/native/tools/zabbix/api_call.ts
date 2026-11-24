/**
 * zabbix_api_call：Zabbix JSON-RPC 原始调用兜底。
 *
 * 定位：具名工具覆盖不到的边缘场景（如 `host.massupdate`、`trigger.create`、`templatedashboard.get`）。
 *
 * 安全设计（三层，缺一不可）：
 *   1. `ZABBIX_DENIED_METHODS` 永久黑名单——账号/权限/脚本类方法任何入口都不可调；
 *   2. `confirm_dangerous: true` 显式确认——LLM 必须先"声明这是危险操作"，意图会进审计；
 *   3. guard_rules 的 arg 维度仍会扫到 method 字符串与 params 序列化文本。
 *
 * 为什么 method 是顶层扁平字符串：guard_rules 的 arg 维度只展开值不展开键名，
 * 若把 method 藏在嵌套对象里则正则匹配不到，等于开出无审计后门。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { zabbixClient, zabbixRawCall } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'zabbix.api_call',
  category: 'zabbix',
  connector: 'zabbix',
  risk: 'destructive',
  audit: { fields: ['method'], includeCommand: true },
  name: 'zabbix_api_call',
  description:
    '调用 Zabbix 任意 JSON-RPC 方法（destructive，账号/权限/脚本类永久禁用，调用前须复述并确认）。Use when: 要做的操作没有具名工具（如 host.massupdate）。Required: asset 取自 opsgate_list_assets(category="zabbix")，不要编造；confirm_dangerous 必为 true。',
  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        description: 'Zabbix JSON-RPC 方法名（如 host.massupdate、trigger.create）',
      },
      params: {
        type: 'object',
        description: '方法的参数对象，按 Zabbix API 文档填写（可为空对象）',
      },
      confirm_dangerous: {
        type: 'boolean',
        description: '危险操作确认：必须是 true 才会执行，用于在审计中留痕',
      },
    },
    required: ['method', 'params', 'confirm_dangerous'],
  },
  async execute(ctx, args) {
    const method = String(args.method ?? '').trim();
    if (!method) throw new Error('method 必填');
    if (args.confirm_dangerous !== true) {
      throw new Error(
        '确认才能执行：请把 confirm_dangerous 设为 true，并在调用前向用户复述 method 与 params。' +
          '这是 raw 入口的强制留痕要求，不是可选项。',
      );
    }
    const params = args.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error('params 必须是对象（无参数时传 {}）');
    }

    const client = await zabbixClient(ctx);
    const result = await zabbixRawCall(client, method, params);
    return { content: { method, result }, meta: { method } };
  },
};

export default tool;
