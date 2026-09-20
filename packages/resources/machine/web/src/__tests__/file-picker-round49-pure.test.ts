// MCP 资源访问纯逻辑的补充覆盖（本包文件选择器会按 MCP 视图项展示共享资源标签，因此把这批边界
// 断言留在本包：跨包模块的授权视图行为一旦回退，这里先红）。
//
// 归属：`mcp-resource-access` 的实现与视图类型归 `@fenix/resource-mcp`（§6.5 的共享 web 模块裁决），
// 本文件只做消费方断言，走对方**包根入口**——`@fenix/resource-mcp/web/lib/mcp-resource-access` 这类
// 深层路径会把对方的内部目录变成事实契约，实现目录一挪就断。
import { describe, expect, test } from "bun:test";
import type { McpResourceLike } from "@fenix/resource-mcp/web";
import {
  canManageMcpSharing,
  canWriteMcp,
  filterWritableMcps,
  getMcpDisplayName,
  getMcpKey,
  getMcpLookupKey,
  getMcpResourceBadgeKey,
} from "@fenix/resource-mcp/web";

/** 本组织可写 MCP 的 `/web` 视图字段：key 由归属组织与资源 id 派生，权限只看 access.actions。 */
const ownedMcp: McpResourceLike = {
  id: "mcp-owned",
  name: "owned-server",
  scope: { organizationId: "org-owned", visibility: "private" },
  access: { actions: ["read", "update"] },
  organizationName: "Owned Team",
};

/** 构造 MCP 视图项；默认复用本组织可写样本，便于逐字段覆盖授权视图。 */
function mcp(name: string, overrides: Partial<McpResourceLike> = {}): McpResourceLike {
  return { ...ownedMcp, name, ...overrides };
}

/** 缺失授权视图的 MCP（旧缓存或部分响应）：只能回退到资源名，且保守视为不可写。 */
function legacyMcp(name: string): McpResourceLike {
  return { name };
}

describe("MCP 资源访问纯逻辑补充覆盖", () => {
  // 归属组织存在时，列表 identity 必须使用跨组织唯一的组织/资源 id 组合。
  test("getMcpKey 优先返回归属组织派生的 key", () => {
    expect(getMcpKey(mcp("local-name"))).toBe("org-owned/mcp-owned");
  });

  // 缺失归属范围时无法推导跨组织 key，列表仍能用名称稳定渲染。
  test("getMcpKey 缺少归属范围时回退名称", () => {
    expect(getMcpKey(legacyMcp("legacy-server"))).toBe("legacy-server");
  });

  // 详情查询和列表 identity 都应使用同一 key，避免共享资源同名冲突。
  test("getMcpLookupKey 使用归属组织派生的 key", () => {
    expect(getMcpLookupKey(mcp("duplicate-name"))).toBe("org-owned/mcp-owned");
  });

  // 缺失归属范围时，详情查询必须继续使用原名称。
  test("getMcpLookupKey 缺少归属范围时回退名称", () => {
    expect(getMcpLookupKey(legacyMcp("legacy-server"))).toBe("legacy-server");
  });

  // 授权判断只信任后端下发的动作集合，缺失即保守视为不可写，避免越权展示编辑入口。
  test("缺失授权动作的 MCP 保守判定不可写", () => {
    expect(canWriteMcp(legacyMcp("default-writable"))).toBe(false);
  });

  // 只有读动作时不得进入编辑入口。
  test("只读 MCP 不可写", () => {
    expect(canWriteMcp(mcp("readonly", { access: { actions: ["read"] } }))).toBe(false);
  });

  // 带 update 动作表示服务端已确认可写，前端据此放开编辑入口。
  test("含 update 动作的 MCP 可写", () => {
    expect(canWriteMcp(mcp("writer"))).toBe(true);
  });

  // 共享管理与写权限同源，可写资源才允许调整共享设置。
  test("可写 MCP 允许管理共享", () => {
    expect(canManageMcpSharing(mcp("managed"))).toBe(true);
  });

  // 只读资源不得变更共享设置。
  test("只读 MCP 不允许管理共享", () => {
    expect(canManageMcpSharing(mcp("writer", { access: { actions: ["read"] } }))).toBe(false);
  });

  // 归属其他组织且公开可读时，来源标签优先级最高，避免被公开标签覆盖。
  test("外部资源使用 external 标签", () => {
    expect(
      getMcpResourceBadgeKey(
        mcp("shared", { scope: { organizationId: "org-source", visibility: "public" } }),
        "org-owned",
      ),
    ).toBe("resource.external");
  });

  // 本组织公开资源应展示公开标签而不是普通内部标签。
  test("内部公开资源使用 public 标签", () => {
    expect(
      getMcpResourceBadgeKey(mcp("public", { scope: { organizationId: "org-owned", visibility: "public" } })),
    ).toBe("resource.public");
  });

  // 非公开资源显示内部标签。
  test("内部私有资源使用 internal 标签", () => {
    expect(getMcpResourceBadgeKey(mcp("private"))).toBe("resource.internal");
  });

  // 有来源组织名时展示名需要保留来源，帮助区分同名共享 MCP。
  test("展示名拼接来源组织与名称", () => {
    expect(getMcpDisplayName(mcp("database"))).toBe("Owned Team/database");
  });

  // 空来源组织名不应产生多余分隔符。
  test("空来源组织名时展示原名称", () => {
    expect(getMcpDisplayName(mcp("database", { organizationName: "" }))).toBe("database");
  });

  // 批量操作只保留带 update 动作的资源，并保持调用方原有顺序。
  test("筛选可写 MCP 时保留输入顺序", () => {
    const servers = [mcp("first"), mcp("blocked", { access: { actions: ["read"] } }), mcp("third")];

    expect(filterWritableMcps(servers).map((server) => server.name)).toEqual(["first", "third"]);
  });

  // 筛选结果是新数组，不能修改调用方传入的资源列表。
  test("筛选可写 MCP 不修改输入数组", () => {
    const servers = [mcp("editable"), mcp("blocked", { access: { actions: ["read"] } })];
    const result = filterWritableMcps(servers);

    expect(result).not.toBe(servers);
    expect(servers.map((server) => server.name)).toEqual(["editable", "blocked"]);
  });
});
