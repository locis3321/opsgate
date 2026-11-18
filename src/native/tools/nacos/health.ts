/**
 * nacos_health：Nacos 服务端健康与集群状态。
 *
 * 只调「1.x / 2.x 都存在且语义稳定」的 console 接口：
 *  - `/v1/console/health/readiness`：就绪状态（纯文本 OK）
 *  - `/v1/console/server/state`：服务端状态（含 auth_enabled / version 等）
 *
 * 历史实现用的是 `/v1/ns/operator/servers`（集群节点列表），该接口在 Nacos 2.x 已被移除，
 * 实测 2.x 返回 `501 no such api`，直接导致本工具恒失败。节点级信息不在此承诺范围内。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { nacosClient } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'nacos.health',
  category: 'nacos',
  connector: 'nacos',
  risk: 'read',
  audit: { fields: [] },
  name: 'nacos_health',
  description:
    '查看 Nacos 服务端状态（就绪状态 + 服务端配置）。Use when: 用户问"Nacos 集群正常吗"、"Nacos 是否可用"、"鉴权开了吗"。Required: asset 取自 opsgate_list_assets(category="nacos")，不要编造。',
  inputSchema: { type: 'object', properties: {} },
  async execute(ctx) {
    const { client } = await nacosClient(ctx);
    const root = client.baseUrl.replace(/\/v1$/, '');
    const readiness = await client.requestText(`${root}/v1/console/health/readiness`);
    const state = await client.requestJson<Record<string, unknown>>(`${root}/v1/console/server/state`);
    return { content: { readiness, state }, meta: {} };
  },
};

export default tool;

