ALTER TABLE `market_entries` ADD COLUMN `default_group` text;
--> statement-breakpoint
-- 平台内建条目：给一组合理的默认分组（分组不存在时由实例化逻辑自动创建）。
-- ADR-026 仍成立：分组不按 category 自动归组；这里是条目作者显式声明的默认归属。
UPDATE `market_entries` SET `default_group` = 'zabbix' WHERE `key` = 'zabbix-native';
--> statement-breakpoint
UPDATE `market_entries` SET `default_group` = 'rocketmq' WHERE `key` = 'rocketmq-native';
--> statement-breakpoint
UPDATE `market_entries` SET `default_group` = 'nacos' WHERE `key` = 'nacos-native';
--> statement-breakpoint
UPDATE `market_entries` SET `default_group` = 'k8s' WHERE `categories` LIKE '%"k8s"%';
--> statement-breakpoint
UPDATE `market_entries` SET `default_group` = 'mysql' WHERE `categories` LIKE '%"mysql"%';
--> statement-breakpoint
-- 历史资产回填：按品类补进对应默认分组（与新建行为一致；分组已存在则复用）。
-- 只补 category 有默认分组的品类（host/mysql/k8s/zabbix/rocketmq/nacos），other 不归组。
INSERT INTO `groups` (`id`, `name`, `description`, `created_at`, `updated_at`)
SELECT 'grp-' || s.`category`, s.`category`, s.`category` || ' 品类资产的默认分组（创建资产时自动加入，可再调整）', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM (SELECT DISTINCT `category` FROM `servers` WHERE `category` IN ('host','mysql','k8s','zabbix','rocketmq','nacos')) s
WHERE NOT EXISTS (SELECT 1 FROM `groups` g WHERE g.`name` = s.`category`);
--> statement-breakpoint
INSERT OR IGNORE INTO `group_servers` (`group_id`, `server_id`, `created_at`)
SELECT g.`id`, s.`id`, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `servers` s JOIN `groups` g ON g.`name` = s.`category`
WHERE s.`category` IN ('host','mysql','k8s','zabbix','rocketmq','nacos')
  AND NOT EXISTS (SELECT 1 FROM `group_servers` gs WHERE gs.`server_id` = s.`id` AND gs.`group_id` = g.`id`);
