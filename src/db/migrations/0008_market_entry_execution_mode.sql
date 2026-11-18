ALTER TABLE `market_entries` ADD COLUMN `execution_mode` text DEFAULT 'mcp' NOT NULL;
--> statement-breakpoint
-- 平台内建条目（网关自身实现的 HTTP 工具）不是 MCP 包：标为 native，
-- 槽位来自 slot_labels，管理 API 地址由用户建资产时填写（ADR-022 扩展）。
-- 同时清掉旧的 `${XXX_URL}` 安装配置：原生工具不经配置注入，地址不是槽位。
UPDATE `market_entries` SET
  `execution_mode` = 'native',
  `installations` = '{"npm":{}}',
  `slot_labels` = '{"ZABBIX_TOKEN":"Zabbix API Token（用户设置 → API tokens）"}',
  `description` = '平台内置 Zabbix 只读工具（查主机/事件/当前问题）。添加时填写 Zabbix 地址（带协议，如 http://zabbix.example:8080），凭证槽位填 ZABBIX_TOKEN（Zabbix 网页「用户设置 → API tokens」创建）。'
WHERE `key` = 'zabbix-native';
--> statement-breakpoint
UPDATE `market_entries` SET
  `execution_mode` = 'native',
  `installations` = '{"npm":{}}',
  `slot_labels` = '{"ROCKETMQ_TOKEN":"Bearer token（内网无鉴权可留空）"}',
  `description` = '平台内置 RocketMQ 只读工具（集群概况/主题/消费进度）。添加时填写 RocketMQ Dashboard 地址（默认 8080），可选填 ROCKETMQ_TOKEN（内网无鉴权可留空）。'
WHERE `key` = 'rocketmq-native';
--> statement-breakpoint
UPDATE `market_entries` SET
  `execution_mode` = 'native',
  `installations` = '{"npm":{}}',
  `slot_labels` = '{"NACOS_TOKEN":"accessToken（可选；与用户名+密码二选一）","NACOS_USERNAME":"用户名（可选）","NACOS_PASSWORD":"密码（可选）"}',
  `description` = '平台内置 Nacos 只读工具（服务/实例/配置读取/健康检查）。添加时填写 Nacos 地址（如 http://nacos.example:8848），凭证填 NACOS_TOKEN 或 NACOS_USERNAME + NACOS_PASSWORD。'
WHERE `key` = 'nacos-native';
