import { describe, expect, test } from "bun:test";
import type { ModelEntry } from "@fenix/web-runtime/types/config";
import { mapMcpOptions, mapModelOptions } from "../pages/agent-panel/agent-editor/agent-editor-model";

type McpServer = Parameters<typeof mapMcpOptions>[0][number];

/** 共享来源模型的 `/web` 视图字段：归属其他组织且只有读动作。 */
function sharedModelFields(organizationName?: string): Partial<ModelEntry> {
  return {
    providerId: "provider-uid",
    scope: { organizationId: "source-org", visibility: "private" },
    access: { actions: ["read"] },
    ...(organizationName === undefined ? {} : { organizationName }),
  };
}

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "model-id",
    modelId: "model-name",
    displayName: "模型名称",
    provider: "provider-name",
    providerDisplayName: "提供商名称",
    contextLimit: null,
    outputLimit: null,
    ...overrides,
  };
}

describe("AgentFormDialog 补充 MCP 选项转换", () => {
  // 未共享 MCP 的特殊字符边界应原样保留。
  test.each([
    ["连字符标识", "mcp-alpha-01", "filesystem", "mcp-alpha-01", "filesystem"],
    ["下划线标识", "mcp_alpha_02", "code_search", "mcp_alpha_02", "code_search"],
    ["Unicode 名称", "mcp-中文", "文件搜索", "mcp-中文", "文件搜索"],
    ["空名称", "mcp-empty", "", "mcp-empty", ""],
    ["空标识", "", "filesystem", "", "filesystem"],
    ["含空格名称", "mcp-space", "file search", "mcp-space", "file search"],
    ["含斜杠名称", "mcp-slash", "repo/files", "mcp-slash", "repo/files"],
    ["含冒号名称", "mcp-colon", "git:status", "mcp-colon", "git:status"],
    ["含句点名称", "mcp-dot", "server.v2", "mcp-dot", "server.v2"],
    ["纯数字名称", "mcp-number", "007", "mcp-number", "007"],
    ["前导空格名称", "mcp-leading-space", " files", "mcp-leading-space", " files"],
    ["尾随空格名称", "mcp-trailing-space", "files ", "mcp-trailing-space", "files "],
    ["换行名称", "mcp-newline", "files\nsearch", "mcp-newline", "files\nsearch"],
    ["表情符号名称", "mcp-emoji", "工具箱", "mcp-emoji", "工具箱"],
    ["大写名称", "mcp-uppercase", "FILES", "mcp-uppercase", "FILES"],
    ["混合大小写名称", "mcp-mixed", "FileSearch", "mcp-mixed", "FileSearch"],
    ["百分号名称", "mcp-percent", "100%", "mcp-percent", "100%"],
    ["查询符号名称", "mcp-query", "search?limit=1", "mcp-query", "search?limit=1"],
    ["井号名称", "mcp-hash", "issue#42", "mcp-hash", "issue#42"],
    ["反斜杠名称", "mcp-backslash", "folder\\file", "mcp-backslash", "folder\\file"],
  ])("保留未共享 MCP 的%s", (_caseName, id, name, expectedId, expectedName) => {
    expect(mapMcpOptions([{ id, name }])).toEqual([
      {
        id: expectedId,
        key: expectedName,
        name: expectedName,
        label: expectedName,
        scope: undefined,
        organizationName: undefined,
      },
    ]);
  });

  // 共享 MCP 的归属组织、来源展示名和资源名边界应按新视图字段转换。
  test.each([
    ["共享键含斜杠", "team-a/filesystem", "Team A", "files", "team-a/filesystem/shared-id", "Team A/files"],
    ["共享键含冒号", "team-a:files", "平台组", "files", "team-a:files/shared-id", "平台组/files"],
    ["共享键为空格", "shared file", "Team A", "files", "shared file/shared-id", "Team A/files"],
    ["共享键为零", "0", "Team A", "files", "0/shared-id", "Team A/files"],
    ["共享键为空字符串", "", "Team A", "files", "files", "Team A/files"],
    ["来源为零", "resource-org", "0", "files", "resource-org/shared-id", "0/files"],
    ["来源为中文", "resource-org", "研发中心", "files", "resource-org/shared-id", "研发中心/files"],
    ["来源含斜杠", "resource-org", "组织/平台", "files", "resource-org/shared-id", "组织/平台/files"],
    ["来源含空格", "resource-org", "Team A", "files", "resource-org/shared-id", "Team A/files"],
    ["来源含换行", "resource-org", "Team\nA", "files", "resource-org/shared-id", "Team\nA/files"],
    ["共享名称为空", "resource-org", "Team A", "", "resource-org/shared-id", "Team A/"],
    ["共享名称为数字", "resource-org", "Team A", "123", "resource-org/shared-id", "Team A/123"],
    ["共享名称有斜杠", "resource-org", "Team A", "repo/files", "resource-org/shared-id", "Team A/repo/files"],
    ["共享名称有冒号", "resource-org", "Team A", "git:log", "resource-org/shared-id", "Team A/git:log"],
    ["共享名称为 Unicode", "资源/键", "共享组", "文件检索", "资源/键/shared-id", "共享组/文件检索"],
    ["共享名称含百分号", "resource-org", "Team A", "100%", "resource-org/shared-id", "Team A/100%"],
    ["共享名称含井号", "resource-org", "Team A", "issue#1", "resource-org/shared-id", "Team A/issue#1"],
    ["共享名称含前导空格", "resource-org", "Team A", " files", "resource-org/shared-id", "Team A/ files"],
    ["共享名称含尾随空格", "resource-org", "Team A", "files ", "resource-org/shared-id", "Team A/files "],
    ["共享名称含表情", "resource-org", "Team A", "任务", "resource-org/shared-id", "Team A/任务"],
  ])("转换共享 MCP 的%s", (_caseName, organizationId, organizationName, name, expectedKey, expectedLabel) => {
    const scope = { organizationId, visibility: "public" } as const;
    expect(mapMcpOptions([{ id: "shared-id", name, scope, organizationName }])).toEqual([
      { id: "shared-id", key: expectedKey, name, label: expectedLabel, scope, organizationName },
    ]);
  });
});

describe("AgentFormDialog 补充模型选项转换", () => {
  // 本组织模型的 provider 与显示名特殊字符应原样进入标签。
  test.each([
    ["Unicode 标识", "模型-一", "提供商", "模型", "模型-一", "提供商/模型"],
    ["空标识", "", "提供商", "模型", "", "提供商/模型"],
    ["空提供商", "model-empty-provider", "", "模型", "model-empty-provider", "/模型"],
    ["空显示名", "model-empty-name", "提供商", "", "model-empty-name", "提供商/"],
    ["提供商含空格", "model-space-provider", "Open AI", "模型", "model-space-provider", "Open AI/模型"],
    ["显示名含空格", "model-space-name", "提供商", "模型 Pro", "model-space-name", "提供商/模型 Pro"],
    ["提供商含斜杠", "model-slash-provider", "cloud/openai", "模型", "model-slash-provider", "cloud/openai/模型"],
    ["显示名含斜杠", "model-slash-name", "提供商", "vision/large", "model-slash-name", "提供商/vision/large"],
    ["提供商含冒号", "model-colon-provider", "azure:openai", "模型", "model-colon-provider", "azure:openai/模型"],
    ["显示名含冒号", "model-colon-name", "提供商", "v1:beta", "model-colon-name", "提供商/v1:beta"],
    ["提供商含换行", "model-newline-provider", "A\nB", "模型", "model-newline-provider", "A\nB/模型"],
    ["显示名含换行", "model-newline-name", "提供商", "A\nB", "model-newline-name", "提供商/A\nB"],
    ["提供商为数字", "model-number-provider", "007", "模型", "model-number-provider", "007/模型"],
    ["显示名为数字", "model-number-name", "提供商", "007", "model-number-name", "提供商/007"],
    ["提供商含百分号", "model-percent-provider", "100%", "模型", "model-percent-provider", "100%/模型"],
    ["显示名含百分号", "model-percent-name", "提供商", "100%", "model-percent-name", "提供商/100%"],
    ["提供商含表情", "model-emoji-provider", "云端", "模型", "model-emoji-provider", "云端/模型"],
    ["显示名含表情", "model-emoji-name", "提供商", "助手", "model-emoji-name", "提供商/助手"],
    ["提供商保留大小写", "model-case-provider", "OpenAI", "模型", "model-case-provider", "OpenAI/模型"],
    ["显示名保留大小写", "model-case-name", "提供商", "GPT-Next", "model-case-name", "提供商/GPT-Next"],
  ])("保留本组织模型的%s", (_caseName, id, providerDisplayName, displayName, value) => {
    expect(mapModelOptions([model({ id, providerDisplayName, displayName })])).toEqual([
      {
        value,
        label: displayName,
        modelId: "model-name",
        group: {
          id: "provider-name",
          label: providerDisplayName,
          scope: "organization",
        },
      },
    ]);
  });

  // 共享模型应在所有边界下按 Provider 资源键分组并标记共享来源。
  test.each([
    ["共享组织为中文", "研发部", "Provider", "Model"],
    ["共享组织为零", "0", "Provider", "Model"],
    ["共享组织含空格", "Team A", "Provider", "Model"],
    ["共享组织含斜杠", "组织/子组", "Provider", "Model"],
    ["共享组织含冒号", "team:alpha", "Provider", "Model"],
    ["共享组织含换行", "A\nB", "Provider", "Model"],
    ["共享提供商为空", "Team A", "", "Model"],
    ["共享显示名为空", "Team A", "Provider", ""],
    ["共享提供商含空格", "Team A", "Open AI", "Model"],
    ["共享显示名含空格", "Team A", "Provider", "Model Pro"],
    ["共享提供商含斜杠", "Team A", "cloud/openai", "Model"],
    ["共享显示名含斜杠", "Team A", "Provider", "vision/large"],
    ["共享提供商为数字", "Team A", "007", "Model"],
    ["共享显示名为数字", "Team A", "Provider", "007"],
    ["共享提供商含百分号", "Team A", "100%", "Model"],
    ["共享显示名含百分号", "Team A", "Provider", "100%"],
    ["共享提供商含表情", "Team A", "云端", "Model"],
    ["共享显示名含表情", "Team A", "Provider", "助手"],
    ["共享组织保留前导空格", " Team", "Provider", "Model"],
    ["共享组织保留尾随空格", "Team ", "Provider", "Model"],
  ])("拼接共享模型的%s", (_caseName, organizationName, providerDisplayName, displayName) => {
    expect(
      mapModelOptions(
        [model({ providerDisplayName, displayName, ...sharedModelFields(organizationName) })],
        "org-current",
      ),
    ).toEqual([
      {
        value: "model-id",
        label: displayName,
        modelId: "model-name",
        group: { id: "source-org/provider-uid", label: providerDisplayName, scope: "shared" },
      },
    ]);
  });
});

function isModelEntries(input: ModelEntry[] | McpServer[]): input is ModelEntry[] {
  return input.every((item) => "modelId" in item);
}

describe("AgentFormDialog 转换不可变性", () => {
  // MCP 与模型映射都不得修改输入数组及嵌套访问描述。
  test.each([
    ["MCP 启用项", [{ id: "one", name: "files", enabled: true }]],
    ["MCP 禁用项", [{ id: "one", name: "files", enabled: false }]],
    ["MCP 空名称", [{ id: "one", name: "" }]],
    ["MCP Unicode 名称", [{ id: "one", name: "文件" }]],
    [
      "MCP 共享资源",
      [
        {
          id: "one",
          name: "files",
          scope: { organizationId: "team", visibility: "public" as const },
          organizationName: "团队",
        },
      ],
    ],
    ["MCP 空归属组织", [{ id: "one", name: "files", scope: { organizationId: "", visibility: "private" as const } }]],
    [
      "MCP 多个项目",
      [
        { id: "one", name: "files" },
        { id: "two", name: "search", enabled: false },
      ],
    ],
    [
      "MCP 重复名称",
      [
        { id: "one", name: "files" },
        { id: "two", name: "files" },
      ],
    ],
    ["模型基础项", [model()]],
    ["模型空显示名", [model({ displayName: "" })]],
    ["模型 Unicode 项", [model({ id: "模型", providerDisplayName: "云", displayName: "助手" })]],
    ["模型共享项", [model(sharedModelFields("团队"))]],
    ["模型空来源", [model(sharedModelFields(""))]],
    ["模型多个项目", [model({ id: "one" }), model({ id: "two", displayName: "第二个" })]],
    ["模型重复展示名", [model({ id: "one" }), model({ id: "two" })]],
    ["模型特殊字符", [model({ id: "id/1", providerDisplayName: "P:1", displayName: "N?1" })]],
  ])("%s 的输入数据保持不变", (_caseName, input) => {
    const snapshot = structuredClone(input);
    if (isModelEntries(input)) {
      mapModelOptions(input);
    } else {
      mapMcpOptions(input);
    }
    expect(input).toEqual(snapshot);
  });
});
