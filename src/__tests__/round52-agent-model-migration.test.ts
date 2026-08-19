import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _deps,
  _resetDeps,
  type AgentConfigModelMigrationRow,
  migrateAgentConfigModelId,
} from "../services/data-migrates/migrate-agent-config-model-id";

type ProviderRow = {
  id: string;
  organizationId: string;
  name: string;
  displayName: string | null;
};

type StubDb = ReturnType<typeof stubDb>;

const migrationRow = (overrides: Partial<AgentConfigModelMigrationRow> = {}): AgentConfigModelMigrationRow => ({
  id: "agent-1",
  organizationId: "org-1",
  modelId: null,
  model: "openai/gpt-4o",
  ...overrides,
});

function stubDb(
  rows: AgentConfigModelMigrationRow[],
  providers: ProviderRow[] = [],
  models: Array<{ id: string; organizationId: string; providerId: string; modelId: string }> = [],
) {
  const records = rows.map((row) => ({ ...row }));
  const updates: Array<{ agentConfigId: string; nextModelId: string }> = [];
  const logs: string[] = [];
  const stableProviderQueries: Array<[string, string]> = [];
  const legacyProviderQueries: Array<[string, string]> = [];
  const modelQueries: Array<[string, string, string]> = [];

  _deps.listPendingRows = async () => records.map((row) => ({ ...row }));
  _deps.findStableProvider = async (organizationId, providerId) => {
    stableProviderQueries.push([organizationId, providerId]);
    return (
      providers.find((provider) => provider.organizationId === organizationId && provider.id === providerId) ?? null
    );
  };
  _deps.findLegacyProviders = async (organizationId, providerName) => {
    legacyProviderQueries.push([organizationId, providerName]);
    return providers.filter(
      (provider) =>
        provider.organizationId === organizationId &&
        (provider.name === providerName || provider.displayName === providerName),
    );
  };
  _deps.findModelRow = async (organizationId, providerId, modelName) => {
    modelQueries.push([organizationId, providerId, modelName]);
    return (
      models.find(
        (model) =>
          model.organizationId === organizationId && model.providerId === providerId && model.modelId === modelName,
      ) ?? null
    );
  };
  _deps.updateAgentConfigModel = async (agentConfigId, nextModelId) => {
    const record = records.find((row) => row.id === agentConfigId);
    if (!record) throw new Error(`unknown agent config '${agentConfigId}'`);
    record.modelId = nextModelId;
    record.model = null;
    updates.push({ agentConfigId, nextModelId });
  };
  _deps.log = (message) => {
    logs.push(message);
  };

  return { records, updates, logs, stableProviderQueries, legacyProviderQueries, modelQueries };
}

function legacyFixture(row = migrationRow()): StubDb {
  return stubDb(
    [row],
    [{ id: "provider-openai", organizationId: row.organizationId, name: "openai", displayName: "OpenAI" }],
    [{ id: "model-gpt-4o", organizationId: row.organizationId, providerId: "provider-openai", modelId: "gpt-4o" }],
  );
}

describe("round52 agent config model migration", () => {
  beforeEach(() => {
    _resetDeps();
  });

  afterEach(() => {
    _resetDeps();
  });

  // 没有待迁移记录时不应产生任何查询或写入。
  test("空记录集不执行查找和更新", async () => {
    const db = stubDb([]);

    await migrateAgentConfigModelId.run();

    expect(db.updates).toEqual([]);
    expect(db.stableProviderQueries).toEqual([]);
    expect(db.legacyProviderQueries).toEqual([]);
  });

  // 已有 modelId 的记录必须保留，重复执行迁移也不能覆盖它。
  test("已有正式模型的记录保持不变", async () => {
    const db = legacyFixture(migrationRow({ modelId: "chosen-model" }));

    await migrateAgentConfigModelId.run();

    expect(db.records[0]).toMatchObject({ modelId: "chosen-model", model: "openai/gpt-4o" });
    expect(db.updates).toEqual([]);
  });

  // null 历史模型没有可解析内容，应直接跳过。
  test("null 历史模型不查询提供商", async () => {
    const db = legacyFixture(migrationRow({ model: null }));

    await migrateAgentConfigModelId.run();

    expect(db.legacyProviderQueries).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  // 仅空白字符的历史模型不应被当作模型引用。
  test("空白历史模型不更新记录", async () => {
    const db = legacyFixture(migrationRow({ model: " \n\t " }));

    await migrateAgentConfigModelId.run();

    expect(db.modelQueries).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  // 稳定引用前后的空白应被清理后再解析。
  test("稳定引用会先去除首尾空白", async () => {
    const db = stubDb(
      [migrationRow({ model: "  org-stable/provider-stable/model-stable  " })],
      [{ id: "provider-stable", organizationId: "org-stable", name: "stable", displayName: null }],
      [{ id: "model-stable", organizationId: "org-stable", providerId: "provider-stable", modelId: "model-stable" }],
    );

    await migrateAgentConfigModelId.run();

    expect(db.stableProviderQueries).toEqual([["org-stable", "provider-stable"]]);
    expect(db.updates).toEqual([{ agentConfigId: "agent-1", nextModelId: "model-stable" }]);
  });

  // 稳定引用必须使用引用中的组织，不能从当前行组织推断目标。
  test("稳定引用按引用组织隔离查找", async () => {
    const db = stubDb(
      [migrationRow({ organizationId: "row-org", model: "target-org/provider-1/gpt" })],
      [
        { id: "provider-1", organizationId: "row-org", name: "wrong", displayName: null },
        { id: "provider-1", organizationId: "target-org", name: "right", displayName: null },
      ],
      [{ id: "target-model", organizationId: "target-org", providerId: "provider-1", modelId: "gpt" }],
    );

    await migrateAgentConfigModelId.run();

    expect(db.modelQueries).toEqual([["target-org", "provider-1", "gpt"]]);
    expect(db.updates[0]?.nextModelId).toBe("target-model");
  });

  // 稳定引用的模型名可包含额外斜杠，必须完整保留。
  test("稳定引用保留模型名中的斜杠", async () => {
    const db = stubDb(
      [migrationRow({ model: "org-1/provider-1/family/version/model" })],
      [{ id: "provider-1", organizationId: "org-1", name: "provider", displayName: null }],
      [{ id: "nested-model", organizationId: "org-1", providerId: "provider-1", modelId: "family/version/model" }],
    );

    await migrateAgentConfigModelId.run();

    expect(db.modelQueries).toEqual([["org-1", "provider-1", "family/version/model"]]);
  });

  // 稳定引用找不到 provider 时必须失败且不写入。
  test("稳定引用缺少提供商时中止", async () => {
    const db = stubDb([migrationRow({ model: "org-1/missing/gpt" })]);

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("missing provider 'org-1/missing'");
    expect(db.updates).toEqual([]);
  });

  // 稳定引用的 provider 存在但模型不存在时不能清空旧字段。
  test("稳定引用缺少模型时保留旧字段", async () => {
    const db = stubDb(
      [migrationRow({ model: "org-1/provider-1/gone" })],
      [{ id: "provider-1", organizationId: "org-1", name: "provider", displayName: null }],
    );

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("missing model 'gone'");
    expect(db.records[0]).toMatchObject({ modelId: null, model: "org-1/provider-1/gone" });
  });

  // 旧格式候选同时匹配 name 和 displayName 时，name 必须优先。
  test("旧格式优先匹配提供商 name", async () => {
    const db = stubDb(
      [migrationRow({ model: "openai/gpt" })],
      [
        { id: "display", organizationId: "org-1", name: "other", displayName: "openai" },
        { id: "name", organizationId: "org-1", name: "openai", displayName: "Other" },
      ],
      [{ id: "name-model", organizationId: "org-1", providerId: "name", modelId: "gpt" }],
    );

    await migrateAgentConfigModelId.run();

    expect(db.modelQueries).toEqual([["org-1", "name", "gpt"]]);
  });

  // 旧格式没有 name 命中时，可通过 displayName 兼容 UI 保存的名称。
  test("旧格式可通过提供商显示名匹配", async () => {
    const db = stubDb(
      [migrationRow({ model: "OpenAI/gpt" })],
      [{ id: "display", organizationId: "org-1", name: "openai-internal", displayName: "OpenAI" }],
      [{ id: "display-model", organizationId: "org-1", providerId: "display", modelId: "gpt" }],
    );

    await migrateAgentConfigModelId.run();

    expect(db.updates[0]?.nextModelId).toBe("display-model");
  });

  // 查询层返回未精确匹配的候选时，迁移使用首个候选保持历史兼容。
  test("旧格式回退到第一个提供商候选", async () => {
    const db = stubDb(
      [migrationRow({ model: "legacy/gpt" })],
      [{ id: "first", organizationId: "org-1", name: "renamed", displayName: null }],
      [{ id: "first-model", organizationId: "org-1", providerId: "first", modelId: "gpt" }],
    );
    _deps.findLegacyProviders = async () => [
      { id: "first", organizationId: "org-1", name: "renamed", displayName: null },
      { id: "second", organizationId: "org-1", name: "also-renamed", displayName: null },
    ];

    await migrateAgentConfigModelId.run();

    expect(db.modelQueries).toEqual([["org-1", "first", "gpt"]]);
  });

  // 三段及以上引用始终按稳定格式解析，不能错误地回退到旧格式查询。
  test("三段引用不会回退为旧格式", async () => {
    const db = stubDb([migrationRow({ model: "openai/family/version" })]);

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("missing provider 'openai/family'");
    expect(db.legacyProviderQueries).toEqual([]);
  });

  // 不含分隔符的历史值不是合法旧格式，必须显式报错。
  test("无分隔符的旧格式报错", async () => {
    const db = stubDb([migrationRow({ model: "not-a-reference" })]);

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("invalid legacy model ref 'not-a-reference'");
    expect(db.updates).toEqual([]);
  });

  // 旧格式找不到当前组织的提供商时，错误应包含组织用于排障。
  test("旧格式提供商缺失错误包含组织", async () => {
    const db = stubDb([migrationRow({ organizationId: "isolated-org", model: "missing/gpt" })]);

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("org='isolated-org'");
    expect(db.updates).toEqual([]);
  });

  // 找到提供商却找不到模型时，不得执行部分更新。
  test("旧格式模型缺失时不执行更新", async () => {
    const db = stubDb(
      [migrationRow()],
      [{ id: "provider-openai", organizationId: "org-1", name: "openai", displayName: null }],
    );

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("missing legacy model 'gpt-4o'");
    expect(db.records[0]).toMatchObject({ modelId: null, model: "openai/gpt-4o" });
  });

  // 成功写入需要设置 modelId、清空历史字段并留下审计日志。
  test("成功迁移更新记录并记录日志", async () => {
    const db = legacyFixture();

    await migrateAgentConfigModelId.run();

    expect(db.records[0]).toMatchObject({ modelId: "model-gpt-4o", model: null });
    expect(db.logs).toEqual(["[data-migrate] migrated agentConfig model id='agent-1'"]);
  });

  // 状态型 stubDb 模拟持久化后，第二次运行应跳过已迁移记录。
  test("重复运行保持幂等", async () => {
    const db = legacyFixture();

    await migrateAgentConfigModelId.run();
    await migrateAgentConfigModelId.run();

    expect(db.updates).toEqual([{ agentConfigId: "agent-1", nextModelId: "model-gpt-4o" }]);
    expect(db.logs).toHaveLength(1);
  });

  // 写入层异常必须透传，且不能把失败记录写成成功日志。
  test("更新异常不记录成功日志", async () => {
    const db = legacyFixture();
    _deps.updateAgentConfigModel = async () => {
      throw new Error("write unavailable");
    };

    await expect(migrateAgentConfigModelId.run()).rejects.toThrow("write unavailable");
    expect(db.logs).toEqual([]);
  });
});
