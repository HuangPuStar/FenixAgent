import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

mock.module("../services/team", () => ({
  getAuthContext: async () => ({ teamId: "d0000000-0000-0000-0000-000000000005", userId: "test-user", role: "owner" }),
  getAuthContextByTeamId: async () => ({ teamId: "d0000000-0000-0000-0000-000000000005", userId: "test-user", role: "owner" }),
  ensurePersonalTeam: async () => {},
  listMyTeams: async () => [],
  getTeamDetail: async () => null,
  createTeam: async () => null,
  switchTeam: async () => null,
  addMember: async () => {},
  removeMember: async () => false,
  updateRole: async () => false,
  getTeamMembers: async () => [],
  updateTeam: async () => false,
  deleteTeam: async () => false,
}));

import Elysia from "elysia";
import { db } from "../db";
import { user as userTable, team as teamTable } from "../db/schema";
import { eq } from "drizzle-orm";
import { resetAllRepos, environmentRepo, sessionRepo } from "../repositories";
import { deleteEnvironment } from "../services/environment";

const TEST_TEAM_ID = "d0000000-0000-0000-0000-000000000005";

async function ensureUser() {
    const existing = await db.select().from(userTable).where(eq(userTable.id, "test-user")).limit(1);
    if (existing.length > 0) return;
    const now = new Date();
    await db.insert(userTable).values({
        id: "test-user",
        name: "Test",
        email: "test@test.com",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
    });
}

async function ensureTeam() {
    const [existing] = await db.select().from(teamTable).where(eq(teamTable.id, TEST_TEAM_ID));
    if (!existing) {
        const now = new Date();
        await db.insert(teamTable).values({
            id: TEST_TEAM_ID,
            name: "Files Route Test Team",
            slug: "files-route-test-team",
            createdBy: "test-user",
            createdAt: now,
            updatedAt: now,
        });
    }
}

await ensureUser();
await ensureTeam();

let workspaceDir = "";

function request(app: Elysia, path: string, init?: RequestInit) {
    return app.handle(new Request(`http://localhost${path}`, init));
}

describe("Files Route", () => {
    let app: Elysia;
    let sessionId: string;
    let envId: string;

    beforeEach(async () => {
        workspaceDir = await mkdtemp(join(tmpdir(), "rcs-files-test-"));
        await mkdir(join(workspaceDir, "user"), { recursive: true });

        resetAllRepos();

        // Create real environment and session with test workspace
        const env = await environmentRepo.create({
            userId: "test-user",
            teamId: TEST_TEAM_ID,
            workspacePath: workspaceDir,
            status: "active",
        });
        envId = env.id;
        const session = await sessionRepo.create({ environmentId: env.id });
        sessionId = session.id;

        const mod = await import("../routes/web/files");
        app = new Elysia();
        app.use(mod.default);
    });

    afterAll(async () => {
        if (workspaceDir) {
            await rm(workspaceDir, { recursive: true, force: true });
        }
    });

    test("default empty path still resolves to user/", async () => {
        await writeFile(join(workspaceDir, "user", "hello.txt"), "Hello World");
        const res = await request(app, `/web/environments/${envId}/user`);
        expect(res.status).toBe(200);
        const body = await res.json();
        const helloFile = body.entries.find(
            (entry: any) => entry.name === "hello.txt",
        );
        expect(helloFile.path).toBe("user/hello.txt");
    });

    test("GET /:sessionId/user — 404 for invalid session without environment", async () => {
        // Delete the specific environment and clear sessions so no fallback is available
        await deleteEnvironment(envId);
        resetAllRepos();
        // Also delete any other environments for this user to prevent fallback
        for (const env of await environmentRepo.listByUserId("test-user")) {
            await deleteEnvironment(env.id);
        }
        const res = await request(app, `/web/environments/invalid-session/user`, {
            headers: { "Content-Type": "application/json" },
        });
        expect(res.status).toBe(404);
    });

    test("PUT /:sessionId/user/* — writes file content", async () => {
        const res = await request(
            app,
            `/web/environments/${envId}/user/notes.txt`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: "Test content" }),
            },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.path).toBe("user/notes.txt");

        const content = await readFile(
            join(workspaceDir, "user", "notes.txt"),
            "utf-8",
        );
        expect(content).toBe("Test content");
    });

    test("GET /:sessionId/user/* — reads written file", async () => {
        await writeFile(join(workspaceDir, "user", "readme.md"), "# Readme");
        const res = await request(
            app,
            `/web/environments/${envId}/user/readme.md`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.name).toBe("readme.md");
        expect(body.content).toBe("# Readme");
    });

    test("DELETE /:sessionId/user/* — deletes a file", async () => {
        await writeFile(join(workspaceDir, "user", "temp.txt"), "to delete");
        const res = await request(
            app,
            `/web/environments/${envId}/user/temp.txt`,
            {
                method: "DELETE",
            },
        );
        expect(res.status).toBe(200);
        await expect(
            readFile(join(workspaceDir, "user", "temp.txt"), "utf-8"),
        ).rejects.toThrow();
    });

    test(".scheduled-runs path can be listed", async () => {
        await mkdir(join(workspaceDir, ".scheduled-runs", "task_1", "run_1"), {
            recursive: true,
        });
        await writeFile(
            join(
                workspaceDir,
                ".scheduled-runs",
                "task_1",
                "run_1",
                "report.md",
            ),
            "# Report",
        );

        const res = await request(
            app,
            `/web/environments/${envId}/user?path=.scheduled-runs/task_1/run_1`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.entries.length).toBe(1);
        expect(body.entries[0].path).toBe(
            ".scheduled-runs/task_1/run_1/report.md",
        );
    });

    test(".scheduled-runs file can be read", async () => {
        await mkdir(join(workspaceDir, ".scheduled-runs", "task_1", "run_1"), {
            recursive: true,
        });
        await writeFile(
            join(
                workspaceDir,
                ".scheduled-runs",
                "task_1",
                "run_1",
                "report.md",
            ),
            "# Report",
        );

        const res = await request(
            app,
            `/web/environments/${envId}/user/.scheduled-runs/task_1/run_1/report.md`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.path).toBe(".scheduled-runs/task_1/run_1/report.md");
        expect(body.content).toBe("# Report");
    });

    test("path traversal is blocked for workspace root and user root", async () => {
        const listRes = await request(
            app,
            `/web/environments/${envId}/user?path=../../../etc`,
        );
        expect(listRes.status).toBe(404);

        const putRes = await request(
            app,
            `/web/environments/${envId}/user/../../../etc/evil.txt`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: "hack" }),
            },
        );
        expect(putRes.status).toBe(404);
    });

    test("workspace-root write requests are rejected", async () => {
        const putRes = await request(
            app,
            `/web/environments/${envId}/user/.scheduled-runs/task_1/run_1/report.md`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: "hack" }),
            },
        );
        expect(putRes.status).toBe(400);
    });

    test("DELETE /:sessionId/user/* — 400 when trying to delete directory", async () => {
        await mkdir(join(workspaceDir, "user", "subdir"), { recursive: true });
        const res = await request(
            app,
            `/web/environments/${envId}/user/subdir`,
            {
                method: "DELETE",
            },
        );
        expect(res.status).toBe(400);
    });

    test("path traversal — DELETE with ../ returns 404", async () => {
        const res = await request(
            app,
            `/web/environments/${envId}/user/../../../etc/passwd`,
            {
                method: "DELETE",
            },
        );
        expect(res.status).toBe(404);
    });

    test("POST /:sessionId/user/* — uploads files", async () => {
        const formData = new FormData();
        formData.append("files", new File(["file content"], "upload.txt"));
        const res = await request(app, `/web/environments/${envId}/user/`, {
            method: "POST",
            body: formData,
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.files).toBeDefined();
        expect(body.files.length).toBe(1);
        expect(body.files[0].name).toBe("upload.txt");
        expect(body.files[0].path).toBe("user/upload.txt");

        const content = await readFile(
            join(workspaceDir, "user", "upload.txt"),
            "utf-8",
        );
        expect(content).toBe("file content");
    });
});
