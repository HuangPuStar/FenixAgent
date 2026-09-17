import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _deps, _resetDeps, migrateAgentConfigModelId } from "../services/data-migrates/migrate-agent-config-model-id";

describe("migrate agent config model id", () => {
  beforeEach(() => {
    _resetDeps();
  });

  afterEach(() => {
    _resetDeps();
  });

  // 旧 providerName/modelName 引用会被解析成真实 model 外键，并清空 legacy 字段。
  test("migrates legacy model refs into model ids", async () => {
    const updates: Array<{ agentConfigId: string; nextModelId: string }> = [];

    _deps.listPendingRows = async () => [
      {
        id: "agc_1",
        organizationId: "org_current",
        modelId: null,
        model: "openai/gpt-4o",
      },
    ];
    _deps.findLegacyProviders = async () => [
      {
        id: "provider_demo",
        organizationId: "org_current",
        name: "openai",
        displayName: "OpenAI",
      },
    ];
    _deps.findModelRow = async () => ({ id: "model_demo" });
    _deps.updateAgentConfigModel = mock(async (agentConfigId: string, nextModelId: string) => {
      updates.push({ agentConfigId, nextModelId });
    });
    _deps.log = mock(() => {});

    await migrateAgentConfigModelId.run();

    expect(updates).toEqual([{ agentConfigId: "agc_1", nextModelId: "model_demo" }]);
  });

  // 无法解析 provider 时必须失败，避免把半迁移状态写进 data_migrate_record。
  test("throws when legacy provider is missing", async () => {
    _deps.listPendingRows = async () => [
      {
        id: "agc_2",
        organizationId: "org_current",
        modelId: null,
        model: "missing/gpt-4o",
      },
    ];
    _deps.findLegacyProviders = async () => [];
    _deps.log = mock(() => {});

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("missing legacy provider");
  });
});
