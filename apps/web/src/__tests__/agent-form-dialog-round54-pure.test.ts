import { describe, expect, test } from "bun:test";

import {
  mapMcpOptions,
  mapModelOptions,
} from "../../../../packages/resources/agent-config/web/pages/agent-panel/agent-editor/agent-editor-model";
import type { McpServerInfo, ModelEntry } from "../types/config";

function createModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
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

/** 共享来源模型的 `/web` 视图字段：归属其他组织且只有读动作。 */
const sharedModelFields: Partial<ModelEntry> = {
  providerId: "provider-uid",
  scope: { organizationId: "source-org", visibility: "private" },
  access: { actions: ["read"] },
};

/** 共享来源 MCP 的 `/web` 视图字段：归属其他组织且公开可读。 */
function sharedMcpFields(overrides: Partial<McpServerInfo> = {}): Partial<McpServerInfo> {
  return {
    scope: { organizationId: "source-org", visibility: "public" },
    access: { actions: ["read"] },
    organizationName: "来源组",
    ...overrides,
  };
}

describe("AgentFormDialog 纯选项映射 round54", () => {
  // 空 MCP 数据表示没有可供 Agent 选择的服务器。
  test("空 MCP 列表映射为空选项", () => {
    expect(mapMcpOptions([])).toEqual([]);
  });

  // 显式禁用的服务器不得出现在 Agent 的可选工具中。
  test("过滤显式禁用的 MCP", () => {
    expect(mapMcpOptions([{ id: "legacy", name: "旧工具", enabled: false }])).toEqual([]);
  });

  // 未声明 enabled 的既有服务器按启用状态兼容处理。
  test("保留未声明启用状态的 MCP", () => {
    expect(mapMcpOptions([{ id: "files", name: "文件" }])).toHaveLength(1);
  });

  // 显式启用的服务器必须可被表单选中。
  test("保留显式启用的 MCP", () => {
    expect(mapMcpOptions([{ id: "search", name: "搜索", enabled: true }])[0].id).toBe("search");
  });

  // 本组织服务器使用名称作为保存时的稳定选择值。
  test("本组织 MCP 使用名称作为 key", () => {
    expect(mapMcpOptions([{ id: "files", name: "filesystem" }])[0].key).toBe("filesystem");
  });

  // 本组织资源没有来源组织前缀，避免向用户展示伪共享信息。
  test("本组织 MCP 标签不附加组织前缀", () => {
    expect(mapMcpOptions([{ id: "files", name: "filesystem" }])[0].label).toBe("filesystem");
  });

  // 跨组织资源以归属组织与资源 id 拼接的 key 区分同名 MCP。
  test("共享 MCP 使用归属组织拼接资源 key", () => {
    const scope = { organizationId: "platform", visibility: "private" } as const;

    expect(mapMcpOptions([{ id: "shared-files", name: "filesystem", ...sharedMcpFields({ scope }) }])[0].key).toBe(
      "platform/shared-files",
    );
  });

  // 共享资源标签必须包含来源组织，供用户辨别资源归属。
  test("共享 MCP 标签包含来源组织", () => {
    expect(
      mapMcpOptions([{ id: "shared-files", name: "filesystem", ...sharedMcpFields({ organizationName: "平台组" }) }])[0]
        .label,
    ).toBe("平台组/filesystem");
  });

  // 缺少来源组织名称时仍应输出可读的原始 MCP 名称。
  test("共享 MCP 缺少来源名称时使用原名称标签", () => {
    expect(
      mapMcpOptions([
        { id: "shared-files", name: "filesystem", ...sharedMcpFields({ organizationName: undefined }) },
      ])[0].label,
    ).toBe("filesystem");
  });

  // 映射仅过滤禁用项，剩余服务器的输入顺序决定展示顺序。
  test("MCP 映射保持启用服务器顺序", () => {
    expect(
      mapMcpOptions([
        { id: "first", name: "文件" },
        { id: "hidden", name: "旧工具", enabled: false },
        { id: "second", name: "搜索" },
      ]).map((option) => option.id),
    ).toEqual(["first", "second"]);
  });

  // MCP 的归属范围应保留原对象，供调用方继续判断共享来源。
  test("MCP 映射保留归属范围引用", () => {
    const scope = { organizationId: "source-org", visibility: "public" } as const;

    expect(mapMcpOptions([{ id: "shared-files", name: "filesystem", ...sharedMcpFields({ scope }) }])[0].scope).toBe(
      scope,
    );
  });

  // 空模型列表表示当前环境尚无可选模型。
  test("空模型列表映射为空选项", () => {
    expect(mapModelOptions([])).toEqual([]);
  });

  // 本组织模型使用短标签，并以 provider 作为组织分组。
  test("本组织模型拼接提供商与模型名称", () => {
    expect(mapModelOptions([createModel({ id: "gpt", providerDisplayName: "OpenAI", displayName: "GPT-5" })])).toEqual([
      {
        value: "gpt",
        label: "GPT-5",
        modelId: "model-name",
        group: { id: "provider-name", label: "OpenAI", scope: "organization" },
      },
    ]);
  });

  // 共享模型用短标签展示，分组 id 取 Provider 资源键，group.scope 标识共享来源。
  test("共享模型按 Provider 资源键分组并标记共享来源", () => {
    expect(
      mapModelOptions([createModel({ ...sharedModelFields, organizationName: "研究组" })], "org-current")[0],
    ).toEqual({
      value: "model-id",
      label: "模型名称",
      modelId: "model-name",
      group: { id: "source-org/provider-uid", label: "提供商名称", scope: "shared" },
    });
  });

  // 共享来源缺少组织展示名时仍按 Provider 分组，不拼接长标签。
  test("共享模型缺少来源名称时不添加空前缀", () => {
    expect(mapModelOptions([createModel(sharedModelFields)], "org-current")[0].label).toBe("模型名称");
  });

  // option value 始终使用模型 UUID，而不是可能重复的模型别名。
  test("模型选项使用模型 id 作为 value", () => {
    expect(mapModelOptions([createModel({ id: "uuid-123", modelId: "共享别名" })])[0].value).toBe("uuid-123");
  });

  // 模型列表顺序代表 API 提供的优先级，不应在表单映射中重排。
  test("模型映射保持输入顺序", () => {
    expect(
      mapModelOptions([createModel({ id: "first" }), createModel({ id: "second" })]).map((option) => option.value),
    ).toEqual(["first", "second"]);
  });
});
