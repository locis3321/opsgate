/**
 * kafka_admin：Kafka 管理操作（raw 型，但用**动作枚举**而非任意 API 名）。
 *
 * 与 redis_command / zabbix_api_call 的区别：Kafka 的 AdminClient 是一个巨大的方法集合，
 * 直接开放"任意方法 + 任意参数"既无法做参数校验、也无法在审计里看出意图。因此这里收敛为
 * 8 个具名动作，每个动作的参数形状固定——这才是"raw 但可控"的正确形态。
 *
 * 动作清单（对应 kafkajs Admin 的具体方法）：
 *   create_topic / delete_topic / create_partitions / alter_topic_config
 *   delete_consumer_group / reset_offsets / describe_cluster / describe_configs
 *
 * 安全设计：
 *  - `action` 是顶层扁平字符串枚举 → guard_rules 的 arg 维度能直接匹配；
 *  - 危险动作（delete_topic / delete_consumer_group / reset_offsets）强制 confirm_dangerous；
 *  - topic 名进 audit.fields，审计可回溯"动了哪个 topic"。
 */
import type { NativeToolDefinition } from '../../../framework/types.js';
import { withKafkaAdmin } from './_shared.js';

const ACTIONS = [
  'create_topic',
  'delete_topic',
  'create_partitions',
  'alter_topic_config',
  'delete_consumer_group',
  'reset_offsets',
  'describe_cluster',
  'describe_configs',
] as const;

/** 命中即要求 confirm_dangerous=true 的动作 */
const DANGEROUS_ACTIONS = new Set<string>(['delete_topic', 'delete_consumer_group', 'reset_offsets']);

const tool: NativeToolDefinition = {
  id: 'kafka.admin',
  category: 'kafka',
  connector: 'kafka',
  risk: 'destructive',
  audit: { fields: ['action', 'topic', 'group_id'], includeCommand: true },
  name: 'kafka_admin',
  description:
    '执行 Kafka 管理动作（destructive，删/重置须确认并复述）。Use when: 建删 topic、扩分区、改配置、重置位点。Required: asset 取自 opsgate_list_assets(category="kafka")，不要编造；action 见枚举，其余按动作填。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: '动作名（含义见工具说明）：建/删主题、扩分区、改配置、删组、重置位点、查询',
      },
      topic: { type: 'string', description: '主题名（除 delete_consumer_group/describe_cluster 外必填）' },
      partitions: { type: 'number', description: 'create_topic 的分区数，或 create_partitions 的目标总数' },
      replication_factor: { type: 'number', description: 'create_topic 的副本数，默认 1' },
      group_id: { type: 'string', description: '消费组 id（delete_consumer_group / reset_offsets 必填）' },
      configs: {
        type: 'object',
        description: 'alter_topic_config 的配置键值对（如 {"retention.ms":"604800000"}）',
      },
      reset_to: {
        type: 'string',
        enum: ['earliest', 'latest'],
        description: 'reset_offsets 的目标位点：earliest 是指最早，latest 是指最新',
      },
      confirm_dangerous: { type: 'boolean', description: '危险动作确认：删除类/重置位点必须为 true' },
    },
    required: ['action'],
  },
  async execute(ctx, args) {
    const action = String(args.action ?? '').trim();
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`action 仅支持 ${ACTIONS.join(' / ')}`);
    }
    if (DANGEROUS_ACTIONS.has(action) && args.confirm_dangerous !== true) {
      throw new Error(
        `动作 ${action} 不可逆：请把 confirm_dangerous 设为 true，并在执行前向用户复述目标主题/消费组与影响面。`,
      );
    }

    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    const groupId = typeof args.group_id === 'string' ? args.group_id.trim() : '';

    return withKafkaAdmin(ctx, async (admin) => {
      switch (action) {
        case 'create_topic': {
          if (!topic) throw new Error('create_topic 需要 topic');
          const partitions = Number(args.partitions ?? 1);
          const rf = Number(args.replication_factor ?? 1);
          if (!Number.isInteger(partitions) || partitions < 1) throw new Error('partitions 必须是 ≥1 的整数');
          if (!Number.isInteger(rf) || rf < 1) throw new Error('replication_factor 必须是 ≥1 的整数');
          const ok = await admin.createTopics({
            topics: [{ topic, numPartitions: partitions, replicationFactor: rf }],
            waitForLeaders: true,
          });
          return { content: { action, topic, partitions, replication_factor: rf, created: ok }, meta: { action, topic } };
        }
        case 'delete_topic': {
          if (!topic) throw new Error('delete_topic 需要 topic');
          await admin.deleteTopics({ topics: [topic] });
          return { content: { action, topic, deleted: true }, meta: { action, topic } };
        }
        case 'create_partitions': {
          if (!topic) throw new Error('create_partitions 需要 topic');
          const total = Number(args.partitions);
          if (!Number.isInteger(total) || total < 1) throw new Error('partitions 必须是 ≥1 的整数（目标总分区数）');
          const ok = await admin.createPartitions({ topicPartitions: [{ topic, count: total }] });
          return { content: { action, topic, total_partitions: total, updated: ok }, meta: { action, topic } };
        }
        case 'alter_topic_config': {
          if (!topic) throw new Error('alter_topic_config 需要 topic');
          const configs = args.configs;
          if (configs === null || typeof configs !== 'object' || Array.isArray(configs) || Object.keys(configs).length === 0) {
            throw new Error('configs 必须是非空对象，如 {"retention.ms":"604800000"}');
          }
          const entries = Object.entries(configs as Record<string, unknown>).map(([name, value]) => ({
            name,
            value: String(value),
          }));
          await admin.alterConfigs({
            validateOnly: false,
            resources: [{ type: 2 /* TOPIC */, name: topic, configEntries: entries } as never],
          });
          return { content: { action, topic, applied: entries }, meta: { action, topic } };
        }
        case 'delete_consumer_group': {
          if (!groupId) throw new Error('delete_consumer_group 需要 group_id');
          const res = await admin.deleteGroups([groupId]);
          return { content: { action, group_id: groupId, result: res }, meta: { action, groupId } };
        }
        case 'reset_offsets': {
          if (!groupId || !topic) throw new Error('reset_offsets 需要 group_id 与 topic');
          const to = String(args.reset_to ?? '').trim();
          if (to !== 'earliest' && to !== 'latest') {
            throw new Error('reset_offsets 需要 reset_to = earliest 或 latest');
          }
          await admin.resetOffsets({ groupId, topic, earliest: to === 'earliest' });
          return { content: { action, group_id: groupId, topic, reset_to: to, done: true }, meta: { action, groupId, topic } };
        }
        case 'describe_cluster': {
          const info = await admin.describeCluster();
          return { content: { action, ...info }, meta: { action } };
        }
        case 'describe_configs': {
          if (!topic) throw new Error('describe_configs 需要 topic');
          const res = await admin.describeConfigs({
            resources: [{ type: 2 /* TOPIC */, name: topic, configNames: [] } as never],
            includeSynonyms: false,
          });
          return { content: { action, topic, configs: res }, meta: { action, topic } };
        }
        default:
          throw new Error(`未实现的动作：${action}`);
      }
    });
  },
};

export default tool;
