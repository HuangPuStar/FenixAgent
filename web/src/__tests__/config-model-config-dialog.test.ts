import { describe, expect, test } from "bun:test";
import { buildModelOptions } from "@/components/config/ModelConfigDialog";
import type { ModelEntry } from "../types/config";

describe("buildModelOptions", () => {
  test("maps available models to value/label pairs", () => {
    const available: ModelEntry[] = [
      {
        id: "gpt-4",
        provider: "openai",
        label: "GPT-4",
        fullId: "openai/gpt-4",
        contextLimit: null,
        outputLimit: null,
      },
      {
        id: "claude-3",
        provider: "anthropic",
        label: "Claude 3",
        fullId: "anthropic/claude-3",
        contextLimit: null,
        outputLimit: null,
      },
    ];
    const result = buildModelOptions(available);
    expect(result).toEqual([
      { value: "openai/gpt-4", label: "openai/gpt-4" },
      { value: "anthropic/claude-3", label: "anthropic/claude-3" },
    ]);
  });

  test("prefers stableFullId and includes source organization in label", () => {
    const available: ModelEntry[] = [
      {
        id: "shared-model",
        provider: "openai",
        label: "Shared Model",
        fullId: "openai/shared-model",
        stableFullId: "org-source/provider-uid/shared-model",
        contextLimit: null,
        outputLimit: null,
        providerResourceAccess: {
          ownership: "external",
          sourceOrganizationId: "org-source",
          sourceOrganizationName: "Source Team",
          resourceUid: "provider-uid",
          resourceKey: "org-source/provider-uid",
          manageable: false,
          writable: false,
        },
      },
    ];
    const result = buildModelOptions(available);
    expect(result).toEqual([
      { value: "org-source/provider-uid/shared-model", label: "Source Team/openai/shared-model" },
    ]);
  });

  test("returns empty array for empty available list", () => {
    const result = buildModelOptions([]);
    expect(result).toEqual([]);
  });

  test("handles null/undefined fields gracefully", () => {
    const available = [{ id: "test", provider: "p", label: "Test", fullId: "p/test" }] as ModelEntry[];
    const result = buildModelOptions(available);
    expect(result).toEqual([{ value: "p/test", label: "p/test" }]);
  });
});
