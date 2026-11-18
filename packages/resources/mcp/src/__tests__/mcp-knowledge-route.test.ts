import { afterEach, describe, expect, mock, test } from "bun:test";
import { resetAgentRuntimePort, stubAgentRuntimePort } from "@fenix/agent-runtime/server/testing";
import { readJson, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { KnowledgeRuntimeAccessError, setKnowledgeRuntimeProviderForTesting } from "@fenix/resource-knowledge/server";
import { initializeKnowledgeModuleConfig } from "@fenix/resource-knowledge/server/testing";
import knowledgeMcpRoutes, { mapKnowledgeAccessError } from "../server/routes/mcp/knowledge";

/**
 * `/mcp/knowledge` 的鉴权拒绝路径。
 *
 * 该入口是整包唯一的模块级单例路由（Bearer environment secret 自鉴权，见路由文件注释），此前
 * 没有任何用例覆盖它的 401 分支——包括宿主侧（`apps/server/src/__tests__` 无该端点的用例）。
 * 本次把错误体从宿主 `errorResponse` 装饰器改为平台统一信封（`ApiErrorResponseSchema`），
 * 因此这里钉住新形状，避免协议面在无测试的情况下漂移。
 *
 * 只覆盖「缺 token」两条分支：需要 token 但格式/内容无效（`Invalid bearer token`）的分支要经
 * `getEnvironmentBySecret` 查库，属宿主基础设施范围，不在本包用例内复刻（README「已知项」记录）。
 */

/** 直接向单例路由发起请求；路径与宿主挂载点一致（`/mcp/knowledge` 无前缀）。 */
function request(headers: Record<string, string> = {}) {
  return knowledgeMcpRoutes.handle(new Request("http://localhost/mcp/knowledge", { method: "POST", headers }));
}

describe("mcp knowledge 入口鉴权", () => {
  // 头缺失由请求头 schema 拦下（422），不会进入处理器：该端点的鉴权输入是头，不是可选参数。
  // 这是既有行为（与错误信封改造无关），用例只钉住它，不做语义变更。
  test("缺少 authorization 头时被请求头 schema 拦下（422）", async () => {
    expect((await request()).status).toBe(422);
  });

  // `Bearer` 后只有空白等同缺 token：不能把空串当作 secret 去查 environment。
  test("Bearer 后只有空白视为缺少 token，返回 401 与平台错误信封", async () => {
    const response = await request({ authorization: "Bearer   " });

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      error: { code: "UNAUTHORIZED", message: "Missing bearer token" },
    });
  });
});

describe("mcp knowledge 授权错误", () => {
  test("将知识运行时授权拒绝映射为稳定的工具错误", () => {
    const result = mapKnowledgeAccessError(
      new KnowledgeRuntimeAccessError("KNOWLEDGE_BINDING_REQUIRED", "resource is not bound"),
    );

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "KNOWLEDGE_BINDING_REQUIRED",
            message: "知识资源不属于当前 Agent 绑定的知识库",
          }),
        },
      ],
      structuredContent: {
        code: "KNOWLEDGE_BINDING_REQUIRED",
        message: "知识资源不属于当前 Agent 绑定的知识库",
      },
    });
  });
});

describe("MCP 知识工具授权链", () => {
  const search = mock(async () => []);
  const readResource = mock(async () => ({ content: "文档", chunkCount: 1 }));
  const getKnowledgeGraph = mock(async () => null);

  afterEach(() => {
    setKnowledgeRuntimeProviderForTesting(null);
    resetAllStubs();
    resetAgentRuntimePort();
    search.mockClear();
    readResource.mockClear();
    getKnowledgeGraph.mockClear();
  });

  async function callTool(
    name: string,
    args: Record<string, string>,
    userId: string | null,
    organizationId: string | null,
    mode: "owner" | "trusted-delegate",
    remoteId: string | null = "remote-1",
  ) {
    initializeKnowledgeModuleConfig({ runtimeAuthMode: mode, ragflowApiKey: "test-key" });
    stubAgentRuntimePort({
      getEnvironmentBySecret: async (secret) => ({
        id: "env-1",
        agentConfigId: "agent-1",
        userId,
        organizationId,
        secret,
      }),
    });
    const binding = {
      kbId: "kb-1",
      kbRemoteId: remoteId,
      kbUserId: "owner-1",
      kbOrganizationId: "org-provider",
      priority: 0,
    };
    const resource = {
      id: "resource-1",
      knowledgeBaseId: "kb-1",
      remoteId: "remote-resource",
      kbRemoteId: "remote-1",
      kbUserId: "owner-1",
      kbOrganizationId: "org-provider",
    };
    stubDb({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => Object.assign(Promise.resolve([binding]), { limit: async () => [resource] }),
          }),
        }),
      }),
    });
    const provider = new Proxy(
      {},
      {
        get: (_target, key) =>
          ({ search, readResource, getKnowledgeGraph })[key as "search" | "readResource" | "getKnowledgeGraph"],
      },
    );
    setKnowledgeRuntimeProviderForTesting(
      provider as NonNullable<Parameters<typeof setKnowledgeRuntimeProviderForTesting>[0]>,
    );
    const response = await knowledgeMcpRoutes.handle(
      new Request("http://localhost/mcp/knowledge", {
        method: "POST",
        headers: {
          authorization: "Bearer test-secret",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()).result;
  }

  for (const [name, args] of [
    ["kb_search", { query: "问题" }],
    ["kb_read", { resourceId: "resource-1" }],
    ["kb_graph_get", { knowledgeBaseId: "kb-1" }],
  ] as const) {
    // 上层允许跨组织使用时，三个工具都能访问已绑定知识库。
    test(`${name} 允许跨组织绑定`, async () => {
      const result = await callTool(name, args, "user-1", "org-caller", "trusted-delegate");
      expect(result.isError).not.toBe(true);
      const expectedProvider = name === "kb_search" ? search : name === "kb_read" ? readResource : getKnowledgeGraph;
      expect(expectedProvider).toHaveBeenCalledTimes(1);
    });

    // 缺失用户身份不能以空结果或成功响应代替授权拒绝。
    test(`${name} 拒绝缺失身份`, async () => {
      const result = await callTool(name, args, null, "org-provider", "trusted-delegate");
      expect(result.isError).toBe(true);
      expect(result.structuredContent.code).toBe("KNOWLEDGE_RUNTIME_IDENTITY_REQUIRED");
      expect(search).not.toHaveBeenCalled();
      expect(readResource).not.toHaveBeenCalled();
      expect(getKnowledgeGraph).not.toHaveBeenCalled();
    });

    // 委派模式缺少组织上下文时必须在访问 Provider 之前失败关闭。
    test(`${name} 拒绝缺失组织`, async () => {
      const result = await callTool(name, args, "user-1", null, "trusted-delegate");
      expect(result.isError).toBe(true);
      expect(result.structuredContent.code).toBe("KNOWLEDGE_RUNTIME_ORGANIZATION_REQUIRED");
      expect(search).not.toHaveBeenCalled();
      expect(readResource).not.toHaveBeenCalled();
      expect(getKnowledgeGraph).not.toHaveBeenCalled();
    });
  }

  // 默认模式继续允许跨组织运行公开 Agent 的知识检索。
  test("owner 模式保留跨组织绑定检索", async () => {
    const result = await callTool("kb_search", { query: "问题" }, "user-1", "org-caller", "owner");
    expect(result.isError).not.toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  // 无远端定位时 MCP 应返回中性错误，不能猜测同步状态。
  test("图谱查询返回知识库不可用错误", async () => {
    const result = await callTool(
      "kb_graph_get",
      { knowledgeBaseId: "kb-1" },
      "user-1",
      "org-provider",
      "trusted-delegate",
      null,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "KNOWLEDGE_BASE_UNAVAILABLE",
      message: "知识库不存在或当前无法访问",
    });
    expect(getKnowledgeGraph).not.toHaveBeenCalled();
  });
});
