/** rocketmq_cluster_info：集群与 Broker 概况（旧版 action=cluster_info）。 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { rocketmqClient, rocketmqData } from './_shared.js';

const tool: NativeToolDefinition = {
  id: 'rocketmq.cluster_info',
  category: 'rocketmq',
  connector: 'rocketmq',
  risk: 'read',
  audit: { fields: [] },
  name: 'rocketmq_cluster_info',
  description:
    '查看 RocketMQ 集群概况（Broker 列表、主从角色、TPS 等）。Use when: 用户问"RocketMQ 集群状态怎么样"、"有几个 broker"、"消费是否有积压（先看集群）"。Required: asset 取自 opsgate_list_assets(category="rocketmq")，不要编造。',
  inputSchema: { type: 'object', properties: {} },
  async execute(ctx) {
    const client = rocketmqClient(ctx);
    const data = await rocketmqData(client, '/cluster/list.query');
    return { content: { cluster: data }, meta: {} };
  },
};

export default tool;
