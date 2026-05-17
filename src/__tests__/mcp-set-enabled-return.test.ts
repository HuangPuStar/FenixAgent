// 测试 setMcpServerEnabled 返回 boolean
import { describe, test, expect, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { mcpServer, team, user } from "../db/schema";
import { setMcpServerEnabled } from "../services/config/mcp-server";

const TEST_USER_ID = "user_mcp_set_enabled";
const TEST_TEAM_SLUG = "mcp-set-enabled-team";
let TEST_TEAM_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "MCP Set Enabled", email: "mcp-set-enabled@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "MCP Set Enabled Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
  TEST_TEAM_ID = created.id;
}

await ensureTeam();

describe("setMcpServerEnabled boolean return", () => {
  afterAll(async () => {
    if (TEST_TEAM_ID) {
      try { await db.delete(mcpServer).where(eq(mcpServer.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(team).where(eq(team.id, TEST_TEAM_ID)); } catch {}
    }
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
  });

  // 存在的 server 返回 true
  test("returns true when server exists", async () => {
    await db.insert(mcpServer).values({
      userId: TEST_USER_ID, teamId: TEST_TEAM_ID!,
      name: "my-server", type: "local",
      config: { command: ["npx", "test"] }, enabled: true, updatedAt: new Date(),
    });
    const result = await setMcpServerEnabled({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "my-server", true);
    expect(result).toBe(true);
  });

  // 不存在的 server 返回 false
  test("returns false when server does not exist", async () => {
    const result = await setMcpServerEnabled({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "nonexistent-server-xyz", false);
    expect(result).toBe(false);
  });
});
