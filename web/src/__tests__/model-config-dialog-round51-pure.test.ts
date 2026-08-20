import { describe, expect, test } from "bun:test";
import { mergeModelConfigUpdate } from "../../components/config/ModelConfigDialog";
import { buildModelOptions } from "../lib/model-config-utils";
import type { ModelConfig, ModelEntry, ResourceAccess } from "../types/config";

function modelEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "entry-1",
    modelId: "model-1",
    displayName: "Model One",
    provider: "provider-1",
    providerDisplayName: "Provider One",
    contextLimit: 128000,
    outputLimit: 8192,
    ...overrides,
  };
}

function providerAccess(sourceOrganizationName: string): ResourceAccess {
  return {
    ownership: "external",
    sourceOrganizationId: "source-org",
    sourceOrganizationName,
    resourceUid: "provider-uid",
    resourceKey: "source-org/provider",
    manageable: false,
    writable: false,
  };
}

function modelConfig(overrides: Partial<ModelConfig["current"]> = {}): ModelConfig {
  return {
    current: {
      model: "provider-1/model-1",
      small_model: "provider-1/model-small",
      permission: "ask",
      ...overrides,
    },
    available: [modelEntry()],
  };
}

describe("ModelConfigDialog 纯转换", () => {
  // 空列表应保持为空，不凭空生成模型选项。
  test("空 available 返回空选项", () => {
    expect(buildModelOptions([])).toEqual([]);
  });

  // 没有资源键时应兼容旧格式，使用 provider 和 modelId 拼接值。
  test("无 providerResourceKey 时使用旧值格式", () => {
    expect(buildModelOptions([modelEntry()])[0]?.value).toBe("provider-1/model-1");
  });

  // 有资源键时应优先使用资源键，避免不同资源中的 provider 冲突。
  test("有 providerResourceKey 时使用资源值格式", () => {
    expect(buildModelOptions([modelEntry({ providerResourceKey: "resource-a" })])[0]?.value).toBe("resource-a/model-1");
  });

  // 没有来源组织时，标签应只包含 provider 显示名和模型显示名。
  test("无 sourceOrganizationName 时省略来源组织", () => {
    expect(buildModelOptions([modelEntry()])[0]?.label).toBe("Provider One/Model One");
  });

  // 有来源组织时，标签应保留来源组织、provider 和模型三级信息。
  test("有 sourceOrganizationName 时加入来源组织", () => {
    const entry = modelEntry({ providerResourceAccess: providerAccess("Org A") });
    expect(buildModelOptions([entry])[0]?.label).toBe("Org A/Provider One/Model One");
  });

  // 来源组织为空字符串时应按缺失处理，避免出现多余的斜杠。
  test("空 sourceOrganizationName 回退到 provider 标签", () => {
    const entry = modelEntry({ providerResourceAccess: providerAccess("") });
    expect(buildModelOptions([entry])[0]?.label).toBe("Provider One/Model One");
  });

  // 多个模型的输出顺序应与输入顺序一致，便于稳定显示。
  test("保留 available 的输入顺序", () => {
    const entries = [modelEntry({ modelId: "first" }), modelEntry({ modelId: "second" })];
    expect(buildModelOptions(entries).map((option) => option.value)).toEqual(["provider-1/first", "provider-1/second"]);
  });

  // 相同输入记录不应被去重，因为每条记录都代表一个可选项。
  test("保留重复模型记录", () => {
    const entry = modelEntry();
    expect(buildModelOptions([entry, entry])).toHaveLength(2);
  });

  // 模型 ID 中的特殊字符应原样保留，只进行字段拼接。
  test("原样保留特殊模型 ID", () => {
    const entry = modelEntry({ modelId: "model/v2:latest" });
    expect(buildModelOptions([entry])[0]?.value).toBe("provider-1/model/v2:latest");
  });

  // provider 显示名中的特殊字符应原样进入标签。
  test("原样保留特殊 provider 显示名", () => {
    const entry = modelEntry({ providerDisplayName: "Provider / EU" });
    expect(buildModelOptions([entry])[0]?.label).toBe("Provider / EU/Model One");
  });

  // 显示名为空时仍应生成确定的分隔格式，而不是丢弃该模型。
  test("空 displayName 仍生成模型选项", () => {
    const entry = modelEntry({ displayName: "" });
    expect(buildModelOptions([entry])[0]).toEqual({ value: "provider-1/model-1", label: "Provider One/" });
  });

  // 转换过程不应改写输入数组本身。
  test("buildModelOptions 不修改输入数组", () => {
    const entries = [modelEntry()];
    const snapshot = structuredClone(entries);
    buildModelOptions(entries);
    expect(entries).toEqual(snapshot);
  });

  // 转换过程不应改写输入模型对象本身。
  test("buildModelOptions 不修改输入模型对象", () => {
    const entry = modelEntry();
    const snapshot = structuredClone(entry);
    buildModelOptions([entry]);
    expect(entry).toEqual(snapshot);
  });

  // 只更新主模型时，小模型和权限应保持原值。
  test("只合并 model 字段", () => {
    const current = modelConfig();
    expect(mergeModelConfigUpdate(current, { model: "resource-a/new-model" }).current).toEqual({
      model: "resource-a/new-model",
      small_model: "provider-1/model-small",
      permission: "ask",
    });
  });

  // 只更新轻量模型时，主模型和权限应保持原值。
  test("只合并 small_model 字段", () => {
    const current = modelConfig();
    expect(mergeModelConfigUpdate(current, { small_model: "resource-a/small" }).current).toEqual({
      model: "provider-1/model-1",
      small_model: "resource-a/small",
      permission: "ask",
    });
  });

  // 只更新权限时，两个模型字段应保持原值。
  test("只合并 permission 字段", () => {
    const current = modelConfig();
    expect(mergeModelConfigUpdate(current, { permission: "deny" }).current).toEqual({
      model: "provider-1/model-1",
      small_model: "provider-1/model-small",
      permission: "deny",
    });
  });

  // 同时提供全部字段时，三个字段都应采用更新值。
  test("一次合并全部 current 字段", () => {
    const update = { model: "m2", small_model: "s2", permission: { bash: "allow" as const } };
    expect(mergeModelConfigUpdate(modelConfig(), update).current).toEqual(update);
  });

  // 缺失字段不能把已有值覆盖成 undefined。
  test("忽略缺失字段而非写入 undefined", () => {
    const result = mergeModelConfigUpdate(modelConfig(), {});
    expect(result.current).toEqual(modelConfig().current);
  });

  // 显式 null 是有效更新，应能清空对应模型字段。
  test("保留显式 null 更新值", () => {
    expect(mergeModelConfigUpdate(modelConfig(), { model: null }).current.model).toBeNull();
  });

  // 合并结果应保留 available 引用和值，不改变页面级数据。
  test("保留 available 数据", () => {
    const current = modelConfig();
    const result = mergeModelConfigUpdate(current, { model: "m2" });
    expect(result.available).toBe(current.available);
    expect(result.available).toEqual(current.available);
  });

  // 合并应创建新的顶层对象，避免直接修改原配置。
  test("创建新的顶层配置对象", () => {
    const current = modelConfig();
    expect(mergeModelConfigUpdate(current, { model: "m2" })).not.toBe(current);
  });

  // 合并应创建新的 current 对象，避免共享可变的 current 状态。
  test("创建新的 current 对象", () => {
    const current = modelConfig();
    expect(mergeModelConfigUpdate(current, { model: "m2" }).current).not.toBe(current.current);
  });
});

export type { ModelConfig, ModelEntry };
