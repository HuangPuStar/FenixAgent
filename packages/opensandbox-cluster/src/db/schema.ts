import { relations, sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export type TransportMode = "direct" | "tunnel";
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type HealthStatus = "unknown" | "healthy" | "unhealthy";
export type CredentialStatus = "active" | "revoked";

export const sandboxPool = sqliteTable(
  "sandbox_pool",
  {
    id: text("id").primaryKey(),
    schedulingMode: text("scheduling_mode").notNull().default("count"),
    defaultLeaseSeconds: integer("default_lease_seconds"),
    maxLeaseSeconds: integer("max_lease_seconds"),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (_table) => [
    check("sandbox_pool_mode_check", sql`scheduling_mode IN ('count','resources')`),
    check(
      "sandbox_pool_lease_check",
      sql`scheduling_mode = 'count' OR (default_lease_seconds IS NOT NULL AND max_lease_seconds IS NOT NULL AND default_lease_seconds >= 60 AND max_lease_seconds >= default_lease_seconds)`,
    ),
  ],
);

export const opensandboxServer = sqliteTable(
  "opensandbox_server",
  {
    id: text("id").primaryKey(),
    poolId: text("pool_id")
      .notNull()
      .references(() => sandboxPool.id, { onDelete: "restrict", onUpdate: "cascade" }),
    name: text("name").notNull(),
    transportMode: text("transport_mode").$type<TransportMode>().notNull().default("direct"),
    // The legacy column is NOT NULL; an empty value means tunnel transport has no direct URL.
    baseUrl: text("base_url").notNull(),
    routeHost: text("route_host").unique(),
    workspaceRoot: text("workspace_root").notNull(),
    apiKeyCiphertext: text("api_key_ciphertext").notNull(),
    maxSandboxes: integer("max_sandboxes"),
    cpuCapacity: real("cpu_capacity"),
    memoryCapacityMb: real("memory_capacity_mb"),
    diskCapacityGb: real("disk_capacity_gb"),
    gpuCapacity: integer("gpu_capacity"),
    status: text("status").notNull().default("active"),
    healthStatus: text("health_status").notNull().default("unknown"),
    lastHealthAt: integer("last_health_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_opensandbox_server_pool_id").on(table.poolId),
    check(
      "opensandbox_server_capacity_check",
      sql`max_sandboxes IS NOT NULL OR (cpu_capacity IS NOT NULL AND cpu_capacity > 0 AND memory_capacity_mb IS NOT NULL AND memory_capacity_mb > 0 AND disk_capacity_gb IS NOT NULL AND disk_capacity_gb > 0 AND gpu_capacity IS NOT NULL AND gpu_capacity >= 0 AND typeof(gpu_capacity) = 'integer')`,
    ),
  ],
);

export const opensandboxServerCredential = sqliteTable(
  "opensandbox_server_credential",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => opensandboxServer.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    status: text("status").$type<CredentialStatus>().notNull(),
    createdAt: integer("created_at").notNull(),
    rotatedAt: integer("rotated_at"),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
  },
  (_table) => [check("opensandbox_server_credential_status_check", sql`(status IN ('active', 'revoked'))`)],
);

export const opensandboxTunnelConnection = sqliteTable(
  "opensandbox_tunnel_connection",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => opensandboxServer.id, { onDelete: "cascade", onUpdate: "cascade" }),
    frpRunId: text("frp_run_id").notNull(),
    status: text("status").$type<ConnectionStatus>().notNull(),
    connectedAt: integer("connected_at"),
    disconnectedAt: integer("disconnected_at"),
    lastSeenAt: integer("last_seen_at").notNull(),
    healthStatus: text("health_status").$type<HealthStatus>().notNull(),
    lastHealthAt: integer("last_health_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (_table) => [
    check("opensandbox_tunnel_connection_status_check", sql`(status IN ('connecting', 'connected', 'disconnected'))`),
    check("opensandbox_tunnel_connection_health_check", sql`(health_status IN ('unknown', 'healthy', 'unhealthy'))`),
  ],
);

export const sandboxBinding = sqliteTable(
  "sandbox_binding",
  {
    sandboxId: text("sandbox_id").primaryKey(),
    allocationMode: text("allocation_mode").notNull().default("count"),
    state: text("state").notNull().default("active"),
    cpu: real("cpu"),
    memoryMb: real("memory_mb"),
    diskGb: real("disk_gb"),
    gpuCount: integer("gpu_count"),
    attemptId: text("attempt_id").unique(),
    requestHash: text("request_hash"),
    providerSandboxId: text("provider_sandbox_id"),
    leaseSeconds: integer("lease_seconds"),
    expiresAt: integer("expires_at"),
    releaseReason: text("release_reason"),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: integer("next_retry_at"),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull().default(0),
    poolId: text("pool_id")
      .notNull()
      .references(() => sandboxPool.id, { onDelete: "restrict", onUpdate: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => opensandboxServer.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_sandbox_binding_remote_id").on(table.serverId, table.providerSandboxId),
    index("idx_sandbox_binding_reconcile").on(table.allocationMode, table.state, table.nextRetryAt),
    index("idx_sandbox_binding_expiry").on(table.allocationMode, table.expiresAt),
    check(
      "sandbox_binding_state_check",
      sql`state IN ('creating','active','uncertain','releasing','released','expired','failed')`,
    ),
    check("sandbox_binding_mode_check", sql`allocation_mode IN ('count','resources')`),
    check(
      "sandbox_binding_resource_check",
      sql`allocation_mode = 'count' OR (cpu IS NOT NULL AND cpu > 0 AND memory_mb IS NOT NULL AND memory_mb > 0 AND disk_gb IS NOT NULL AND disk_gb > 0 AND gpu_count IS NOT NULL AND gpu_count >= 0 AND typeof(gpu_count) = 'integer' AND attempt_id IS NOT NULL AND request_hash IS NOT NULL AND expires_at IS NOT NULL AND lease_seconds IS NOT NULL AND lease_seconds >= 60)`,
    ),
    index("idx_sandbox_binding_pool_id").on(table.poolId),
    index("idx_sandbox_binding_server_id").on(table.serverId),
  ],
);

export const sandboxPoolRelations = relations(sandboxPool, ({ many }) => ({
  servers: many(opensandboxServer),
  bindings: many(sandboxBinding),
}));

export const opensandboxServerRelations = relations(opensandboxServer, ({ one, many }) => ({
  pool: one(sandboxPool, { fields: [opensandboxServer.poolId], references: [sandboxPool.id] }),
  bindings: many(sandboxBinding),
  credential: one(opensandboxServerCredential),
  tunnelConnection: one(opensandboxTunnelConnection),
}));

export const opensandboxServerCredentialRelations = relations(opensandboxServerCredential, ({ one }) => ({
  server: one(opensandboxServer, {
    fields: [opensandboxServerCredential.serverId],
    references: [opensandboxServer.id],
  }),
}));

export const opensandboxTunnelConnectionRelations = relations(opensandboxTunnelConnection, ({ one }) => ({
  server: one(opensandboxServer, {
    fields: [opensandboxTunnelConnection.serverId],
    references: [opensandboxServer.id],
  }),
}));

export const sandboxBindingRelations = relations(sandboxBinding, ({ one }) => ({
  pool: one(sandboxPool, { fields: [sandboxBinding.poolId], references: [sandboxPool.id] }),
  server: one(opensandboxServer, { fields: [sandboxBinding.serverId], references: [opensandboxServer.id] }),
}));

export type SandboxPool = typeof sandboxPool.$inferSelect;
export type NewSandboxPool = typeof sandboxPool.$inferInsert;
export type OpenSandboxServer = typeof opensandboxServer.$inferSelect;
export type NewOpenSandboxServer = typeof opensandboxServer.$inferInsert;
export type OpenSandboxServerCredential = typeof opensandboxServerCredential.$inferSelect;
export type NewOpenSandboxServerCredential = typeof opensandboxServerCredential.$inferInsert;
export type OpenSandboxTunnelConnection = typeof opensandboxTunnelConnection.$inferSelect;
export type NewOpenSandboxTunnelConnection = typeof opensandboxTunnelConnection.$inferInsert;
export type SandboxBinding = typeof sandboxBinding.$inferSelect;
export type NewSandboxBinding = typeof sandboxBinding.$inferInsert;
