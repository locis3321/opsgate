PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'env-values' NOT NULL,
	`encrypted_values` text NOT NULL,
	`value_hint` text NOT NULL,
	`privileges` text DEFAULT '[]' NOT NULL,
	`owner_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_credentials`("id", "name", "kind", "encrypted_values", "value_hint", "privileges", "owner_id", "created_at", "updated_at") SELECT "id", "name", "kind", "encrypted_values", "value_hint", "privileges", "owner_id", "created_at", "updated_at" FROM `credentials`;--> statement-breakpoint
DROP TABLE `credentials`;--> statement-breakpoint
ALTER TABLE `__new_credentials` RENAME TO `credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_name_unique` ON `credentials` (`name`);--> statement-breakpoint
CREATE INDEX `credentials_owner_id_idx` ON `credentials` (`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_servers` (
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
	`owner_id` text,
	`visibility` text DEFAULT 'owner' NOT NULL,
	`shared_with_user_ids` text NOT NULL,
	`tool_filters` text,
	`enabled` integer DEFAULT true NOT NULL,
	`prewarm` integer DEFAULT false NOT NULL,
	`config_hash` text NOT NULL,
	`market_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_servers`("id", "name", "display_name", "description", "type", "execution_mode", "category", "host_conn", "tags", "allow_private_network", "command", "args", "env", "url", "headers", "credential_slots", "owner_id", "visibility", "shared_with_user_ids", "tool_filters", "enabled", "prewarm", "config_hash", "market_key", "created_at", "updated_at") SELECT "id", "name", "display_name", "description", "type", "execution_mode", "category", "host_conn", "tags", "allow_private_network", "command", "args", "env", "url", "headers", "credential_slots", "owner_id", "visibility", "shared_with_user_ids", "tool_filters", "enabled", "prewarm", "config_hash", "market_key", "created_at", "updated_at" FROM `servers`;--> statement-breakpoint
DROP TABLE `servers`;--> statement-breakpoint
ALTER TABLE `__new_servers` RENAME TO `servers`;--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_unique` ON `servers` (`name`);--> statement-breakpoint
CREATE INDEX `servers_owner_id_idx` ON `servers` (`owner_id`);--> statement-breakpoint
CREATE INDEX `servers_visibility_idx` ON `servers` (`visibility`);--> statement-breakpoint
ALTER TABLE `users` ADD `is_disabled` integer DEFAULT false NOT NULL;