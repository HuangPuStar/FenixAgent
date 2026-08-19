import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _deps,
  _resetDeps,
  type AgentConfigModelMigrationRow,
  migrateAgentConfigModelId,
} from "../services/data-migrates/migrate-agent-config-model-id";

const row = (overrides: Partial<AgentConfigModelMigrationRow> = {}): AgentConfigModelMigrationRow => ({
  id: "agent-1",
  organizationId: "org-1",
  modelId: null,
  model: "provider-a/model-a",
  ...overrides,
});

function configureSuccessfulLegacyLookup(modelId = "model-1") {
  _deps.findLegacyProviders = async (organizationId, name) => [
    { id: "provider-1", organizationId, name, displayName: null },
  ];
  _deps.findModelRow = async () => ({ id: modelId });
}

describe("agent config model id migration boundaries", () => {
  beforeEach(() => {
    _resetDeps();
  });

  afterEach(() => {
    _resetDeps();
  });

  // 已有正式 modelId 的记录必须跳过，避免覆盖用户后来选择的模型。
  test("skips rows that already have a model id", async () => {
    const updates = mock(async () => {});
    _deps.listPendingRows = async () => [row({ modelId: "current-model" })];
    _deps.updateAgentConfigModel = updates;

    await migrateAgentConfigModelId.run();

    expect(updates).not.toHaveBeenCalled();
  });

  // 空的历史字段没有可迁移目标，不应查询 provider 或写库。
  test("skips rows with a null legacy model reference", async () => {
    const providers = mock(async () => []);
    _deps.listPendingRows = async () => [row({ model: null })];
    _deps.findLegacyProviders = providers;

    await migrateAgentConfigModelId.run();

    expect(providers).not.toHaveBeenCalled();
  });

  // 仅包含空白的历史字段也必须跳过，避免把脏数据解释为模型引用。
  test("skips rows with a whitespace-only legacy model reference", async () => {
    const updates = mock(async () => {});
    _deps.listPendingRows = async () => [row({ model: " \n " })];
    _deps.updateAgentConfigModel = updates;

    await migrateAgentConfigModelId.run();

    expect(updates).not.toHaveBeenCalled();
  });

  // 稳定引用应按引用中的组织和 provider ID 查询，而不是按当前行的组织猜测。
  test("migrates a stable organization provider and model reference", async () => {
    const stableProvider = mock(async (organizationId: string, providerId: string) => ({
      id: providerId,
      organizationId,
      name: "provider-name",
      displayName: null,
    }));
    const modelLookup = mock(async (organizationId: string, providerId: string, modelName: string) => {
      expect([organizationId, providerId, modelName]).toEqual(["org-stable", "provider-stable", "nested/model"]);
      return { id: "model-stable" };
    });
    const updates = mock(async () => {});
    _deps.listPendingRows = async () => [row({ model: "org-stable/provider-stable/nested/model" })];
    _deps.findStableProvider = stableProvider;
    _deps.findModelRow = modelLookup;
    _deps.updateAgentConfigModel = updates;

    await migrateAgentConfigModelId.run();

    expect(stableProvider).toHaveBeenCalledWith("org-stable", "provider-stable");
    expect(updates).toHaveBeenCalledWith("agent-1", "model-stable");
  });

  // 稳定引用的模型名允许包含斜杠，避免截断网关命名空间。
  test("preserves all trailing stable reference segments as the model name", async () => {
    const modelLookup = mock(async (_organizationId: string, _providerId: string, modelName: string) => {
      expect(modelName).toBe("family/version/model");
      return { id: "model-1" };
    });
    _deps.listPendingRows = async () => [row({ model: "org-1/provider-1/family/version/model" })];
    _deps.findStableProvider = async () => ({
      id: "provider-1",
      organizationId: "org-1",
      name: "p",
      displayName: null,
    });
    _deps.findModelRow = modelLookup;
    _deps.updateAgentConfigModel = async () => {};

    await migrateAgentConfigModelId.run();

    expect(modelLookup).toHaveBeenCalledTimes(1);
  });

  // 稳定引用缺少 provider 时必须拒绝，防止写入无法归属的 modelId。
  test("fails when a stable reference provider is missing", async () => {
    _deps.listPendingRows = async () => [row({ model: "org-1/provider-gone/model-1" })];
    _deps.findStableProvider = async () => null;

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("missing provider 'org-1/provider-gone'");
  });

  // 稳定引用缺少模型时不得更新历史字段，便于后续修复后重试。
  test("fails without updating when a stable reference model is missing", async () => {
    const updates = mock(async () => {});
    _deps.listPendingRows = async () => [row({ model: "org-1/provider-1/model-gone" })];
    _deps.findStableProvider = async () => ({
      id: "provider-1",
      organizationId: "org-1",
      name: "p",
      displayName: null,
    });
    _deps.findModelRow = async () => null;
    _deps.updateAgentConfigModel = updates;

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("missing model 'model-gone'");
    expect(updates).not.toHaveBeenCalled();
  });

  // 旧引用优先精确匹配 provider name，不能被同名 displayName 抢占。
  test("prefers an exact legacy provider name over display name matches", async () => {
    const modelLookup = mock(async (_org: string, providerId: string) => ({ id: `model-for-${providerId}` }));
    const updates = mock(async () => {});
    _deps.listPendingRows = async () => [row({ model: "openai/gpt" })];
    _deps.findLegacyProviders = async () => [
      { id: "display-match", organizationId: "org-1", name: "other", displayName: "openai" },
      { id: "name-match", organizationId: "org-1", name: "openai", displayName: "Other" },
    ];
    _deps.findModelRow = modelLookup;
    _deps.updateAgentConfigModel = updates;

    await migrateAgentConfigModelId.run();

    expect(modelLookup).toHaveBeenCalledWith("org-1", "name-match", "gpt");
    expect(updates).toHaveBeenCalledWith("agent-1", "model-for-name-match");
  });

  // 无精确 name 时可使用 displayName，兼容历史 UI 保存的提供商名称。
  test("uses a legacy provider display name when no exact name exists", async () => {
    const updates = mock(async () => {});
    _deps.listPendingRows = async () => [row({ model: "OpenAI/gpt" })];
    _deps.findLegacyProviders = async () => [
      { id: "provider-display", organizationId: "org-1", name: "openai-internal", displayName: "OpenAI" },
    ];
    _deps.findModelRow = async () => ({ id: "model-display" });
    _deps.updateAgentConfigModel = updates;

    await migrateAgentConfigModelId.run();

    expect(updates).toHaveBeenCalledWith("agent-1", "model-display");
  });

  // 历史查询结果没有同名候选时采用首项，保持旧数据的可迁移性。
  test("falls back to the first legacy provider candidate", async () => {
    const modelLookup = mock(async (_org: string, providerId: string) => ({ id: providerId }));
    _deps.listPendingRows = async () => [row({ model: "legacy/gpt" })];
    _deps.findLegacyProviders = async () => [
      { id: "first", organizationId: "org-1", name: "renamed", displayName: null },
      { id: "second", organizationId: "org-1", name: "also-renamed", displayName: null },
    ];
    _deps.findModelRow = modelLookup;
    _deps.updateAgentConfigModel = async () => {};

    await migrateAgentConfigModelId.run();

    expect(modelLookup).toHaveBeenCalledWith("org-1", "first", "gpt");
  });

  // 旧引用中缺少分隔符必须拒绝，不能把完整字符串当成 provider。
  test("rejects a legacy reference without a separator", async () => {
    _deps.listPendingRows = async () => [row({ model: "not-a-reference" })];

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("invalid legacy model ref 'not-a-reference'");
  });

  // 旧引用以斜杠开头没有 provider，必须拒绝越界格式。
  test("rejects a legacy reference without a provider name", async () => {
    _deps.listPendingRows = async () => [row({ model: "/model" })];

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("invalid legacy model ref '/model'");
  });

  // 旧引用以斜杠结尾没有模型，必须拒绝部分格式。
  test("rejects a legacy reference without a model name", async () => {
    _deps.listPendingRows = async () => [row({ model: "provider/" })];

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("invalid legacy model ref 'provider/' ".trim());
  });

  // provider 缺失时错误必须带当前组织，避免多租户迁移排障误判。
  test("includes the row organization in legacy provider failures", async () => {
    _deps.listPendingRows = async () => [row({ organizationId: "org-isolated", model: "missing/model" })];
    _deps.findLegacyProviders = async () => [];

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("org='org-isolated'");
  });

  // 模型查询必须限制在选中 provider 的组织，避免跨租户关联同名模型。
  test("uses the selected provider organization for legacy model lookup", async () => {
    const modelLookup = mock(async (organizationId: string) => {
      expect(organizationId).toBe("provider-org");
      return { id: "model-1" };
    });
    _deps.listPendingRows = async () => [row({ organizationId: "row-org" })];
    _deps.findLegacyProviders = async () => [
      { id: "provider-1", organizationId: "provider-org", name: "provider-a", displayName: null },
    ];
    _deps.findModelRow = modelLookup;
    _deps.updateAgentConfigModel = async () => {};

    await migrateAgentConfigModelId.run();

    expect(modelLookup).toHaveBeenCalledTimes(1);
  });

  // 多条有效记录必须按扫描顺序写入，保持迁移过程可审计。
  test("updates multiple valid rows in source order", async () => {
    const updates: string[] = [];
    _deps.listPendingRows = async () => [row({ id: "first" }), row({ id: "second", model: "provider-a/model-b" })];
    configureSuccessfulLegacyLookup();
    _deps.updateAgentConfigModel = async (id) => {
      updates.push(id);
    };

    await migrateAgentConfigModelId.run();

    expect(updates).toEqual(["first", "second"]);
  });

  // 中途失败时后续记录不得继续写入，避免掩盖迁移失败。
  test("stops processing after a failing row", async () => {
    const updates = mock(async () => {});
    _deps.listPendingRows = async () => [row({ id: "bad", model: "invalid" }), row({ id: "later" })];
    _deps.updateAgentConfigModel = updates;

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("invalid legacy model ref");
    expect(updates).not.toHaveBeenCalled();
  });

  // 成功迁移必须记录已迁移的配置 ID，提供数据修复的审计信号。
  test("logs each successful migration with its agent config id", async () => {
    const logs: string[] = [];
    _deps.listPendingRows = async () => [row({ id: "agent-a" })];
    configureSuccessfulLegacyLookup();
    _deps.updateAgentConfigModel = async () => {};
    _deps.log = (message: string) => {
      logs.push(message);
    };

    await migrateAgentConfigModelId.run();

    expect(logs).toEqual(["[data-migrate] migrated agentConfig model id='agent-a'"]);
  });

  // 写入失败时不能记录成功日志，避免误导后续的数据修复操作。
  test("does not log success when persisting a migration fails", async () => {
    const logs = mock(() => {});
    _deps.listPendingRows = async () => [row({ id: "write-failure" })];
    configureSuccessfulLegacyLookup();
    _deps.updateAgentConfigModel = async () => {
      throw new Error("write unavailable");
    };
    _deps.log = logs;

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("write unavailable");

    expect(logs).not.toHaveBeenCalled();
  });

  // 跳过记录不应产生日志，避免把未修改数据误报为完成。
  test("does not log skipped rows", async () => {
    const logs = mock(() => {});
    _deps.listPendingRows = async () => [row({ modelId: "already-set" }), row({ model: "" })];
    _deps.log = logs;

    await migrateAgentConfigModelId.run();

    expect(logs).not.toHaveBeenCalled();
  });
});
