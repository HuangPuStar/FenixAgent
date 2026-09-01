import { describe, expect, test } from "bun:test";
import {
  buildMcpPayload,
  countMcpScopes,
  filterMcpServers,
  parseMcpCommand,
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
  // 资源范围只按后端 ownership 切分，不制造个人、平台或市场幻影字段。
  test("filters proven organization and shared scopes", () => {
    expect(filterMcpServers(servers, "", "organization").map((server) => server.name)).toEqual(["filesystem"]);
    expect(filterMcpServers(servers, "", "shared").map((server) => server.name)).toEqual(["browser-control"]);
    expect(countMcpScopes(servers)).toEqual({ organization: 1, shared: 1 });
  });

  // 搜索应覆盖名称、说明与传输类型。
  test("searches plugin names and summaries", () => {
    expect(filterMcpServers(servers, "浏览器", "all").map((server) => server.name)).toEqual(["browser-control"]);
  });
});
