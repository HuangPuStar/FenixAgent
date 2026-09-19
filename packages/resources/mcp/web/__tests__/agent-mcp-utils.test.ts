import { describe, expect, test } from "bun:test";
import type { McpServerInfo } from "@/src/types/config";
import { getMcpDisplayName } from "../lib/mcp-resource-access";
import {
  buildMcpPayload,
  countMcpScopes,
  filterMcpServers,
  McpImportError,
  parseMcpCommand,
  parseMcpJson,
} from "../pages/agent-panel/pages/agent-mcp-utils";

const ACTIVE_ORG_ID = "org-current";

const servers: McpServerInfo[] = [
  {
    id: "mcp-filesystem",
    name: "filesystem",
    type: "local",
    enabled: true,
    summary: "读取工作区文件",
    scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" },
    access: { actions: ["read", "update"] },
  },
  {
    id: "mcp-browser",
    name: "browser-control",
    type: "remote",
    enabled: true,
    summary: "浏览器控制",
    scope: { organizationId: "org-shared", visibility: "public" },
    access: { actions: ["read", "use"] },
    organizationName: "共享团队",
  },
];

describe("MCP editor conversion", () => {
  // 带引号的命令参数必须保持为单个 argv，避免配置保存后语义改变。
  test("parses quoted command arguments", () => {
    expect(parseMcpCommand('npx package "folder with spaces"')).toEqual(["npx", "package", "folder with spaces"]);
  });

  // 标准 mcp.json 的 command、args 和 env 必须转换为内部 local 配置。
  test("parses local mcp.json entries", () => {
    expect(
      parseMcpJson(
        JSON.stringify({
          mcpServers: {
            filesystem: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
              env: { HOME: "/tmp" },
            },
          },
        }),
      ),
    ).toEqual([
      {
        name: "filesystem",
        config: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
          environment: { HOME: "/tmp" },
        },
      },
    ]);
  });

  // URL 配置应转换为对应的 remote 或 streamable-http 内部配置。
  test("parses remote mcp.json entries", () => {
    expect(
      parseMcpJson(
        JSON.stringify({
          mcpServers: {
            api: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } },
          },
        }),
      ),
    ).toEqual([
      {
        name: "api",
        config: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    ]);
  });

  // 非法 JSON 和缺少 command/url 的配置必须在请求前被拒绝。
  test("rejects invalid mcp.json input", () => {
    expect(() => parseMcpJson("{")).toThrow(McpImportError);
    expect(() => parseMcpJson('{"mcpServers":{"broken":{}}}')).toThrow(McpImportError);
  });

  // 编辑器数据必须在提交边界转换为真实 remote MCP 配置。
  test("builds remote MCP payload", () => {
    expect(
      buildMcpPayload({
        type: "remote",
        command: "",
        url: "https://example.com/mcp",
        environment: [],
        headers: [{ key: "Authorization", value: "{env:RCS_SECRET_MCP}" }],
        oauthClientId: "",
        oauthClientSecret: "",
        oauthScope: "",
        oauthRedirectUri: "",
        timeout: "5000",
      }),
    ).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "{env:RCS_SECRET_MCP}" },
      timeout: 5000,
    });
  });
});

describe("plugin marketplace filters", () => {
  // 共享目录必须显示来源组织，避免不同组织的同名 MCP 无法区分。
  test("includes the source organization in a shared MCP display name", () => {
    expect(getMcpDisplayName(servers[1])).toBe("共享团队/browser-control");
  });

  // 本组织与公开筛选分别依据 scope.organizationId 归属比对和 scope.visibility。
  test("filters organization and public scopes independently", () => {
    const publicInternal = { ...servers[0], scope: { ...servers[0].scope!, visibility: "public" as const } };
    const catalog = [publicInternal, servers[1]];

    expect(filterMcpServers(catalog, "", "organization", ACTIVE_ORG_ID).map((server) => server.name)).toEqual([
      "filesystem",
    ]);
    expect(filterMcpServers(catalog, "", "public", ACTIVE_ORG_ID).map((server) => server.name)).toEqual([
      "filesystem",
      "browser-control",
    ]);
    expect(countMcpScopes(catalog, ACTIVE_ORG_ID)).toEqual({ organization: 1, public: 2 });
  });

  // 外部组织私有 MCP 不属于本组织也不公开，两个筛选都不应包含它。
  test("does not treat every external MCP as public or internal", () => {
    const privateExternal = {
      ...servers[1],
      scope: { organizationId: "org-shared", visibility: "private" as const },
    };

    expect(filterMcpServers([privateExternal], "", "public", ACTIVE_ORG_ID)).toEqual([]);
    expect(filterMcpServers([privateExternal], "", "organization", ACTIVE_ORG_ID)).toEqual([]);
    expect(countMcpScopes([privateExternal], ACTIVE_ORG_ID)).toEqual({ organization: 0, public: 0 });
  });

  // 组织上下文未就绪（当前组织未知）时不得把资源误判为外部资源，也不应把本组织资源从目录中隐藏。
  test("treats resources as internal when the active organization is unknown", () => {
    expect(filterMcpServers(servers, "", "organization").map((server) => server.name)).toEqual([
      "filesystem",
      "browser-control",
    ]);
    expect(countMcpScopes(servers)).toEqual({ organization: 2, public: 1 });
  });

  // 搜索应覆盖名称、说明与传输类型。
  test("searches plugin names and summaries", () => {
    expect(filterMcpServers(servers, "浏览器", "all").map((server) => server.name)).toEqual(["browser-control"]);
  });
});
