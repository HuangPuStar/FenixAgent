import { db } from "../../db";
import { mcpServer } from "../../db/schema";
import { eq, and } from "drizzle-orm";

// ────────────────────────────────────────────
// MCP Server 操作
// ────────────────────────────────────────────

export async function listMcpServers(userId: string) {
  return db.select().from(mcpServer)
    .where(eq(mcpServer.userId, userId));
}

export async function getMcpServer(userId: string, name: string) {
  const rows = await db.select().from(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createMcpServer(
  userId: string,
  name: string,
  type: string,
  config: Record<string, unknown>,
) {
  await db.insert(mcpServer).values({
    userId,
    name,
    type,
    config: JSON.stringify(config),
  });
}

export async function updateMcpServer(
  userId: string,
  name: string,
  config: Record<string, unknown>,
) {
  await db.update(mcpServer)
    .set({ config: JSON.stringify(config), updatedAt: new Date() })
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)));
}

export async function deleteMcpServer(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)))
    .returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function setMcpServerEnabled(userId: string, name: string, enabled: boolean) {
  await db.update(mcpServer)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)));
}
