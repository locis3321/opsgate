CREATE TABLE `market_entries` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text NOT NULL,
	`repository` text NOT NULL,
	`categories` text NOT NULL,
	`tags` text NOT NULL,
	`runtime` text NOT NULL,
	`slot_labels` text,
	`installations` text NOT NULL,
	`status` text NOT NULL,
	`readme_url` text,
	`readme_cache` text,
	`readme_fetched_at` integer,
	`version_pinned` text,
	`version_latest` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `market_entries_status_idx` ON `market_entries` (`status`);