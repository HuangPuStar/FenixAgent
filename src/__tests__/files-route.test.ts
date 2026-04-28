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

import { Hono } from "hono";
import { db } from "../db";
import { user as userTable } from "../db/schema";
import { eq } from "drizzle-orm";
import {
    storeCreateEnvironment,
    storeCreateSession,
    storeReset,
    storeDeleteEnvironment,
} from "../store";

function ensureUser() {
    const existing = db
        .select()
        .from(userTable)
        .where(eq(userTable.id, "test-user"))
        .limit(1)
        .all();
    if (existing.length > 0) return;
    const now = new Date();
    db.insert(userTable)
        .values({
            id: "test-user",
            name: "Test",
            email: "test@test.com",
            emailVerified: false,
            createdAt: now,
            updatedAt: now,
        })
        .run();
}
ensureUser();

let workspaceDir = "";

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

        const mod = await import("../routes/web/files");
        app = new Hono();
        app.route("/web/sessions", mod.default);
    });

    afterAll(async () => {
        if (workspaceDir) {
            await rm(workspaceDir, { recursive: true, force: true });
        }
    });

    test("default empty path still resolves to user/", async () => {
        await writeFile(join(workspaceDir, "user", "hello.txt"), "Hello World");
        const res = await app.request(`/web/sessions/${sessionId}/user`);
        expect(res.status).toBe(200);
        const body = await res.json();
        const helloFile = body.entries.find(
            (entry: any) => entry.name === "hello.txt",
        );
        expect(helloFile.path).toBe("user/hello.txt");
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
        const res = await app.request(
            `/web/sessions/${sessionId}/user/notes.txt`,
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
        const res = await app.request(
            `/web/sessions/${sessionId}/user/readme.md`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.name).toBe("readme.md");
        expect(body.content).toBe("# Readme");
    });

    test("DELETE /:sessionId/user/* — deletes a file", async () => {
        await writeFile(join(workspaceDir, "user", "temp.txt"), "to delete");
        const res = await app.request(
            `/web/sessions/${sessionId}/user/temp.txt`,
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

        const res = await app.request(
            `/web/sessions/${sessionId}/user?path=.scheduled-runs/task_1/run_1`,
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

        const res = await app.request(
            `/web/sessions/${sessionId}/user/.scheduled-runs/task_1/run_1/report.md`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.path).toBe(".scheduled-runs/task_1/run_1/report.md");
        expect(body.content).toBe("# Report");
    });

    test("path traversal is blocked for workspace root and user root", async () => {
        const listRes = await app.request(
            `/web/sessions/${sessionId}/user?path=../../../etc`,
        );
        expect(listRes.status).toBe(404);

        const putRes = await app.request(
            `/web/sessions/${sessionId}/user/../../../etc/evil.txt`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: "hack" }),
            },
        );
        expect(putRes.status).toBe(404);
    });

    test("workspace-root write requests are rejected", async () => {
        const putRes = await app.request(
            `/web/sessions/${sessionId}/user/.scheduled-runs/task_1/run_1/report.md`,
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
        const res = await app.request(
            `/web/sessions/${sessionId}/user/subdir`,
            {
                method: "DELETE",
            },
        );
        expect(res.status).toBe(400);
    });

    test("path traversal — DELETE with ../ returns 404", async () => {
        const res = await app.request(
            `/web/sessions/${sessionId}/user/../../../etc/passwd`,
            {
                method: "DELETE",
            },
        );
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
        expect(body.files[0].path).toBe("user/upload.txt");

        const content = await readFile(
            join(workspaceDir, "user", "upload.txt"),
            "utf-8",
        );
        expect(content).toBe("file content");
    });
});
