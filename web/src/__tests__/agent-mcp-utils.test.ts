import { describe, expect, test } from "bun:test";
import { getMcpDisplayName } from "../lib/mcp-resource-access";
import {
  buildMcpPayload,
  countMcpScopes,
  filterMcpServers,
  McpImportError,
  parseMcpCommand,
  parseMcpJson,
} from "../pages/agent-panel/pages/agent-mcp-utils";
import type { McpServerInfo, ResourceAccess } from "../types/config";

const servers: McpServerInfo[] = [
  {
    id: "mcp-filesystem",
    name: "filesystem",
    type: "local",
    enabled: true,
    summary: "读取工作区文件",
    resourceAccess: {
      ownership: "internal",
      sourceOrganizationId: "org-current",
      resourceUid: "mcp-filesystem",
      resourceKey: "filesystem",
      manageable: true,
      writable: true,
    } satisfies ResourceAccess,
  },
  {
    id: "mcp-browser",
    name: "browser-control",
    type: "remote",
    enabled: true,
    summary: "浏览器控制",
    resourceAccess: {
      ownership: "external",
      sourceOrganizationId: "org-shared",
      sourceOrganizationName: "共享团队",
      resourceUid: "mcp-browser",
      resourceKey: "org-shared/browser-control",
      manageable: false,
      writable: false,
    } satisfies ResourceAccess,
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
  // 目录使用共享 MCP 的统一展示名，以区分不同来源的同名插件。
  test("includes organization name in shared MCP display name", () => {
    expect(getMcpDisplayName(servers[1])).toBe("共享团队/browser-control");
  });

  // 本组织与公开筛选分别依据 ownership 和 publicReadable。
  test("filters organization and public scopes independently", () => {
    const publicInternal = {
      ...servers[0],
      resourceAccess: { ...servers[0].resourceAccess!, publicReadable: true },
    };
    const publicExternal = {
      ...servers[1],
      resourceAccess: { ...servers[1].resourceAccess!, publicReadable: true },
    };
    const catalog = [publicInternal, publicExternal];

    expect(filterMcpServers(catalog, "", "organization").map((server) => server.name)).toEqual(["filesystem"]);
    expect(filterMcpServers(catalog, "", "public").map((server) => server.name)).toEqual([
      "filesystem",
      "browser-control",
    ]);
    expect(countMcpScopes(catalog)).toEqual({ organization: 1, public: 2 });
  });

  // 外部定向共享但未公开的 MCP 不应进入公开筛选。
  test("does not treat every external MCP as public", () => {
    expect(filterMcpServers(servers, "", "public")).toEqual([]);
    expect(countMcpScopes(servers)).toEqual({ organization: 1, public: 0 });
  });

  // 搜索应覆盖名称、说明与传输类型。
  test("searches plugin names and summaries", () => {
    expect(filterMcpServers(servers, "浏览器", "all").map((server) => server.name)).toEqual(["browser-control"]);
  });
});
