ALTER TABLE `opensandbox_server` ADD COLUMN `transport_mode` text DEFAULT 'direct' NOT NULL;
--> statement-breakpoint
ALTER TABLE `opensandbox_server` ADD COLUMN `route_host` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `opensandbox_server_route_host_unique` ON `opensandbox_server` (`route_host`);
--> statement-breakpoint
CREATE TABLE `opensandbox_server_credential` (
  `server_id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL,
  `token_ciphertext` text NOT NULL,
  `token_prefix` text NOT NULL,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  `rotated_at` integer,
  `revoked_at` integer,
  `last_used_at` integer,
  FOREIGN KEY (`server_id`) REFERENCES `opensandbox_server`(`id`) ON UPDATE cascade ON DELETE cascade,
  CONSTRAINT `opensandbox_server_credential_status_check` CHECK (`status` IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE `opensandbox_tunnel_connection` (
  `server_id` text PRIMARY KEY NOT NULL,
  `frp_run_id` text NOT NULL,
  `status` text NOT NULL,
  `connected_at` integer,
  `disconnected_at` integer,
  `last_seen_at` integer NOT NULL,
  `health_status` text NOT NULL,
  `last_health_at` integer,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`server_id`) REFERENCES `opensandbox_server`(`id`) ON UPDATE cascade ON DELETE cascade,
  CONSTRAINT `opensandbox_tunnel_connection_status_check` CHECK (`status` IN ('connecting', 'connected', 'disconnected')),
  CONSTRAINT `opensandbox_tunnel_connection_health_check` CHECK (`health_status` IN ('unknown', 'healthy', 'unhealthy'))
);
