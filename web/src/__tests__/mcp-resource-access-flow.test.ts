import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  canManageMcpSharing,
  canWriteMcp,
  filterWritableMcps,
  getMcpDisplayName,
  getMcpKey,
  getMcpLookupKey,
  getMcpResourceBadgeKey,
} from "../lib/mcp-resource-access";
import type { ResourceAccess } from "../types/config";

const internalAccess: ResourceAccess = {
  ownership: "internal",
  sourceOrganizationId: "org-current",
  sourceOrganizationName: "Current Team",
  resourceUid: "mcp-internal",
  resourceKey: "org-current/mcp-internal",
  manageable: true,
  writable: true,
  publicReadable: false,
};

const externalAccess: ResourceAccess = {
  ownership: "external",
  sourceOrganizationId: "org-source",
  sourceOrganizationName: "Source Team",
  resourceUid: "mcp-external",
  resourceKey: "org-source/mcp-external",
  manageable: false,
  writable: false,
};

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
  // 同名内部和外部 MCP 使用 resourceAccess.resourceKey 作为稳定 key。
  test("同名 MCP 使用 resourceKey 区分", () => {
    const internal = { name: "shared", resourceAccess: internalAccess };
    const external = { name: "shared", resourceAccess: externalAccess };

    expect(getMcpKey(internal)).toBe("org-current/mcp-internal");
    expect(getMcpKey(external)).toBe("org-source/mcp-external");
    expect(new Set([getMcpKey(internal), getMcpKey(external)]).size).toBe(2);
  });

  // 外部 MCP 的详情读取仍通过 resourceKey，而不是同名 name。
  test("外部 MCP 详情读取使用 resourceKey", () => {
    const external = { name: "shared", resourceAccess: externalAccess };

    expect(getMcpLookupKey(external)).toBe("org-source/mcp-external");
  });

  // 外部 MCP 不可写、不可管理公开状态，并在展示名中带来源组织。
  test("外部 MCP 是只读资源", () => {
    const external = { name: "shared", resourceAccess: externalAccess };

    expect(canWriteMcp(external)).toBe(false);
    expect(canManageMcpSharing(external)).toBe(false);
    expect(getMcpDisplayName(external)).toBe("Source Team/shared");
    expect(getMcpResourceBadgeKey(external)).toBe("resource.external");
  });

  // MCP 展示名优先使用组织名，缺失时回退到组织 ID。
  test("MCP 展示标签使用组织名和资源名", () => {
    expect(getMcpDisplayName({ name: "shared", resourceAccess: internalAccess })).toBe("Current Team/shared");
    expect(getMcpDisplayName({ name: "shared", resourceAccess: externalAccess })).toBe("Source Team/shared");
    expect(
      getMcpDisplayName({
        name: "shared",
        resourceAccess: { ...externalAccess, sourceOrganizationName: undefined },
      }),
    ).toBe("shared");
  });

  // 内部公开开关通过 update 方法发送 config 字段（新 API 用 config 替代了旧 data 字段名）。
  test("公开开关 update action 携带 publicReadable", async () => {
    const { mcpApi } = await import("../api/mcp");

    await mcpApi.update("shared", {
      type: "remote",
      url: "https://example.com/mcp",
      publicReadable: true,
    });

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({
      action: "set",
      name: "shared",
      config: {
        type: "remote",
        url: "https://example.com/mcp",
        publicReadable: true,
      },
    });
  });

  // 批量选择只保留可写的内部 MCP。
  test("批量选择过滤外部 MCP", () => {
    const selected = filterWritableMcps([
      { name: "shared", resourceAccess: internalAccess },
      { name: "shared", resourceAccess: externalAccess },
    ]);

    expect(selected).toHaveLength(1);
    expect(selected[0].resourceAccess?.resourceKey).toBe("org-current/mcp-internal");
  });
});
