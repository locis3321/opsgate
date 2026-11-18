ALTER TABLE `market_entries` ADD COLUMN `optional_slots` text;
--> statement-breakpoint
-- Nacos 的鉴权是「accessToken」或「用户名+密码」二选一，三个槽位都允许不绑；
-- 未标为可选的槽位仍按必填 fail-closed（默认行为不变）。
UPDATE `market_entries` SET `optional_slots` = '["NACOS_TOKEN","NACOS_USERNAME","NACOS_PASSWORD"]' WHERE `key` = 'nacos-native';
--> statement-breakpoint
-- RocketMQ 同样允许无鉴权部署（工具里无 token 时直接请求），因此 token 槽位也是可选
UPDATE `market_entries` SET `optional_slots` = '["ROCKETMQ_TOKEN"]' WHERE `key` = 'rocketmq-native';
