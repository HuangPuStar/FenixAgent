import { describe, test, expect } from "bun:test";
import type { ProviderInfo, ModelEntry, ModelConfig, AgentInfo, SkillInfo, ApiResponse } from "../types/config";

describe("config types", () => {
  test("ApiResponse success structure", () => {
    const response: ApiResponse<{ name: string }> = { success: true, data: { name: "test" } };
    expect(response.success).toBe(true);
    expect(response.data?.name).toBe("test");
  });

  test("ApiResponse error structure", () => {
    const response: ApiResponse<never> = { success: false, error: { code: "NOT_FOUND", message: "Not found" } };
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe("NOT_FOUND");
  });
});
