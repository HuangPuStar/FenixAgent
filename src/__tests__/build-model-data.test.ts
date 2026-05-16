import { describe, expect, it } from "bun:test";

// 测试 provider.ts 的 buildModelData 纯函数：前端字段 → PG 字段映射
const { buildModelData } = await import("../services/config/provider");

describe("buildModelData", () => {
  // 完整字段映射
  it("将前端字段映射为 PG 字段", () => {
    const result = buildModelData({
      name: "GPT-4o",
      modalities: ["text", "image"],
      limit: { rpm: 60 },
      cost: { input: 0.01 },
      options: { streaming: true },
    });
    expect(result.displayName).toBe("GPT-4o");
    expect(result.modalities).toEqual(["text", "image"]);
    expect(result.limitConfig).toEqual({ rpm: 60 });
    expect(result.cost).toEqual({ input: 0.01 });
    expect(result.options).toEqual({ streaming: true });
  });

  // data.name → displayName 映射
  it("将 data.name 映射为 displayName", () => {
    const result = buildModelData({ name: "Claude 3.5" });
    expect(result.displayName).toBe("Claude 3.5");
  });

  // data.limit → limitConfig 映射
  it("将 data.limit 映射为 limitConfig", () => {
    const result = buildModelData({ limit: { rpm: 100 } });
    expect(result.limitConfig).toEqual({ rpm: 100 });
  });

  // 空对象返回空对象
  it("空输入返回空对象", () => {
    const result = buildModelData({});
    expect(result).toEqual({});
  });

  // falsy 值不映射（if (data.name) 过滤空字符串，if (data.modalities) 过滤 null）
  it("跳过 falsy 值的字段", () => {
    const result = buildModelData({ name: "", modalities: null });
    expect(result.displayName).toBeUndefined();
    expect(result.modalities).toBeUndefined();
  });
});

// ── instance.ts mapCoreStatus ──

// 复制 mapCoreStatus 逻辑（private 函数）
function mapCoreStatus(status: string): "running" | "stopped" | "error" | "starting" {
  switch (status) {
    case "running": return "running";
    case "stopped":
    case "stopping": return "stopped";
    case "error": return "error";
    default: return "starting";
  }
}

describe("mapCoreStatus", () => {
  it("running → running", () => {
    expect(mapCoreStatus("running")).toBe("running");
  });

  it("stopped → stopped", () => {
    expect(mapCoreStatus("stopped")).toBe("stopped");
  });

  it("stopping → stopped（合并为同一状态）", () => {
    expect(mapCoreStatus("stopping")).toBe("stopped");
  });

  it("error → error", () => {
    expect(mapCoreStatus("error")).toBe("error");
  });

  it("未知状态 → starting", () => {
    expect(mapCoreStatus("pending")).toBe("starting");
    expect(mapCoreStatus("")).toBe("starting");
  });
});
