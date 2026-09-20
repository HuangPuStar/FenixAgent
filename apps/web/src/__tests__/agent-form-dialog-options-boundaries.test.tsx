import { describe, expect, test } from "bun:test";
import type { McpServerInfo, ModelEntry } from "@fenix/web-runtime/types/config";
import {
  mapMcpOptions,
  mapModelOptions,
} from "../../../../packages/resources/agent-config/web/pages/agent-panel/agent-editor/agent-editor-model";

/** 共享来源模型的 `/web` 视图字段：归属其他组织且只有读动作。 */
const sharedModelFields: Partial<ModelEntry> = {
  providerId: "provider-uid",
  scope: { organizationId: "org-source", visibility: "private" },
  access: { actions: ["read"] },
  organizationName: "Source Team",
};

/** 共享来源 MCP 的 `/web` 视图字段：归属其他组织且公开可读。 */
function sharedMcpFields(overrides: Partial<McpServerInfo> = {}): Partial<McpServerInfo> {
  return {
    scope: { organizationId: "org-source", visibility: "public" },
    access: { actions: ["read"] },
    organizationName: "Source Team",
    ...overrides,
  };
}

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "model-1",
    modelId: "gpt-1",
    displayName: "Model One",
    provider: "provider-1",
    providerDisplayName: "Provider One",
    contextLimit: null,
    outputLimit: null,
    ...overrides,
  };
}

describe("AgentFormDialog 选项数据转换边界", () => {
  // MCP 选项应保留启用服务器的业务标识。
  test("转换启用 MCP 的 id", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files" }])[0].id).toBe("mcp-1");
  });

  // MCP 选项应保留原始名称，供保存配置时使用。
  test("转换启用 MCP 的 name", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files" }])[0].name).toBe("files");
  });

  // 本组织 MCP 缺少归属范围时使用名称作为稳定 key。
  test("本组织 MCP 使用名称作为 key", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files" }])[0].key).toBe("files");
  });

  // 本组织 MCP 的展示名称不应附加不存在的组织前缀。
  test("本组织 MCP 使用原名称作为标签", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files" }])[0].label).toBe("files");
  });

  // 未设置 enabled 的 MCP 按默认启用处理。
  test("缺省 enabled 的 MCP 被保留", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files" }])).toHaveLength(1);
  });

  // 显式启用的 MCP 必须出现在表单选项中。
  test("显式启用的 MCP 被保留", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files", enabled: true }])).toHaveLength(1);
  });

  // 显式禁用的 MCP 不得泄漏到可选择列表。
  test("显式禁用的 MCP 被过滤", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files", enabled: false }])).toEqual([]);
  });

  // 禁用项在数组首位时不应影响后续启用项的顺序。
  test("过滤禁用 MCP 后保持启用项顺序", () => {
    expect(
      mapMcpOptions([
        { id: "disabled", name: "old", enabled: false },
        { id: "first", name: "files" },
        { id: "second", name: "search" },
      ]).map((option) => option.id),
    ).toEqual(["first", "second"]);
  });

  // 全部 MCP 禁用时应产生空选项，而不是保留占位数据。
  test("全部禁用 MCP 返回空数组", () => {
    expect(
      mapMcpOptions([
        { id: "mcp-1", name: "files", enabled: false },
        { id: "mcp-2", name: "search", enabled: false },
      ]),
    ).toEqual([]);
  });

  // 空输入是合法边界，应保持为空。
  test("空 MCP 列表返回空数组", () => {
    expect(mapMcpOptions([])).toEqual([]);
  });

  // 共享 MCP 应使用归属组织与资源 id 拼接的稳定 key，避免同名资源冲突。
  test("共享 MCP 使用归属组织与资源 id 作为 key", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files", ...sharedMcpFields() }])[0].key).toBe("org-source/mcp-1");
  });

  // 共享 MCP 标签应包含来源组织，区分跨组织同名资源。
  test("共享 MCP 标签包含来源组织", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files", ...sharedMcpFields() }])[0].label).toBe("Source Team/files");
  });

  // 归属范围必须按引用传递，供调用方继续判断资源来源与权限。
  test("共享 MCP 保留归属范围引用", () => {
    const scope = { organizationId: "org-source", visibility: "public" } as const;
    expect(mapMcpOptions([{ id: "mcp-1", name: "files", ...sharedMcpFields({ scope }) }])[0].scope).toBe(scope);
  });

  // 缺少归属范围时无法推导跨组织 key，回退到资源名。
  test("缺少归属范围时回退到资源名", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files" }])[0].key).toBe("files");
  });

  // 归属组织按原值参与 key 推导，不得被改写或截断。
  test("归属组织按原值参与 key 推导", () => {
    const scope = { organizationId: "org-source/legacy", visibility: "private" } as const;
    expect(mapMcpOptions([{ id: "mcp-1", name: "files", ...sharedMcpFields({ scope }) }])[0].key).toBe(
      "org-source/legacy/mcp-1",
    );
  });

  // 空来源组织名不应生成多余斜杠前缀。
  test("空来源组织名使用 MCP 原名称", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files", ...sharedMcpFields({ organizationName: "" }) }])[0].label).toBe(
      "files",
    );
  });

  // 缺失来源组织名时共享标记不应影响基础展示名称。
  test("缺失来源组织名使用 MCP 原名称", () => {
    expect(
      mapMcpOptions([{ id: "mcp-1", name: "files", ...sharedMcpFields({ organizationName: undefined }) }])[0].label,
    ).toBe("files");
  });

  // 转换不能改变调用方传入的 MCP 数组内容。
  test("转换 MCP 不修改输入数组", () => {
    const servers = [{ id: "mcp-1", name: "files", enabled: false }];
    mapMcpOptions(servers);
    expect(servers).toEqual([{ id: "mcp-1", name: "files", enabled: false }]);
  });

  // 转换不能改变调用方传入的 MCP 对象。
  test("转换 MCP 不修改输入对象", () => {
    const server = { id: "mcp-1", name: "files", ...sharedMcpFields() };
    mapMcpOptions([server]);
    expect(server).toEqual({ id: "mcp-1", name: "files", ...sharedMcpFields() });
  });

  // 每次转换应产生新的数组，避免调用方共享可变容器。
  test("每次 MCP 转换返回新数组", () => {
    const servers = [{ id: "mcp-1", name: "files" }];
    expect(mapMcpOptions(servers)).not.toBe(mapMcpOptions(servers));
  });

  // 模型选项 value 必须使用数据库 id，而非可变的 modelId。
  test("模型选项使用 id 作为 value", () => {
    expect(mapModelOptions([model({ id: "uuid-1", modelId: "provider/model" })]).map((option) => option.value)).toEqual(
      ["uuid-1"],
    );
  });

  // 模型名称带英文括号时只展示括号内名称，避免重复展示外部别名。
  test("模型名称提取英文括号内容", () => {
    expect(mapModelOptions([model({ displayName: "Claude 4.1 (claude-opus-4-1)" })])[0].label).toBe("claude-opus-4-1");
  });

  // 模型名称带中文括号时遵循相同规则，并去除括号内首尾空白。
  test("模型名称提取中文括号内容", () => {
    expect(mapModelOptions([model({ displayName: "通义千问（ qwen-max ）" })])[0].label).toBe("qwen-max");
  });

  // 没有括号的模型名称必须直接显示原值。
  test("无括号模型名称保持原值", () => {
    expect(mapModelOptions([model({ displayName: "Model One" })])[0].label).toBe("Model One");
  });

  // 本组织模型使用短模型名，并将 Provider 作为独立分组信息。
  test("本组织模型拆分 Provider 与模型标签", () => {
    expect(mapModelOptions([model()])[0]).toMatchObject({
      label: "Model One",
      modelId: "gpt-1",
      group: { id: "provider-1", label: "Provider One", scope: "organization" },
    });
  });

  // 共享模型仍使用短模型名，分组 id 取 Provider 资源键、scope 表达来源范围。
  test("共享模型保留 Provider 资源键分组与来源范围", () => {
    expect(mapModelOptions([model(sharedModelFields)], "org-current")[0]).toMatchObject({
      label: "Model One",
      modelId: "gpt-1",
      group: { id: "org-source/provider-uid", label: "Provider One", scope: "shared" },
    });
  });

  // 空来源组织展示名不影响短模型名，Provider 分组仍保留。
  test("空模型来源组织名不影响分组", () => {
    expect(mapModelOptions([model({ ...sharedModelFields, organizationName: "" })], "org-current")[0]).toMatchObject({
      label: "Model One",
      group: { label: "Provider One", scope: "shared" },
    });
  });

  // 缺失来源组织展示名不影响短模型名和共享 Provider 分组。
  test("缺失模型来源组织名不影响分组", () => {
    const { organizationName: _organizationName, ...modelWithoutOrganizationName } = sharedModelFields;
    expect(mapModelOptions([model(modelWithoutOrganizationName)], "org-current")[0]).toMatchObject({
      label: "Model One",
      group: { label: "Provider One", scope: "shared" },
    });
  });

  // 模型映射必须保留输入排列顺序，确保下拉选项稳定。
  test("模型转换保持输入顺序", () => {
    expect(
      mapModelOptions([
        model({ id: "second", displayName: "Second" }),
        model({ id: "first", displayName: "First" }),
      ]).map((option) => option.value),
    ).toEqual(["second", "first"]);
  });

  // 空模型列表应安全转换为空选项列表。
  test("空模型列表返回空数组", () => {
    expect(mapModelOptions([])).toEqual([]);
  });

  // 相同展示名的模型仍须保留各自的稳定 id。
  test("同名模型保留不同 value", () => {
    expect(mapModelOptions([model({ id: "model-a" }), model({ id: "model-b" })]).map((option) => option.value)).toEqual(
      ["model-a", "model-b"],
    );
  });

  // 模型显示名为空时应原样保留，而不是擅自填充 modelId。
  test("空模型显示名保持为空", () => {
    expect(mapModelOptions([model({ displayName: "" })])[0].label).toBe("");
  });

  // Provider 显示名为空时只影响独立分组，不污染短模型名。
  test("空 Provider 显示名保留模型短名称", () => {
    expect(mapModelOptions([model({ providerDisplayName: "" })])[0]).toMatchObject({
      label: "Model One",
      group: { label: "" },
    });
  });

  // 模型转换不得修改输入数组。
  test("转换模型不修改输入数组", () => {
    const models = [model({ id: "model-1" })];
    mapModelOptions(models);
    expect(models.map((item) => item.id)).toEqual(["model-1"]);
  });

  // 模型转换不得修改输入对象的归属与动作描述。
  test("转换模型不修改输入归属描述", () => {
    const input = model(sharedModelFields);
    const snapshot = structuredClone(input);
    mapModelOptions([input], "org-current");
    expect(input).toEqual(snapshot);
  });

  // 每次模型转换都应产生独立数组，防止结果容器被复用。
  test("每次模型转换返回新数组", () => {
    const models = [model()];
    expect(mapModelOptions(models)).not.toBe(mapModelOptions(models));
  });

  // 模型转换结果不应复用输入对象，避免意外写入领域模型。
  test("模型转换返回独立选项对象", () => {
    const input = model();
    expect(mapModelOptions([input])[0]).not.toBe(input);
  });

  // MCP 转换结果不应复用输入对象，避免意外写入服务配置。
  test("MCP 转换返回独立选项对象", () => {
    const input = { id: "mcp-1", name: "files" };
    expect(mapMcpOptions([input])[0]).not.toBe(input);
  });

  // 多个共享 MCP 应分别按各自归属组织推导资源 key。
  test("多个共享 MCP 保留各自资源 key", () => {
    expect(
      mapMcpOptions([
        { id: "mcp-1", name: "files", ...sharedMcpFields({ scope: { organizationId: "org", visibility: "private" } }) },
        {
          id: "mcp-2",
          name: "search",
          ...sharedMcpFields({ scope: { organizationId: "team", visibility: "public" } }),
        },
      ]).map((option) => option.key),
    ).toEqual(["org/mcp-1", "team/mcp-2"]);
  });

  // 混合本组织和共享 MCP 时应分别使用对应的展示策略。
  test("混合 MCP 使用各自标签策略", () => {
    expect(
      mapMcpOptions([
        { id: "local", name: "files" },
        { id: "shared", name: "search", ...sharedMcpFields() },
      ]).map((option) => option.label),
    ).toEqual(["files", "Source Team/search"]);
  });

  // 混合本组织和共享模型时均保留稳定短名称，并分别标记 Provider 范围。
  test("混合模型使用短名称与独立范围", () => {
    const options = mapModelOptions(
      [model({ id: "local" }), model({ id: "shared", ...sharedModelFields })],
      "org-current",
    );
    expect(options.map((option) => option.label)).toEqual(["Model One", "Model One"]);
    expect(options.map((option) => option.group.scope)).toEqual(["organization", "shared"]);
  });

  // 授权动作不应影响 MCP 的可选性，启用状态才是过滤依据。
  test("只读共享 MCP 仍可作为选项", () => {
    expect(mapMcpOptions([{ id: "mcp-1", name: "files", ...sharedMcpFields() }])).toHaveLength(1);
  });

  // modelId 内容不应改变短标签，但必须作为品牌图标映射键保留。
  test("模型标签不依赖 modelId 内容", () => {
    expect(mapModelOptions([model({ modelId: "unexpected/internal-id" })])[0]).toMatchObject({
      label: "Model One",
      modelId: "unexpected/internal-id",
    });
  });
});
