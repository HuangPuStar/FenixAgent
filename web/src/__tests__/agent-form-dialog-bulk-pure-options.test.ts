import { describe, expect, test } from "bun:test";

import { mapMcpOptions, mapModelOptions } from "../pages/agent-panel/agent-editor/agent-editor-model";
import type { ModelEntry, ResourceAccess } from "../types/config";

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

function resourceAccess(overrides: Partial<ResourceAccess> = {}): ResourceAccess {
  return {
    ownership: "external",
    sourceOrganizationId: "source-org",
    resourceUid: "resource-uid",
    resourceKey: "source-org/resource-key",
    manageable: false,
    writable: false,
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
      { id: server.id, key: name, name, label: name, resourceAccess: undefined },
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
      resourceAccess: resourceAccess({
        resourceKey: `key-${sourceOrganizationName}`,
        sourceOrganizationName,
      }),
    };
    const expectedLabel = sourceOrganizationName ? `${sourceOrganizationName}/filesystem` : "filesystem";

    expect(mapMcpOptions([server])).toEqual([
      {
        id: server.id,
        key: `key-${sourceOrganizationName}`,
        name: "filesystem",
        label: expectedLabel,
        resourceAccess: server.resourceAccess,
      },
    ]);
  });

  // 混合数据映射后应保持启用项顺序、重复项和资源访问引用。
  test("保持 MCP 顺序、重复项和资源引用", () => {
    const shared = resourceAccess({ resourceKey: "shared/key", sourceOrganizationName: "共享组" });
    const servers: McpServer[] = [
      { id: "first", name: "same" },
      { id: "hidden", name: "skip", enabled: false },
      { id: "second", name: "same", resourceAccess: shared },
      { id: "third", name: "last", enabled: true },
    ];

    expect(mapMcpOptions(servers)).toEqual([
      { id: "first", key: "same", name: "same", label: "same", resourceAccess: undefined },
      { id: "second", key: "shared/key", name: "same", label: "共享组/same", resourceAccess: shared },
      { id: "third", key: "last", name: "last", label: "last", resourceAccess: undefined },
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
        label: displayName,
        modelId: "model-name",
        group: { id: "organization:provider-name", label: "Open AI", scope: "organization" },
      },
    ]);
  });

  // 共享模型标签应在各种来源名称下包含来源组织上下文。
  test.each(organizationNames)("格式化共享模型标签：%s", (sourceOrganizationName) => {
    const entry = model({
      id: `external-${sourceOrganizationName}`,
      providerDisplayName: "Provider",
      displayName: "Model",
      providerResourceAccess: resourceAccess({ sourceOrganizationName }),
    });
    expect(mapModelOptions([entry])).toEqual([
      {
        value: entry.id,
        label: "Model",
        modelId: "model-name",
        group: { id: "source-org:provider-name", label: "Provider", scope: "shared" },
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
        group: { id: "organization:provider-name", label: "P1", scope: "organization" },
      },
      {
        value: "two",
        label: "重复",
        modelId: "model-name",
        group: { id: "organization:provider-name", label: "P2", scope: "organization" },
      },
      {
        value: "three",
        label: "末尾",
        modelId: "model-name",
        group: { id: "organization:provider-name", label: "P3", scope: "organization" },
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
        resourceAccess: resourceAccess({ resourceKey: `key-${name}`, sourceOrganizationName: "来源" }),
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
        providerResourceAccess: resourceAccess({ sourceOrganizationName: "来源" }),
      }),
    ];
    const snapshot = structuredClone(input);

    mapModelOptions(input);

    expect(input).toEqual(snapshot);
  });
});
