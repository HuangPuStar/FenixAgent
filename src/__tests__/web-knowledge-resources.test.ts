import { beforeEach, afterEach, describe, expect, test } from "bun:test";

import { default as Elysia } from "elysia";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { knowledgeBase, knowledgeResource, user, team } from "../db/schema";
import webKnowledgeBases from "../routes/web/knowledge-bases";
import { setKnowledgeProviderForTesting } from "../services/knowledge-base";
import { setKnowledgeUploadProviderForTesting } from "../services/knowledge-upload";
import { setTestAuth, resetTestAuth } from "../plugins/auth";
import { setTestTeamContext } from "../services/team-context";

// 固定的测试团队 UUID
const TEST_TEAM_ID = "a0000000-0000-0000-0000-000000000002";
const TEST_USER_ID = "kb-user-1";

const testApp = new Elysia().use(webKnowledgeBases);

function request(path: string, init?: RequestInit) {
  return testApp.handle(new Request(`http://localhost${path}`, init));
}

const fakeProvider = {
  async createKnowledgeBase() {
    return {
      remoteId: null,
      name: "unused",
      status: "empty" as const,
      description: null,
      lastError: null,
    };
  },
  async addResource(input: { url?: string; sourceName?: string }) {
    if (input.url) {
      throw new Error("remote import failed");
    }
    return {
      remoteId: `viking://resources/kb_upload/${input.sourceName}`,
      knowledgeBaseRemoteId: "viking://resources/kb_upload/",
      sourceName: input.sourceName || "upload.bin",
      sourceType: "upload",
      source: null,
      status: "processing" as const,
      lastError: null,
    };
  },
  async listResources() {
    return [];
  },
  async deleteResource() {
    return;
  },
  async search() {
    return [];
  },
  async readResource() {
    return { resourceId: "unused", content: "" };
  },
};

async function ensureUser() {
  const now = new Date();
  const [existing] = await db.select().from(user).where(eq(user.id, TEST_USER_ID));
  if (!existing) {
    await db.insert(user).values({
      id: TEST_USER_ID,
      name: "KB User",
      email: "kb@test.com",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** 确保测试团队存在 */
async function ensureTeam() {
  const [existing] = await db.select().from(team).where(eq(team.id, TEST_TEAM_ID));
  if (!existing) {
    const now = new Date();
    await db.insert(team).values({
      id: TEST_TEAM_ID,
      name: "KB Resource Test Team",
      slug: "kb-resource-test-team",
      createdBy: TEST_USER_ID,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** 插入测试知识库，返回完整行（含自动生成的 UUID id） */
let seededKbId: string;
async function seedKnowledgeBase() {
  const now = new Date();
  const [row] = await db.insert(knowledgeBase).values({
    userId: TEST_USER_ID,
    teamId: TEST_TEAM_ID,
    name: "Docs",
    slug: "docs",
    description: null,
    provider: "openviking",
    remoteId: null,
    status: "empty",
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  seededKbId = row.id;
}

describe("Knowledge resource routes", () => {
  beforeEach(async () => {
    setTestAuth({
      user: { id: TEST_USER_ID, email: "kb@test.com", name: "KB User" },
      authContext: { teamId: TEST_TEAM_ID, userId: TEST_USER_ID, role: "owner" },
    });
    setTestTeamContext({ teamId: TEST_TEAM_ID, userId: TEST_USER_ID, role: "owner" });
    setKnowledgeProviderForTesting(fakeProvider as any);
    setKnowledgeUploadProviderForTesting(fakeProvider as any);
    await db.delete(knowledgeResource);
    await db.delete(knowledgeBase);
    await db.delete(user).where(eq(user.id, TEST_USER_ID));
    await ensureUser();
    await ensureTeam();
    await seedKnowledgeBase();
  });

  afterEach(() => {
    resetTestAuth();
    setTestTeamContext(null);
  });

  test("multipart upload creates pending/processing resource with sourcePath", async () => {
    const form = new FormData();
    form.append("files", new File(["# Guide"], "guide.md", { type: "text/markdown" }));

    const response = await request(`/web/knowledgeBases/${seededKbId}/resources/upload`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(["pending", "processing"]).toContain(body.items[0].status);
    expect(body.items[0].sourcePath).toContain("data/knowledge-upload");
  });

  test("URL import failure writes lastError and marks knowledge base error", async () => {
    const response = await request(`/web/knowledgeBases/${seededKbId}/resources/url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/spec.md",
        sourceName: "spec.md",
      }),
    });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.lastError).toBe("remote import failed");

    const [kbRow] = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, seededKbId));
    expect(kbRow.status).toBe("error");
    expect(kbRow.lastError).toBe("remote import failed");
  });

  test("GET resources returns rows ordered by updatedAt desc", async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 10_000);
    await db.insert(knowledgeResource).values([
      {
        knowledgeBaseId: seededKbId,
        sourceType: "upload",
        sourceName: "old.md",
        sourcePath: "/tmp/old.md",
        remoteId: "remote-old",
        status: "ready",
        lastError: null,
        createdAt: earlier,
        updatedAt: earlier,
      },
      {
        knowledgeBaseId: seededKbId,
        sourceType: "url",
        sourceName: "new.md",
        sourcePath: "https://example.com/new.md",
        remoteId: "remote-new",
        status: "processing",
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const response = await request(`/web/knowledgeBases/${seededKbId}/resources`);
    expect(response.status).toBe(200);
    const body = await response.json();
    // 按 updatedAt desc 排序，new 在前
    expect(body.length).toBe(2);
    expect(new Date(body[0].updatedAt).getTime()).toBeGreaterThan(new Date(body[1].updatedAt).getTime());
  });

  test("DELETE resource removes row and calls provider for remote resources", async () => {
    const deleteCalls: string[] = [];
    setKnowledgeUploadProviderForTesting({
      ...fakeProvider,
      async deleteResource(input: { resourceRemoteId: string }) {
        deleteCalls.push(input.resourceRemoteId);
      },
    } as any);
    const now = new Date();
    const [res] = await db.insert(knowledgeResource).values({
      knowledgeBaseId: seededKbId,
      sourceType: "upload",
      sourceName: "delete.md",
      sourcePath: "/tmp/delete.md",
      remoteId: "viking://resources/kb_upload/delete.md",
      status: "ready",
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const response = await request(`/web/knowledgeBases/${seededKbId}/resources/${res.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(deleteCalls).toEqual(["viking://resources/kb_upload/delete.md"]);
    const rows = await db.select().from(knowledgeResource).where(eq(knowledgeResource.id, res.id));
    expect(rows).toHaveLength(0);
  });

  test("multipart upload retries without parent when stored remoteId no longer exists", async () => {
    const retryingProvider = {
      ...fakeProvider,
      async addResource(input: { knowledgeBaseRemoteId?: string; sourceName?: string }) {
        if (input.knowledgeBaseRemoteId) {
          throw new Error(`Parent URI does not exist: ${input.knowledgeBaseRemoteId}`);
        }
        return {
          remoteId: `viking://resources/kb_upload/${input.sourceName}`,
          knowledgeBaseRemoteId: "viking://resources/kb_upload/",
          sourceName: input.sourceName || "upload.bin",
          sourceType: "upload",
          source: null,
          status: "processing" as const,
          lastError: null,
        };
      },
    };
    setKnowledgeUploadProviderForTesting(retryingProvider as any);
    await db.update(knowledgeBase).set({
      remoteId: "viking://resources/kb/legacy/docs/",
      updatedAt: new Date(),
    }).where(eq(knowledgeBase.id, seededKbId));

    const form = new FormData();
    form.append("files", new File(["# Retry"], "retry.md", { type: "text/markdown" }));

    const response = await request(`/web/knowledgeBases/${seededKbId}/resources/upload`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    const [kbRow] = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, seededKbId));
    expect(kbRow.remoteId).toBe("viking://resources/kb_upload/");
  });

  test("multipart upload retries failed files once after parallel pass", async () => {
    const attempts = new Map<string, number>();
    setKnowledgeUploadProviderForTesting({
      ...fakeProvider,
      async addResource(input: { sourceName?: string }) {
        const sourceName = input.sourceName || "upload.bin";
        const current = attempts.get(sourceName) ?? 0;
        attempts.set(sourceName, current + 1);
        if (sourceName === "retry.md" && current === 0) {
          throw new Error("Internal server error");
        }
        return {
          remoteId: `viking://resources/kb_upload/${sourceName}`,
          knowledgeBaseRemoteId: "viking://resources/kb_upload/",
          sourceName,
          sourceType: "upload",
          source: null,
          status: "processing" as const,
          lastError: null,
        };
      },
    } as any);

    const form = new FormData();
    form.append("files", new File(["# Retry"], "retry.md", { type: "text/markdown" }));
    form.append("files", new File(["# Stable"], "stable.md", { type: "text/markdown" }));

    const response = await request(`/web/knowledgeBases/${seededKbId}/resources/upload`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(2);
    expect(attempts.get("retry.md")).toBe(2);
    expect(attempts.get("stable.md")).toBe(1);
    expect(body.items.find((item: any) => item.sourceName === "retry.md")?.status).toBe("processing");
  });

  test("re-uploading the same file reuses the existing resource row instead of creating duplicates", async () => {
    const form = new FormData();
    form.append("files", new File(["# Guide v1"], "guide.md", { type: "text/markdown" }));
    const firstResponse = await request(`/web/knowledgeBases/${seededKbId}/resources/upload`, {
      method: "POST",
      body: form,
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    const firstId = firstBody.items[0].id;

    const secondForm = new FormData();
    secondForm.append("files", new File(["# Guide v2"], "guide.md", { type: "text/markdown" }));
    const secondResponse = await request(`/web/knowledgeBases/${seededKbId}/resources/upload`, {
      method: "POST",
      body: secondForm,
    });
    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    expect(secondBody.items[0].id).toBe(firstId);

    const rows = await db.select().from(knowledgeResource).where(eq(knowledgeResource.knowledgeBaseId, seededKbId));
    expect(rows).toHaveLength(1);
  });
});
