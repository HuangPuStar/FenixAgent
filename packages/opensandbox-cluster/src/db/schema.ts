import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sandboxPool = sqliteTable("sandbox_pool", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const opensandboxServer = sqliteTable(
  "opensandbox_server",
  {
    id: text("id").primaryKey(),
    poolId: text("pool_id")
      .notNull()
      .references(() => sandboxPool.id, { onDelete: "restrict", onUpdate: "cascade" }),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    apiKeyCiphertext: text("api_key_ciphertext").notNull(),
    maxSandboxes: integer("max_sandboxes").notNull(),
    status: text("status").notNull().default("active"),
    healthStatus: text("health_status").notNull().default("unknown"),
    lastHealthAt: integer("last_health_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_opensandbox_server_pool_id").on(table.poolId)],
);

export const sandboxBinding = sqliteTable(
  "sandbox_binding",
  {
    sandboxId: text("sandbox_id").primaryKey(),
    poolId: text("pool_id")
      .notNull()
      .references(() => sandboxPool.id, { onDelete: "restrict", onUpdate: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => opensandboxServer.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
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
}));

export const sandboxBindingRelations = relations(sandboxBinding, ({ one }) => ({
  pool: one(sandboxPool, { fields: [sandboxBinding.poolId], references: [sandboxPool.id] }),
  server: one(opensandboxServer, { fields: [sandboxBinding.serverId], references: [opensandboxServer.id] }),
}));

export type SandboxPool = typeof sandboxPool.$inferSelect;
export type NewSandboxPool = typeof sandboxPool.$inferInsert;
export type OpenSandboxServer = typeof opensandboxServer.$inferSelect;
export type NewOpenSandboxServer = typeof opensandboxServer.$inferInsert;
export type SandboxBinding = typeof sandboxBinding.$inferSelect;
export type NewSandboxBinding = typeof sandboxBinding.$inferInsert;
