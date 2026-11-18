-- 一槽多凭证：主键由 (server_id, slot_name, user_id) 扩为 (server_id, slot_name, user_id, credential_id)
--
-- 原主键让「同一人在同一槽位」只能存在一条绑定，导致归属人无法同时持有
-- root（personal，自用）与 dev（asset，共享给组内）两套凭证 —— 后绑的会覆盖前一条，
-- ON CONFLICT DO UPDATE 也让"追加绑定"实际变成"换绑"。
--
-- 取值顺序（personal 优先于 asset）不变；同一人同槽多条 personal 时按 privileges 取最高。

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_server_credentials` (
	`server_id` text NOT NULL,
	`slot_name` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`scope` text DEFAULT 'personal' NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `slot_name`, `user_id`, `credential_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_server_credentials` ("server_id", "slot_name", "user_id", "credential_id", "scope", "label", "created_at")
SELECT "server_id", "slot_name", "user_id", "credential_id", "scope", "label", "created_at"
FROM `server_credentials`;--> statement-breakpoint
DROP TABLE `server_credentials`;--> statement-breakpoint
ALTER TABLE `__new_server_credentials` RENAME TO `server_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `server_credentials_user_id_idx` ON `server_credentials` (`user_id`);--> statement-breakpoint
CREATE INDEX `server_credentials_credential_id_idx` ON `server_credentials` (`credential_id`);
