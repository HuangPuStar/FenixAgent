import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpResourceLike } from "../lib/mcp-resource-access";
import {
  canManageMcpSharing,
  canWriteMcp,
  filterWritableMcps,
  getMcpDisplayName,
  getMcpKey,
  getMcpLookupKey,
  getMcpResourceBadgeKey,
  isExternalMcp,
} from "../lib/mcp-resource-access";

const ACTIVE_ORG_ID = "org-current";

/** 本组织私有 MCP：归属当前组织，带 update 动作。 */
function internalMcp(overrides: Partial<McpResourceLike> = {}): McpResourceLike {
  return {
    id: "mcp-internal",
    name: "shared",
    scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" },
    access: { actions: ["read", "update", "delete"] },
    organizationName: "Current Team",
    ...overrides,
  };
}

/** 外部组织公开 MCP：归属其他组织，只有读动作。 */
function externalMcp(overrides: Partial<McpResourceLike> = {}): McpResourceLike {
  return {
    id: "mcp-external",
    name: "shared",
    scope: { organizationId: "org-source", visibility: "public" },
    access: { actions: ["read", "use"] },
    organizationName: "Source Team",
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true, data: { name: "shared" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
});

describe("mcp resource access frontend flow", () => {
  // 同名 MCP 归属不同组织时，稳定 key 由 scope.organizationId 与资源 id 拼接而成。
  test("同名 MCP 使用归属组织与资源 id 作为稳定 key", () => {
    const internal = internalMcp();
    const external = externalMcp();

    expect(getMcpKey(internal)).toBe("org-current/mcp-internal");
    expect(getMcpKey(external)).toBe("org-source/mcp-external");
    expect(new Set([getMcpKey(internal), getMcpKey(external)]).size).toBe(2);
  });

  // 缺少 scope 或 id 时无法保证跨组织唯一，退回资源名，避免拼出歧义 key。
  test("缺少归属信息时回退到资源名", () => {
    expect(getMcpKey({ name: "shared" })).toBe("shared");
    expect(getMcpKey({ id: "mcp-1", name: "shared" })).toBe("shared");
    expect(getMcpKey({ name: "shared", scope: { visibility: "private" } })).toBe("shared");
  });

  // 详情读取与 key 推导规则一致，外部资源同样使用跨组织资源键。
  test("外部 MCP 详情读取使用跨组织资源键", () => {
    expect(getMcpLookupKey(externalMcp())).toBe("org-source/mcp-external");
    expect(getMcpLookupKey({ name: "shared" })).toBe("shared");
  });

  // 归属判定比对 scope.organizationId 与当前组织；缺少归属或当前组织未知时按本组织保守处理。
  test("按当前组织判定资源是否属于其他组织", () => {
    expect(isExternalMcp(internalMcp(), ACTIVE_ORG_ID)).toBe(false);
    expect(isExternalMcp(externalMcp(), ACTIVE_ORG_ID)).toBe(true);
    expect(isExternalMcp({ name: "shared" }, ACTIVE_ORG_ID)).toBe(false);
    expect(isExternalMcp(externalMcp())).toBe(false);
  });

  // 外部 MCP 只有读动作，因此不可写、不可管理公开状态，并在展示名中带来源组织。
  test("外部 MCP 是只读资源", () => {
    const external = externalMcp();

    expect(canWriteMcp(external)).toBe(false);
    expect(canManageMcpSharing(external)).toBe(false);
    expect(getMcpDisplayName(external)).toBe("Source Team/shared");
    expect(getMcpResourceBadgeKey(external, ACTIVE_ORG_ID)).toBe("resource.external");
  });

  // 授权视图缺失时必须保守降级为不可写，避免越权展示编辑入口。
  test("缺少 access 动作时视为不可写", () => {
    expect(canWriteMcp({ name: "shared", scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" } })).toBe(
      false,
    );
    expect(canWriteMcp({ name: "shared", access: { actions: ["read"] } })).toBe(false);
    expect(canManageMcpSharing({ name: "shared" })).toBe(false);
  });

  // 公开状态决定角标：外部资源优先，其次公开，其余为本组织私有。
  test("角标按外部、公开、私有的优先级推导", () => {
    expect(getMcpResourceBadgeKey(internalMcp(), ACTIVE_ORG_ID)).toBe("resource.internal");
    expect(
      getMcpResourceBadgeKey(
        internalMcp({ scope: { organizationId: ACTIVE_ORG_ID, visibility: "public" } }),
        ACTIVE_ORG_ID,
      ),
    ).toBe("resource.public");
    expect(getMcpResourceBadgeKey({ name: "shared" }, ACTIVE_ORG_ID)).toBe("resource.internal");
  });

  // MCP 展示名优先使用归属组织名，缺失时只用资源名。
  test("MCP 展示标签使用组织名和资源名", () => {
    expect(getMcpDisplayName(internalMcp())).toBe("Current Team/shared");
    expect(getMcpDisplayName(externalMcp())).toBe("Source Team/shared");
    expect(getMcpDisplayName({ name: "shared" })).toBe("shared");
  });

  // 内部公开开关通过 update 方法发送 config 字段（PUT + query name + body: { config }）。
  test("公开开关 update action 携带 publicReadable", async () => {
    const { mcpApi } = await import("../api/mcp");

    await mcpApi.update("shared", {
      type: "remote",
      url: "https://example.com/mcp",
      publicReadable: true,
    });

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(init.method).toBe("PUT");
    expect(url).toContain("name=shared");
    expect(body).toEqual({
      config: {
        type: "remote",
        url: "https://example.com/mcp",
        publicReadable: true,
      },
    });
  });

  // 批量选择只保留带 update 动作的 MCP，外部只读资源被过滤。
  test("批量选择过滤不可写 MCP", () => {
    const selected = filterWritableMcps([internalMcp(), externalMcp(), { name: "unknown" }]);

    expect(selected).toHaveLength(1);
    expect(getMcpKey(selected[0])).toBe("org-current/mcp-internal");
  });
});
