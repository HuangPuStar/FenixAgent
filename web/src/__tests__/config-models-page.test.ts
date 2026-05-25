import { describe, expect, test } from "bun:test";
import { getModelUsageStatus } from "../pages/ModelsPage";

describe("getModelUsageStatus", () => {
  test("is main model", () => {
    expect(getModelUsageStatus("gpt-4", "gpt-4", "gpt-3.5")).toEqual(["主模型"]);
  });

  test("is small model", () => {
    expect(getModelUsageStatus("gpt-3.5", "gpt-4", "gpt-3.5")).toEqual(["轻量模型"]);
  });

  test("is both models", () => {
    expect(getModelUsageStatus("gpt-4", "gpt-4", "gpt-4")).toEqual(["主模型", "轻量模型"]);
  });

  test("is no model", () => {
    expect(getModelUsageStatus("claude-3", "gpt-4", "gpt-3.5")).toEqual([]);
  });
});
