// R34: config/mcp-server.ts countToolsByServer Number() 类型转换
import { describe, test, expect, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { mcpServer, mcpTool, team, user } from "../db/schema";
import { countToolsByServer } from "../services/config/mcp-server";

const TEST_USER_ID = "user_mcp_count_coerce";
const TEST_TEAM_SLUG = "mcp-count-coerce-team";
const UNIQUE_SERVER = `test-count-server-${Date.now()}`;
let TEST_TEAM_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "MCP Count Coerce", email: "mcp-count-coerce@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "MCP Count Coerce Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
  TEST_TEAM_ID = created.id;
}

await ensureTeam();

describe("countToolsByServer Number() 类型转换", () => {
  afterAll(async () => {
    if (TEST_TEAM_ID) {
      try { await db.delete(mcpTool).where(eq(mcpTool.serverName, UNIQUE_SERVER)); } catch {}
      try { await db.delete(mcpServer).where(eq(mcpServer.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(team).where(eq(team.id, TEST_TEAM_ID)); } catch {}
    }
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
  });

  // 空结果返回 0
  test("不存在 server 返回 0", async () => {
    const result = await countToolsByServer("nonexistent-server-xyz");
    expect(result).toBe(0);
    expect(typeof result).toBe("number");
  });

  // 有 tools 时返回正确数量
  test("有 tools 时返回正确数量", async () => {
    await db.insert(mcpServer).values({
      userId: TEST_USER_ID, teamId: TEST_TEAM_ID!,
      name: UNIQUE_SERVER, type: "local",
      config: { command: ["npx", "test"] }, enabled: true, updatedAt: new Date(),
    });

    for (let i = 0; i < 3; i++) {
      await db.insert(mcpTool).values({
        serverName: UNIQUE_SERVER,
        toolName: `tool_${i}`, description: null, inputSchema: null,
      });
    }

    const result = await countToolsByServer(UNIQUE_SERVER);
    expect(result).toBe(3);
    expect(typeof result).toBe("number");
  });
});
