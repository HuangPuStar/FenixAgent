import { describe, expect, test } from "bun:test";
import { createLiteLlmAdapter } from "@fenix/model-gateway-litellm";

describe("LiteLLM virtual key adapter", () => {
  // 验证主体归属由 metadata 保存，避免已禁用的同名 Key 阻止后续重建。
  test("creates a virtual key without sending a key alias", async () => {
    let request: Request | undefined;
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ key: "sk-generated-key", token: "litellm-key-id", user_id: "gateway-user-1" });
      },
    });

    await expect(
      adapter.createCredential({
        externalUserId: "gateway-user-1",
        metadata: { organizationId: "org-1", agentConfigId: "agent-1" },
      }),
    ).resolves.toEqual({ externalId: "litellm-key-id", secret: "sk-generated-key" });
    expect(request?.url).toBe("http://litellm.test/key/generate");
    expect(await request?.json()).toEqual({
      user_id: "gateway-user-1",
      metadata: { organizationId: "org-1", agentConfigId: "agent-1" },
      key_type: "llm_api",
    });
  });

  // 验证禁用 Virtual Key 使用 block 而非删除，模型访问不通过 Key 级接口维护。
  test("blocks a virtual key without updating a model allowlist", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({});
      },
    });

    await adapter.blockCredential("litellm-key-id");

    expect(await requests[0]?.json()).toEqual({ key: "litellm-key-id" });
    expect(requests.map((item) => new URL(item.url).pathname)).toEqual(["/key/block"]);
  });
});
