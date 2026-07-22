import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import webApiKeysRoute from "../routes/web/api-keys";
import { resetAllStubs, stubAuthApi } from "../test-utils/helpers";

describe("web api-keys routes", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "user-1", email: "user-1@fenix.com", name: "user-1" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
  });

  afterEach(() => {
    resetAllStubs();
    resetTestAuth();
  });

  // 创建 API key 时，重名应被后端拦截，避免列表中出现无法区分的同名项。
  test("POST /web/api-keys rejects duplicate names", async () => {
    let createCalls = 0;

    stubAuthApi({
      listApiKeys: async () => ({
        apiKeys: [{ id: "key-1", name: "duplicate-key", prefix: "rcs_" }],
      }),
      createApiKey: async () => {
        createCalls += 1;
        return { id: "new-key", name: "duplicate-key", prefix: "rcs_", key: "plaintext" };
      },
    });

    const response = await webApiKeysRoute.handle(
      new Request("http://localhost/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "duplicate-key" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(createCalls).toBe(0);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: {
        code: "DUPLICATE_API_KEY_NAME",
        message: "API key name already exists",
      },
    });
  });

  // 创建 API key 时，非重名名称应继续走正常创建链路。
  test("POST /web/api-keys creates key when name is unique", async () => {
    const createBodies: Array<Record<string, unknown>> = [];

    stubAuthApi({
      listApiKeys: async () => ({
        apiKeys: [{ id: "key-1", name: "existing-key", prefix: "rcs_" }],
      }),
      createApiKey: async ({ body }: { body: Record<string, unknown> }) => {
        createBodies.push(body);
        return {
          id: "key-2",
          name: body.name,
          prefix: "rcs_",
          key: "plaintext-key",
          metadata: body.metadata,
        };
      },
    });

    const response = await webApiKeysRoute.handle(
      new Request("http://localhost/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-key" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(createBodies).toEqual([
      {
        name: "new-key",
        prefix: "rcs_",
        expiresIn: null,
        metadata: {
          organizationId: "org-1",
          role: "owner",
        },
      },
    ]);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: {
        id: "key-2",
        name: "new-key",
        prefix: "rcs_",
        key: "plaintext-key",
        metadata: {
          organizationId: "org-1",
          role: "owner",
        },
      },
    });
  });
});
