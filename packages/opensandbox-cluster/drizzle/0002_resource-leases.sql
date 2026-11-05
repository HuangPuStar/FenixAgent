PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_opensandbox_server` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`name` text NOT NULL,
	`transport_mode` text DEFAULT 'direct' NOT NULL,
	`base_url` text NOT NULL,
	`route_host` text,
	`workspace_root` text NOT NULL,
	`api_key_ciphertext` text NOT NULL,
	`max_sandboxes` integer,
	`cpu_capacity` real,
	`memory_capacity_mb` real,
	`disk_capacity_gb` real,
	`gpu_capacity` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`last_health_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `sandbox_pool`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "opensandbox_server_capacity_check" CHECK(max_sandboxes IS NOT NULL OR (cpu_capacity IS NOT NULL AND cpu_capacity > 0 AND memory_capacity_mb IS NOT NULL AND memory_capacity_mb > 0 AND disk_capacity_gb IS NOT NULL AND disk_capacity_gb > 0 AND gpu_capacity IS NOT NULL AND gpu_capacity >= 0 AND typeof(gpu_capacity) = 'integer'))
);
--> statement-breakpoint
INSERT INTO `__new_opensandbox_server`("id", "pool_id", "name", "transport_mode", "base_url", "route_host", "workspace_root", "api_key_ciphertext", "max_sandboxes", "cpu_capacity", "memory_capacity_mb", "disk_capacity_gb", "gpu_capacity", "status", "health_status", "last_health_at", "last_error", "created_at", "updated_at") SELECT "id", "pool_id", "name", "transport_mode", "base_url", "route_host", "workspace_root", "api_key_ciphertext", "max_sandboxes", NULL, NULL, NULL, NULL, "status", "health_status", "last_health_at", "last_error", "created_at", "updated_at" FROM `opensandbox_server`;--> statement-breakpoint
DROP TABLE `opensandbox_server`;--> statement-breakpoint
ALTER TABLE `__new_opensandbox_server` RENAME TO `opensandbox_server`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `opensandbox_server_route_host_unique` ON `opensandbox_server` (`route_host`);--> statement-breakpoint
CREATE INDEX `idx_opensandbox_server_pool_id` ON `opensandbox_server` (`pool_id`);--> statement-breakpoint
CREATE TABLE `__new_sandbox_binding` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`allocation_mode` text DEFAULT 'count' NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`cpu` real,
	`memory_mb` real,
	`disk_gb` real,
	`gpu_count` integer,
	`attempt_id` text,
	`request_hash` text,
	`provider_sandbox_id` text,
	`lease_seconds` integer,
	`expires_at` integer,
	`release_reason` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer,
	`last_error` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	`pool_id` text NOT NULL,
	`server_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `sandbox_pool`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`server_id`) REFERENCES `opensandbox_server`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "sandbox_binding_state_check" CHECK(state IN ('creating','active','uncertain','releasing','released','expired','failed')),
	CONSTRAINT "sandbox_binding_mode_check" CHECK(allocation_mode IN ('count','resources')),
	CONSTRAINT "sandbox_binding_resource_check" CHECK(allocation_mode = 'count' OR (cpu IS NOT NULL AND cpu > 0 AND memory_mb IS NOT NULL AND memory_mb > 0 AND disk_gb IS NOT NULL AND disk_gb > 0 AND gpu_count IS NOT NULL AND gpu_count >= 0 AND typeof(gpu_count) = 'integer' AND attempt_id IS NOT NULL AND request_hash IS NOT NULL AND expires_at IS NOT NULL AND lease_seconds IS NOT NULL AND lease_seconds >= 60))
);
--> statement-breakpoint
INSERT INTO `__new_sandbox_binding`("sandbox_id", "allocation_mode", "state", "cpu", "memory_mb", "disk_gb", "gpu_count", "attempt_id", "request_hash", "provider_sandbox_id", "lease_seconds", "expires_at", "release_reason", "retry_count", "next_retry_at", "last_error", "updated_at", "pool_id", "server_id", "created_at") SELECT "sandbox_id", 'count', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, "created_at", "pool_id", "server_id", "created_at" FROM `sandbox_binding`;--> statement-breakpoint
DROP TABLE `sandbox_binding`;--> statement-breakpoint
ALTER TABLE `__new_sandbox_binding` RENAME TO `sandbox_binding`;--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_binding_attempt_id_unique` ON `sandbox_binding` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sandbox_binding_remote_id` ON `sandbox_binding` (`server_id`,`provider_sandbox_id`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_binding_reconcile` ON `sandbox_binding` (`allocation_mode`,`state`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_binding_expiry` ON `sandbox_binding` (`allocation_mode`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_binding_pool_id` ON `sandbox_binding` (`pool_id`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_binding_server_id` ON `sandbox_binding` (`server_id`);--> statement-breakpoint
CREATE TABLE `__new_sandbox_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduling_mode` text DEFAULT 'count' NOT NULL,
	`default_lease_seconds` integer,
	`max_lease_seconds` integer,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sandbox_pool_mode_check" CHECK(scheduling_mode IN ('count','resources')),
	CONSTRAINT "sandbox_pool_lease_check" CHECK(scheduling_mode = 'count' OR (default_lease_seconds IS NOT NULL AND max_lease_seconds IS NOT NULL AND default_lease_seconds >= 60 AND max_lease_seconds >= default_lease_seconds))
);
--> statement-breakpoint
INSERT INTO `__new_sandbox_pool`("id", "scheduling_mode", "default_lease_seconds", "max_lease_seconds", "name", "status", "created_at", "updated_at") SELECT "id", 'count', NULL, NULL, "name", "status", "created_at", "updated_at" FROM `sandbox_pool`;--> statement-breakpoint
DROP TABLE `sandbox_pool`;--> statement-breakpoint
ALTER TABLE `__new_sandbox_pool` RENAME TO `sandbox_pool`;