CREATE TABLE `opensandbox_server` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`workspace_root` text NOT NULL,
	`api_key_ciphertext` text NOT NULL,
	`max_sandboxes` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`last_health_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `sandbox_pool`(`id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_opensandbox_server_pool_id` ON `opensandbox_server` (`pool_id`);--> statement-breakpoint
CREATE TABLE `sandbox_binding` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`server_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `sandbox_pool`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`server_id`) REFERENCES `opensandbox_server`(`id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_sandbox_binding_pool_id` ON `sandbox_binding` (`pool_id`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_binding_server_id` ON `sandbox_binding` (`server_id`);--> statement-breakpoint
CREATE TABLE `sandbox_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
