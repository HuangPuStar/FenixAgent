import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock better-auth so sessionAuth passes with a test user.
// Only mock this one module — use real middleware and real store.
mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "test-user", email: "test@test.com", name: "Test" },
        session: { id: "sess_test", userId: "test-user", token: "tok" },
      }),
      signUpEmail: async () => ({}),
    },
  },
}));

import { Hono } from "hono";
import { db } from "../db";
import { user as userTable } from "../db/schema";
import { eq } from "drizzle-orm";
import { storeReset, storeCreateSession, storeCreateEnvironment, storeDeleteEnvironment } from "../store";

// Ensure test user exists in DB
function ensureUser() {
  const existing = db.select().from(userTable).where(eq(userTable.id, "test-user")).limit(1).all();
  if (existing.length > 0) return;
  const now = new Date();
  try {
    db.insert(userTable).values({
      id: "test-user", name: "Test", email: "test@test.com",
      emailVerified: false, createdAt: now, updatedAt: now,
    }).run();
  } catch {}
}
ensureUser();

let workspaceDir: string;

describe("Files Route", () => {
  let app: Hono;
  let sessionId: string;
  let envId: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "rcs-files-test-"));
    await mkdir(join(workspaceDir, "user"), { recursive: true });

    storeReset();

    // Create real environment and session with test workspace
    const env = storeCreateEnvironment({
      userId: "test-user",
      workspacePath: workspaceDir,
      status: "active",
    });
    envId = env.id;
    const session = storeCreateSession({ environmentId: env.id });
    sessionId = session.id;

    // Dynamically import to get fresh module each time
    const mod = await import("../routes/web/files");
    app = new Hono();
    app.route("/web/sessions", mod.default);
  });

  afterAll(async () => {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("GET /:sessionId/user — lists files in directory", async () => {
    await writeFile(join(workspaceDir, "user", "hello.txt"), "Hello World");
    const res = await app.request(`/web/sessions/${sessionId}/user`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toBeDefined();
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    const helloFile = body.entries.find((e: any) => e.name === "hello.txt");
    expect(helloFile).toBeDefined();
    expect(helloFile.type).toBe("file");
  });

  test("GET /:sessionId/user — 404 for invalid session without environment", async () => {
    // Delete the specific environment and clear sessions so no fallback is available
    storeDeleteEnvironment(envId);
    storeReset();
    // Also delete any other environments for this user to prevent fallback
    const { storeListEnvironmentsByUserId } = await import("../store");
    for (const env of storeListEnvironmentsByUserId("test-user")) {
      storeDeleteEnvironment(env.id);
    }
    const res = await app.request(`/web/sessions/invalid-session/user`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("PUT /:sessionId/user/* — writes file content", async () => {
    const res = await app.request(`/web/sessions/${sessionId}/user/notes.txt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Test content" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("notes.txt");
    expect(body.path).toBe("notes.txt");

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(workspaceDir, "user", "notes.txt"), "utf-8");
    expect(content).toBe("Test content");
  });

  test("GET /:sessionId/user/* — reads written file", async () => {
    await writeFile(join(workspaceDir, "user", "readme.md"), "# Readme");
    const res = await app.request(`/web/sessions/${sessionId}/user/readme.md`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("readme.md");
    expect(body.content).toBe("# Readme");
    expect(body.encoding).toBe("utf-8");
  });

  test("DELETE /:sessionId/user/* — deletes a file", async () => {
    await writeFile(join(workspaceDir, "user", "temp.txt"), "to delete");
    const res = await app.request(`/web/sessions/${sessionId}/user/temp.txt`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const { stat } = await import("node:fs/promises");
    await expect(stat(join(workspaceDir, "user", "temp.txt"))).rejects.toThrow();
  });

  test("DELETE /:sessionId/user/* — 400 when trying to delete directory", async () => {
    await mkdir(join(workspaceDir, "user", "subdir"), { recursive: true });
    const res = await app.request(`/web/sessions/${sessionId}/user/subdir`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Cannot delete directories");
  });

  test("path traversal — GET with ../ returns 404", async () => {
    const res = await app.request(`/web/sessions/${sessionId}/user?path=../../../etc`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("path traversal — PUT with ../ returns 404", async () => {
    const res = await app.request(`/web/sessions/${sessionId}/user/../../../etc/evil.txt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hack" }),
    });
    expect(res.status).toBe(404);
  });

  test("path traversal — DELETE with ../ returns 404", async () => {
    const res = await app.request(`/web/sessions/${sessionId}/user/../../../etc/passwd`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  test("POST /:sessionId/user/* — uploads files", async () => {
    const formData = new FormData();
    formData.append("files", new File(["file content"], "upload.txt"));
    const res = await app.request(`/web/sessions/${sessionId}/user/`, {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toBeDefined();
    expect(body.files.length).toBe(1);
    expect(body.files[0].name).toBe("upload.txt");

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(workspaceDir, "user", "upload.txt"), "utf-8");
    expect(content).toBe("file content");
  });
});
