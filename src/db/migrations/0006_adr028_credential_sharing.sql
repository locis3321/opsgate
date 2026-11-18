-- ADR-028：凭证共享恢复 + 一槽多凭证 + 等级标签
--
-- 手工修正 drizzle 自动生成的两处问题：
--  1) 自动生成的 INSERT..SELECT 直接引用了旧表不存在的 user_id/scope/label 列 → 必然报 no such column；
--     这里改为按旧绑定所属资产的 owner 回填，scope 固定 'asset'（T8 决策：现有绑定都是 owner 建的）。
--  2) 自动生成的 `ALTER TABLE credentials ADD privileges text NOT NULL` 缺少 DEFAULT，
--     在已有数据的表上是非法 DDL；这里补 DEFAULT '[]'。

CREATE TABLE `credential_group_shares` (
	`credential_id` text NOT NULL,
	`group_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`credential_id`, `group_id`),
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_server_credentials` (
	`server_id` text NOT NULL,
	`slot_name` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`scope` text DEFAULT 'asset' NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `slot_name`, `user_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_server_credentials` ("server_id", "slot_name", "user_id", "credential_id", "scope", "label", "created_at")
SELECT sc."server_id", sc."slot_name", s."owner_id", sc."credential_id", 'asset', NULL, sc."created_at"
FROM `server_credentials` sc
JOIN `servers` s ON s."id" = sc."server_id";--> statement-breakpoint
DROP TABLE `server_credentials`;--> statement-breakpoint
ALTER TABLE `__new_server_credentials` RENAME TO `server_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `server_credentials_user_id_idx` ON `server_credentials` (`user_id`);--> statement-breakpoint
CREATE INDEX `server_credentials_credential_id_idx` ON `server_credentials` (`credential_id`);--> statement-breakpoint
ALTER TABLE `credentials` ADD `privileges` text NOT NULL DEFAULT '[]';
