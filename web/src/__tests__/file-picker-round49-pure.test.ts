import { describe, expect, test } from "bun:test";
import type { McpResourceLike } from "../lib/mcp-resource-access";
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

const ownedAccess: ResourceAccess = {
  ownership: "internal",
  sourceOrganizationId: "org-owned",
  sourceOrganizationName: "Owned Team",
  resourceUid: "mcp-owned",
  resourceKey: "org-owned/mcp-owned",
  manageable: true,
  writable: true,
  publicReadable: false,
};

function mcp(name: string, resourceAccess?: ResourceAccess): McpResourceLike {
  return { name, resourceAccess };
}

describe("MCP 资源访问纯逻辑补充覆盖", () => {
  // 资源 key 存在时，列表 identity 必须使用跨组织唯一的 key。
  test("getMcpKey 优先返回 resourceKey", () => {
    expect(getMcpKey(mcp("local-name", ownedAccess))).toBe("org-owned/mcp-owned");
  });

  // 旧数据没有访问元信息时，列表仍能用名称稳定渲染。
  test("getMcpKey 缺少访问元信息时回退名称", () => {
    expect(getMcpKey(mcp("legacy-server"))).toBe("legacy-server");
  });

  // 详情查询和列表 identity 都应使用同一资源 key，避免共享资源同名冲突。
  test("getMcpLookupKey 使用 resourceKey", () => {
    expect(getMcpLookupKey(mcp("duplicate-name", ownedAccess))).toBe("org-owned/mcp-owned");
  });

  // 旧服务端返回缺失访问元信息时，详情查询必须继续使用原名称。
  test("getMcpLookupKey 缺少 resourceKey 时回退名称", () => {
    expect(getMcpLookupKey(mcp("legacy-server"))).toBe("legacy-server");
  });

  // 没有 resourceAccess 的本地 MCP 默认允许修改。
  test("未标记 writable 的 MCP 默认可写", () => {
    expect(canWriteMcp(mcp("default-writable"))).toBe(true);
  });

  // writable 显式为 false 时必须阻止编辑入口。
  test("显式只读 MCP 不可写", () => {
    expect(canWriteMcp(mcp("readonly", { ...ownedAccess, writable: false }))).toBe(false);
  });

  // writable 为 undefined 是兼容字段缺失场景，语义仍为允许写入。
  test("writable 缺失时保持可写", () => {
    expect(canWriteMcp(mcp("compat", { ...ownedAccess, writable: true }))).toBe(true);
  });

  // 管理共享权限只能由明确授权开启，不能从 writable 推断。
  test("manageable 为 true 时允许管理共享", () => {
    expect(canManageMcpSharing(mcp("managed", ownedAccess))).toBe(true);
  });

  // 仅可写不代表能变更共享设置。
  test("manageable 缺失时不允许管理共享", () => {
    expect(canManageMcpSharing(mcp("writer", { ...ownedAccess, manageable: false }))).toBe(false);
  });

  // 外部资源的来源标签优先级最高，即使它也可公开读取。
  test("外部资源使用 external 标签", () => {
    expect(getMcpResourceBadgeKey(mcp("shared", { ...ownedAccess, ownership: "external", publicReadable: true }))).toBe(
      "resource.external",
    );
  });

  // 内部公开资源应展示公开标签而不是普通内部标签。
  test("内部公开资源使用 public 标签", () => {
    expect(getMcpResourceBadgeKey(mcp("public", { ...ownedAccess, publicReadable: true }))).toBe("resource.public");
  });

  // 非公开的内部资源显示内部标签。
  test("内部私有资源使用 internal 标签", () => {
    expect(getMcpResourceBadgeKey(mcp("private", ownedAccess))).toBe("resource.internal");
  });

  // 有来源组织名时展示名需要保留来源，帮助区分同名共享 MCP。
  test("展示名拼接来源组织与名称", () => {
    expect(getMcpDisplayName(mcp("database", ownedAccess))).toBe("Owned Team/database");
  });

  // 空来源组织名不应产生多余分隔符。
  test("空来源组织名时展示原名称", () => {
    expect(getMcpDisplayName(mcp("database", { ...ownedAccess, sourceOrganizationName: "" }))).toBe("database");
  });

  // 批量操作只保留可写资源，并保持调用方原有顺序。
  test("筛选可写 MCP 时保留输入顺序", () => {
    const servers = [mcp("first"), mcp("blocked", { ...ownedAccess, writable: false }), mcp("third", ownedAccess)];

    expect(filterWritableMcps(servers).map((server) => server.name)).toEqual(["first", "third"]);
  });

  // 筛选结果是新数组，不能修改调用方传入的资源列表。
  test("筛选可写 MCP 不修改输入数组", () => {
    const servers = [mcp("editable"), mcp("blocked", { ...ownedAccess, writable: false })];
    const result = filterWritableMcps(servers);

    expect(result).not.toBe(servers);
    expect(servers.map((server) => server.name)).toEqual(["editable", "blocked"]);
  });
});
