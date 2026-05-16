import { test, expect, mock, describe, beforeEach } from "bun:test";

// ── mock.module 必须在 import 被测模块之前注册 ──

// 模拟 Drizzle schema 中 model 表的列标识符
const mockModelTable = {
  providerId: "provider_id",
  modelId: "model_id",
} as unknown as import("../db/schema").model;

const mockOnConflictDoUpdate = mock(() => Promise.resolve());
const mockValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = mock(() => ({ values: mockValues }));

mock.module("../db", () => ({
  db: { insert: mockInsert },
}));

mock.module("../db/schema", () => ({
  model: mockModelTable,
}));

// import after mocks
import { addModel } from "../services/config/model";

describe("addModel — onConflictDoUpdate 幂等 upsert", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockValues.mockClear();
    mockOnConflictDoUpdate.mockClear();
  });

  // 首次调用使用 insert + values，包含 providerId 和 modelId
  test("inserts with correct values including providerId and modelId", async () => {
    await addModel("prov-1", { modelId: "gpt-4" });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(mockModelTable);
    expect(mockValues).toHaveBeenCalledTimes(1);

    const valuesArg = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.providerId).toBe("prov-1");
    expect(valuesArg.modelId).toBe("gpt-4");
    expect(valuesArg.updatedAt).toBeInstanceOf(Date);
  });

  // onConflictDoUpdate 的 target 应该是 [model.providerId, model.modelId]
  test("onConflictDoUpdate targets unique index [providerId, modelId]", async () => {
    await addModel("prov-1", { modelId: "gpt-4" });
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);

    const [conflictArg] = mockOnConflictDoUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(conflictArg.target).toEqual(["provider_id", "model_id"]);
  });

  // onConflictDoUpdate set 包含 updatedAt 和所有数据字段
  test("onConflictDoUpdate set includes updatedAt and data fields", async () => {
    await addModel("prov-1", {
      modelId: "gpt-4",
      displayName: "GPT-4",
      modalities: { input: ["text"] },
      limitConfig: { rpm: 60 },
      cost: { prompt: 0.03 },
      options: { temperature: 0.7 },
    });
    const setArg = (mockOnConflictDoUpdate.mock.calls[0][0] as Record<string, unknown>).set as Record<string, unknown>;
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    expect(setArg.displayName).toBe("GPT-4");
    expect(setArg.modalities).toEqual({ input: ["text"] });
    expect(setArg.limitConfig).toEqual({ rpm: 60 });
    expect(setArg.cost).toEqual({ prompt: 0.03 });
    expect(setArg.options).toEqual({ temperature: 0.7 });
  });

  // onConflictDoUpdate set 不包含 providerId 和 modelId（冲突目标列不参与更新）
  test("onConflictDoUpdate set excludes providerId and modelId", async () => {
    await addModel("prov-1", { modelId: "gpt-4", displayName: "GPT-4" });
    const setArg = (mockOnConflictDoUpdate.mock.calls[0][0] as Record<string, unknown>).set as Record<string, unknown>;
    expect("providerId" in setArg).toBe(false);
    expect("modelId" in setArg).toBe(false);
  });

  // 只传必填字段 modelId 也能正常工作
  test("works with only required modelId field", async () => {
    await addModel("prov-2", { modelId: "claude-3" });
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    const setArg = (mockOnConflictDoUpdate.mock.calls[0][0] as Record<string, unknown>).set as Record<string, unknown>;
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    // 可选字段在未传入时为 undefined，不包含在 set 中也不会报错
    expect(setArg.displayName).toBeUndefined();
  });
});
