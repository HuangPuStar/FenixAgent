import { describe, expect, test } from "bun:test";
import { modelWriteDataFromApi, modelWriteDataFromWebConfig } from "@fenix/model-management/server";

describe("modelWriteDataFromWebConfig", () => {
  // 验证配置面板的完整字段集合被映射为领域列名（name → displayName、limit → limitConfig）。
  test("将配置面板字段映射为领域列", () => {
    const result = modelWriteDataFromWebConfig({
      name: "GPT-4o",
      modalities: ["text", "image"],
      limit: { rpm: 60 },
      cost: { input: 0.01 },
      options: { streaming: true },
    });

    expect(result).toEqual({
      displayName: "GPT-4o",
      modalities: ["text", "image"],
      limitConfig: { rpm: 60 },
      cost: { input: 0.01 },
      options: { streaming: true },
    });
  });

  // 验证非字符串展示名被忽略，避免把数字等非法值写进 varchar 列。
  test("非字符串 name 不映射为 displayName", () => {
    expect(modelWriteDataFromWebConfig({ name: 123 }).displayName).toBeUndefined();
  });

  // 验证未提供的字段不出现在结果中，使仓储能把 undefined 解读为"不修改这一列"。
  test("未提供的字段不产生键", () => {
    expect(modelWriteDataFromWebConfig({})).toEqual({});
    expect(modelWriteDataFromWebConfig({ modalities: undefined })).toEqual({});
  });

  // 验证显式 null 被透传，使仓储能把 null 解读为"置空这一列"。
  test("显式 null 透传为置空", () => {
    const result = modelWriteDataFromWebConfig({ modalities: null });

    expect("modalities" in result).toBe(true);
    expect(result.modalities).toBeNull();
    expect(result.displayName).toBeUndefined();
  });
});

describe("modelWriteDataFromApi", () => {
  // 验证对外字段名本身就是领域列名，转换只丢弃 undefined 的键。
  test("透传对外字段名并丢弃 undefined", () => {
    const result = modelWriteDataFromApi({
      displayName: "Claude 3.5",
      limitConfig: { context: 200000 },
      cost: undefined,
    });

    expect(result).toEqual({ displayName: "Claude 3.5", limitConfig: { context: 200000 } });
    expect("cost" in result).toBe(false);
  });

  // 验证 /api 侧同样保留 null 的"置空"语义，与 /web 侧一致。
  test("显式 null 透传为置空", () => {
    const result = modelWriteDataFromApi({ displayName: null });

    expect("displayName" in result).toBe(true);
    expect(result.displayName).toBeNull();
  });
});
