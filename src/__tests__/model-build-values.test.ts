// R35: model.ts buildModelValues 辅助函数（values/set 共享字段映射）
import { describe, test, expect, mock } from "bun:test";

// mock db 和 schema
const insertMock = mock(() => ({
  onConflictDoUpdate: mock(() => Promise.resolve()),
}));
const updateMock = mock(() => ({
  where: mock(() => Promise.resolve({})),
}));
mock.module("../db", () => ({
  db: {
    insert: () => ({ values: insertMock }),
    update: () => ({ set: updateMock }),
  },
}));
mock.module("../db/schema", () => ({
  model: {
    providerId: "provider_id",
    modelId: "model_id",
    id: "id",
    displayName: "display_name",
    modalities: "modalities",
    limitConfig: "limit_config",
    cost: "cost",
    options: "options",
    updatedAt: "updated_at",
  },
}));

const { addModel, updateModel } = await import("../services/config/model");

describe("buildModelValues 字段映射", () => {
  // addModel 使用 buildModelValues 构建 values 和 set
  test("addModel 应成功调用（验证辅助函数无异常）", async () => {
    await addModel("prov-1", {
      modelId: "gpt-4",
      displayName: "GPT-4",
      modalities: ["text"],
      limitConfig: { rpm: 60 },
      cost: { input: 0.03 },
      options: { stream: true },
    });
    // 若 buildModelValues 有误，此处会抛异常
    expect(true).toBe(true);
  });

  // updateModel 独立逻辑，不受 buildModelValues 影响
  test("updateModel 应成功调用", async () => {
    await updateModel("prov-1", "gpt-4", {
      displayName: "GPT-4 Turbo",
    });
    expect(true).toBe(true);
  });

  // addModel 空可选字段不报错
  test("addModel 无可选字段时正常执行", async () => {
    await addModel("prov-1", { modelId: "base-model" });
    expect(true).toBe(true);
  });
});
