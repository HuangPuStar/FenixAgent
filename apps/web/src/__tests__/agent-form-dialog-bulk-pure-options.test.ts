import { describe, expect, test } from "bun:test";
import type { ModelEntry } from "@fenix/web-runtime/types/config";
import {
  mapMcpOptions,
  mapModelOptions,
} from "../../../../packages/resources/agent-config/web/pages/agent-panel/agent-editor/agent-editor-model";

type McpServer = Parameters<typeof mapMcpOptions>[0][number];

const mcpNames = [
  "files",
  "search",
  "git-status",
  "repo/files",
  "文件搜索",
  "日志 归档",
  "tool:inspect",
  "v2.0",
  "issue#42",
  "100%",
  "line\nbreak",
  " leading",
  "trailing ",
  "UPPERCASE",
  "mixedCase",
  "007",
  "folder\\file",
  "?query=true",
  "",
  "任务",
  "alpha_beta",
  "a-b-c",
  "read.only",
  "[brackets]",
  "{json}",
  "(group)",
  "dollar$value",
  "semi;colon",
  "comma,value",
  'quote"value',
];

const organizationNames = [
  "研发部",
  "Team A",
  "0",
  "组织/子组",
  "team:alpha",
  "A\nB",
  " Team",
  "Team ",
  "云端",
  "100%",
  "任务组",
  "",
  "platform.beta",
  "007",
  "group#1",
  "内部 服务",
  "alpha_beta",
  "日本語",
  "emoji",
  "long organization name",
];

/** 共享来源模型的 `/web` 视图字段：归属其他组织且只有读动作。 */
function sharedModelFields(overrides: Partial<ModelEntry> = {}): Partial<ModelEntry> {
  return {
    providerId: "provider-uid",
    scope: { organizationId: "source-org", visibility: "private" },
    access: { actions: ["read"] },
    ...overrides,
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

describe("AgentFormDialog MCP 选项批量边界转换", () => {
  // 批量边界值应完整保留启用 MCP 的原始标识与名称。
  test.each(mcpNames)("保留启用 MCP 的原始字段：%s", (name) => {
    const server: McpServer = { id: `enabled-${name}`, name, enabled: true };

    expect(mapMcpOptions([server])).toEqual([
      { id: server.id, key: name, name, label: name, scope: undefined, organizationName: undefined },
    ]);
  });

  // 显式禁用的 MCP 在所有名称边界下都不得成为可选项。
  test.each(mcpNames)("过滤禁用 MCP：%s", (name) => {
    const server: McpServer = { id: `disabled-${name}`, name, enabled: false };

    expect(mapMcpOptions([server])).toEqual([]);
  });

  // 共享 MCP 标签应对各类来源组织名称保持稳定拼接规则。
  test.each(organizationNames)("拼接共享 MCP 的来源组织：%s", (sourceOrganizationName) => {
    const server: McpServer = {
      id: `shared-${sourceOrganizationName}`,
      name: "filesystem",
      scope: { organizationId: "source-org", visibility: "public" },
      organizationName: sourceOrganizationName,
    };
    const expectedLabel = sourceOrganizationName ? `${sourceOrganizationName}/filesystem` : "filesystem";

    expect(mapMcpOptions([server])).toEqual([
      {
        id: server.id,
        key: `source-org/shared-${sourceOrganizationName}`,
        name: "filesystem",
        label: expectedLabel,
        scope: { organizationId: "source-org", visibility: "public" },
        organizationName: sourceOrganizationName,
      },
    ]);
  });

  // 混合数据映射后应保持启用项顺序、重复项和归属范围引用。
  test("保持 MCP 顺序、重复项和归属范围引用", () => {
    const scope = { organizationId: "shared-org", visibility: "public" } as const;
    const servers: McpServer[] = [
      { id: "first", name: "same" },
      { id: "hidden", name: "skip", enabled: false },
      { id: "second", name: "same", scope, organizationName: "共享组" },
      { id: "third", name: "last", enabled: true },
    ];

    expect(mapMcpOptions(servers)).toEqual([
      { id: "first", key: "same", name: "same", label: "same", scope: undefined, organizationName: undefined },
      {
        id: "second",
        key: "shared-org/second",
        name: "same",
        label: "共享组/same",
        scope,
        organizationName: "共享组",
      },
      { id: "third", key: "last", name: "last", label: "last", scope: undefined, organizationName: undefined },
    ]);
  });
});

describe("AgentFormDialog 模型选项批量格式化", () => {
  // 本组织模型标签应在各类显示名边界下保持 provider/model 格式。
  test.each(mcpNames)("格式化本组织模型标签：%s", (displayName) => {
    const entry = model({
      id: `internal-${displayName}`,
      providerDisplayName: "Open AI",
      displayName,
    });

    expect(mapModelOptions([entry])).toEqual([
      {
        value: entry.id,
        label: displayName === "(group)" ? "group" : displayName,
        modelId: "model-name",
        group: { id: "provider-name", label: "Open AI", scope: "organization" },
      },
    ]);
  });

  // 共享模型标签应在各种来源名称下保持短标签，并按 Provider 资源键分组标记共享来源。
  test.each(organizationNames)("格式化共享模型标签：%s", (organizationName) => {
    const entry = model({
      id: `external-${organizationName}`,
      providerDisplayName: "Provider",
      displayName: "Model",
      ...sharedModelFields({ organizationName }),
    });
    expect(mapModelOptions([entry], "org-current")).toEqual([
      {
        value: entry.id,
        label: "Model",
        modelId: "model-name",
        group: { id: "source-org/provider-uid", label: "Provider", scope: "shared" },
      },
    ]);
  });

  // 模型映射不得重排输入或合并重复显示名。
  test("保持模型的输入顺序与重复显示名", () => {
    const entries = [
      model({ id: "one", providerDisplayName: "P1", displayName: "重复" }),
      model({ id: "two", providerDisplayName: "P2", displayName: "重复" }),
      model({ id: "three", providerDisplayName: "P3", displayName: "末尾" }),
    ];

    expect(mapModelOptions(entries)).toEqual([
      {
        value: "one",
        label: "重复",
        modelId: "model-name",
        group: { id: "provider-name", label: "P1", scope: "organization" },
      },
      {
        value: "two",
        label: "重复",
        modelId: "model-name",
        group: { id: "provider-name", label: "P2", scope: "organization" },
      },
      {
        value: "three",
        label: "末尾",
        modelId: "model-name",
        group: { id: "provider-name", label: "P3", scope: "organization" },
      },
    ]);
  });
});

describe("AgentFormDialog 选项转换不可变性", () => {
  // MCP 映射不得修改调用方传入的数据对象。
  test.each(mcpNames.slice(0, 10))("不修改 MCP 输入：%s", (name) => {
    const input: McpServer[] = [
      { id: `plain-${name}`, name },
      {
        id: `shared-${name}`,
        name,
        scope: { organizationId: `org-${name}`, visibility: "public" },
        organizationName: "来源",
      },
      { id: `disabled-${name}`, name, enabled: false },
    ];
    const snapshot = structuredClone(input);

    mapMcpOptions(input);

    expect(input).toEqual(snapshot);
  });

  // 模型映射不得修改调用方传入的数据对象。
  test.each(mcpNames.slice(10, 20))("不修改模型输入：%s", (displayName) => {
    const input = [
      model({ id: `internal-${displayName}`, displayName }),
      model({
        id: `external-${displayName}`,
        displayName,
        ...sharedModelFields({ organizationName: "来源" }),
      }),
    ];
    const snapshot = structuredClone(input);

    mapModelOptions(input, "org-current");

    expect(input).toEqual(snapshot);
  });
});
