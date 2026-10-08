import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _deps, _resetDeps, migrateAgentConfigModelId } from "@fenix/agent-config/db/migration";
import type { DataMigrationContext } from "@fenix/platform-sdk";

/** 执行上下文由 runner 注入（§6.3）；用例用同一替身承接 log 与 warn，按调用断言实际输出的可观测字段。 */
function createContext(log: (...args: unknown[]) => void = () => {}): DataMigrationContext {
  return { log: (message: string) => log(message), warn: (message: string) => log(message) };
}

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

    await migrateAgentConfigModelId.run(createContext());

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

    await expect(migrateAgentConfigModelId.run(createContext())).rejects.toThrow("missing legacy provider");
  });

  // 校验从目标侧断言「没有留下旧引用」：仍有待迁移行时必须失败，否则会带着半迁移状态写完成记录。
  test("verify reports rows that still carry a legacy model ref", async () => {
    _deps.listPendingRows = async () => [
      { id: "agc_done", organizationId: "org_current", modelId: "model_demo", model: null },
      { id: "agc_pending", organizationId: "org_current", modelId: null, model: "openai/gpt-4o" },
    ];

    await expect(migrateAgentConfigModelId.verify(createContext())).rejects.toThrow(
      "仍有 1 个 agentConfig 的历史 model 引用未迁移到 modelId（如 'agc_pending'）",
    );
  });

  // 全部行都已是正式 modelId 或本就无旧引用时校验通过，保证重跑同一条迁移不会误判为未完成。
  test("verify passes when no row keeps a legacy model ref", async () => {
    _deps.listPendingRows = async () => [
      { id: "agc_done", organizationId: "org_current", modelId: "model_demo", model: null },
      { id: "agc_blank", organizationId: "org_current", modelId: null, model: "  " },
    ];

    await expect(migrateAgentConfigModelId.verify(createContext())).resolves.toBeUndefined();
  });
});
