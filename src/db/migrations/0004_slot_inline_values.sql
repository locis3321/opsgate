CREATE TABLE `server_slot_values` (
	`server_id` text NOT NULL,
	`slot_name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`value_fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `slot_name`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action
);
