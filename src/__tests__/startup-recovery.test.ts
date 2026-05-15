import { describe, test, expect, beforeEach } from "bun:test";
import { resetAllRepos, sessionRepo } from "../repositories";
import { db } from "../db";
import { agentSession } from "../db/schema";
import { eq } from "drizzle-orm";

describe("Startup recovery - sessionRepo.loadFromDB", () => {
  beforeEach(async () => {
    resetAllRepos();
    await db.delete(agentSession);
  });

  test("restores sessions from DB to memory", async () => {
    // Insert 2 records directly into DB
    const now = new Date();
    await db.insert(agentSession).values([
      { id: "session_test1", status: "idle", source: "acp", shareMode: "none", createdAt: now, updatedAt: now, title: "Restored 1", cwd: "/home/test1" },
      { id: "session_test2", status: "running", source: "web", shareMode: "none", createdAt: now, updatedAt: now, title: "Restored 2", cwd: null },
    ]);

    await sessionRepo.loadFromDB();
    expect((await sessionRepo.listAll()).length).toBe(2);

    const s1 = await sessionRepo.getById("session_test1");
    expect(s1).toBeDefined();
    expect(s1!.title).toBe("Restored 1");
    expect(s1!.cwd).toBe("/home/test1");
    expect(s1!.status).toBe("idle");

    const s2 = await sessionRepo.getById("session_test2");
    expect(s2).toBeDefined();
    expect(s2!.status).toBe("running");
    expect(s2!.cwd).toBeNull();
  });

  // DB 为空时不恢复任何 session
  test("does nothing when DB is empty", async () => {
    await sessionRepo.loadFromDB();
    expect((await sessionRepo.listAll()).length).toBe(0);
  });

  // 恢复的 session 可以查询和更新
  test("restored sessions can be queried and updated", async () => {
    const now = new Date();
    await db.insert(agentSession).values({
      id: "session_updatable", status: "idle", source: "acp", shareMode: "none", createdAt: now, updatedAt: now,
    });

    await sessionRepo.loadFromDB();

    // Can query
    const session = await sessionRepo.getById("session_updatable");
    expect(session).toBeDefined();
    expect(session!.status).toBe("idle");

    // Can update (both memory and DB)
    await sessionRepo.update("session_updatable", { title: "updated title" });
    const updated = await sessionRepo.getById("session_updatable");
    expect(updated!.title).toBe("updated title");

    // Verify DB also updated
    const dbRow = await db.select().from(agentSession).where(eq(agentSession.id, "session_updatable"));
    expect(dbRow.length).toBe(1);
    expect(dbRow[0].title).toBe("updated title");
  });
});
