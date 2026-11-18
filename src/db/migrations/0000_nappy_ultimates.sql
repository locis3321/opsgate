CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`user_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`client_name` text,
	`scopes` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `api_keys_user_id_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_stats_hourly` (
	`hour_ts` integer NOT NULL,
	`asset_id` text NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`blocked_count` integer DEFAULT 0 NOT NULL,
	`total_duration_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`hour_ts`, `asset_id`)
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'env-values' NOT NULL,
	`encrypted_values` text NOT NULL,
	`value_hint` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_name_unique` ON `credentials` (`name`);--> statement-breakpoint
CREATE INDEX `credentials_owner_id_idx` ON `credentials` (`owner_id`);--> statement-breakpoint
CREATE TABLE `group_servers` (
	`group_id` text NOT NULL,
	`server_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `server_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `group_users` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_unique` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `guard_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`pattern` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`last_hit_at` integer,
	`description` text
);
--> statement-breakpoint
CREATE TABLE `server_credentials` (
	`server_id` text NOT NULL,
	`slot_name` text NOT NULL,
	`credential_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `slot_name`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`description` text,
	`type` text NOT NULL,
	`execution_mode` text NOT NULL,
	`category` text NOT NULL,
	`host_conn` text,
	`tags` text NOT NULL,
	`allow_private_network` integer DEFAULT false NOT NULL,
	`command` text,
	`args` text,
	`env` text,
	`url` text,
	`headers` text,
	`credential_slots` text NOT NULL,
	`owner_id` text NOT NULL,
	`visibility` text DEFAULT 'owner' NOT NULL,
	`shared_with_user_ids` text NOT NULL,
	`tool_filters` text,
	`enabled` integer DEFAULT true NOT NULL,
	`prewarm` integer DEFAULT false NOT NULL,
	`config_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_unique` ON `servers` (`name`);--> statement-breakpoint
CREATE INDEX `servers_owner_id_idx` ON `servers` (`owner_id`);--> statement-breakpoint
CREATE INDEX `servers_visibility_idx` ON `servers` (`visibility`);--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`value_type` text NOT NULL,
	`category` text NOT NULL,
	`default_value` text NOT NULL,
	`min_value` integer,
	`max_value` integer,
	`options` text,
	`is_secret` integer DEFAULT false NOT NULL,
	`requires_restart` integer DEFAULT false NOT NULL,
	`updated_by` text,
	`updated_at` integer,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
-- 审计按月分表：迁移只建生成当月表；跨月/未来月份由运行时 ensureAuditTable 按需创建（项目规则 §5 审计分表例外）。
CREATE TABLE IF NOT EXISTS `audit_log_2026_10` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`user_id` text,
	`username` text,
	`api_key_id` text,
	`client_name` text,
	`source_ip` text,
	`server_id` text,
	`server_name` text,
	`credential_id` text,
	`tool` text,
	`action` text NOT NULL,
	`risk` text,
	`input_summary` text,
	`status` text,
	`output_summary` text,
	`duration_ms` integer,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_2026_10_ts_idx` ON `audit_log_2026_10` (`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_2026_10_user_id_ts_idx` ON `audit_log_2026_10` (`user_id`, `ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_2026_10_server_id_ts_idx` ON `audit_log_2026_10` (`server_id`, `ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_2026_10_status_ts_idx` ON `audit_log_2026_10` (`status`, `ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_2026_10_tool_ts_idx` ON `audit_log_2026_10` (`tool`, `ts`);
