import { describe, expect, test } from "bun:test";
import { buildProviderModelRequest, buildProviderPayload, validateProviderForm } from "../pages/ModelsPage";

// NPM_OPTIONS is module-scoped; verify via the exported buildProviderPayload behavior
// and validateProviderForm which are the public API

describe("validateProviderForm", () => {
  test("empty name returns error", () => {
    expect(validateProviderForm("", false)).toBe("名称不能为空");
  });

  test("valid name returns null", () => {
    expect(validateProviderForm("openai", false)).toBeNull();
  });

  test("too long name returns error", () => {
    expect(validateProviderForm("a".repeat(65), false)).toBe("名称长度须在 1-64 字符之间");
  });
});

describe("buildProviderPayload", () => {
  test("only apiKey", () => {
    expect(buildProviderPayload("key123", "", "", "")).toEqual({ apiKey: "key123" });
  });

  test("baseURL and npm", () => {
    expect(buildProviderPayload("", "http://api.test.com", "@ai-sdk/openai", "MyProvider")).toEqual({
      baseURL: "http://api.test.com",
      npm: "@ai-sdk/openai",
      name: "MyProvider",
    });
  });

  test("all empty returns empty object", () => {
    expect(buildProviderPayload("", "", "", "")).toEqual({});
  });

  test("npm value is passed through correctly", () => {
    const payload = buildProviderPayload("", "", "@ai-sdk/anthropic", "");
    expect(payload.npm).toBe("@ai-sdk/anthropic");
  });
});

describe("buildProviderModelRequest", () => {
  test("add_model wraps model fields in data", () => {
    expect(buildProviderModelRequest("add_model", "openai", "gpt-4o", { modelId: "gpt-4o", name: "GPT-4o" })).toEqual({
      action: "add_model",
      name: "openai",
      data: { modelId: "gpt-4o", name: "GPT-4o" },
    });
  });

  test("update_model keeps target modelId at top level and wraps update fields in data", () => {
    expect(
      buildProviderModelRequest("update_model", "openai", "gpt-4o", {
        modelId: "gpt-4o",
        limit: { context: 128000 },
      }),
    ).toEqual({
      action: "update_model",
      name: "openai",
      modelId: "gpt-4o",
      data: { modelId: "gpt-4o", limit: { context: 128000 } },
    });
  });
});
