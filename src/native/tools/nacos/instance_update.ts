/**
 * nacos_instance_update：服务实例上下线（权重调整）。
 *
 * Nacos OpenAPI（1.x/2.x 均可用）：
 *   PUT  /ns/instance            注册/更新实例（含 weight、enabled）
 *   DELETE /ns/instance          下线实例
 *
 * 为什么不用 /ns/instance?enabled=false 这种"软下线"：Nacos 的 PUT 会整体覆盖实例属性，
 * 只带 partial 字段容易把 metadata 清空。因此 enabled 走 PUT 全量（metadata 原样回传由调用方决定），
 * 下线走 DELETE 更明确。
 *
 * risk='destructive'：下线实例会立即把流量摘走，可能导致业务抖动，必须二次确认。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { nacosClient } from './_shared.js';

const ACTIONS = ['register', 'deregister', 'set_weight'] as const;

const tool: NativeToolDefinition = {
  id: 'nacos.instance_update',
  category: 'nacos',
  connector: 'nacos',
  risk: 'destructive',
  audit: { fields: ['action', 'service', 'ip', 'port', 'weight'] },
  name: 'nacos_instance_update',
  description:
    '对 Nacos 服务实例做上下线或权重调整（destructive：下线会立刻摘流量，执行前必须向用户复述服务名/实例 IP/端口并等待确认）。Use when: 用户说"把这台实例摘掉"、"灰度把权重调到 10"、"实例挂了先下线"。Required: asset 取自 opsgate_list_assets(category="nacos")，不要编造；action 必填。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: '操作类型：register 是指注册/覆盖实例，deregister 是指下线，set_weight 是指改权重',
      },
      service: { type: 'string', description: '服务名' },
      ip: { type: 'string', description: '实例 IP' },
      port: { type: 'number', description: '实例端口' },
      weight: { type: 'number', description: '权重（set_weight 时必填；0 表示不接流量）' },
      group: { type: 'string', description: '分组，默认 DEFAULT_GROUP' },
      namespace: { type: 'string', description: '命名空间 id（默认 public）' },
      cluster: { type: 'string', description: '集群名，默认 DEFAULT' },
      ephemeral: { type: 'boolean', description: '是否临时实例，默认 true' },
    },
    required: ['action', 'service', 'ip', 'port'],
  },
  async execute(ctx, args) {
    const action = String(args.action ?? '').trim();
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`action 仅支持 ${ACTIONS.join(' / ')}`);
    }
    const service = String(args.service ?? '').trim();
    const ip = String(args.ip ?? '').trim();
    const port = Number(args.port);
    if (!service || !ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('service / ip / port 必填，且 port 为 1–65535 整数');
    }
    const group = String(args.group ?? '').trim() || 'DEFAULT_GROUP';
    const ns = String(args.namespace ?? '').trim();
    const cluster = String(args.cluster ?? '').trim() || 'DEFAULT';
    const ephemeral = args.ephemeral !== false;

    const { client } = await nacosClient(ctx);
    const base: Record<string, string> = {
      serviceName: service,
      groupName: group,
      ip,
      port: String(port),
      clusterName: cluster,
      ephemeral: String(ephemeral),
      ...(ns ? { namespaceId: ns } : {}),
    };

    if (action === 'deregister') {
      const res = await client.requestText(`/ns/instance?${new URLSearchParams(base).toString()}`, { method: 'DELETE' });
      if (res.trim() !== 'ok' && res.trim() !== 'true') {
        throw new Error(`Nacos 下线失败（返回 "${res.slice(0, 200)}"）：确认实例存在且账号有写权限`);
      }
      return { content: { action, service, ip, port, result: res.trim() }, meta: { action, service } };
    }

    const form: Record<string, string> = { ...base, weight: '1', enabled: 'true' };
    if (action === 'set_weight') {
      const w = Number(args.weight);
      if (!Number.isFinite(w) || w < 0) throw new Error('set_weight 需要 weight ≥ 0');
      form.weight = String(w);
      form.enabled = w === 0 ? 'false' : 'true';
    }

    const res = await client.requestText('/ns/instance', { method: 'POST', form });
    if (res.trim() !== 'ok' && res.trim() !== 'true') {
      throw new Error(`Nacos ${action} 失败（返回 "${res.slice(0, 200)}"）：确认服务已存在且账号有写权限`);
    }
    return { content: { action, service, ip, port, weight: form.weight, result: res.trim() }, meta: { action, service } };
  },
};

export default tool;
