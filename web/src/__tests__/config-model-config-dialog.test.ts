import { describe, expect, test } from "bun:test";
import { buildModelOptions } from "@/components/config/ModelConfigDialog";
import type { ModelEntry } from "../types/config";

describe("buildModelOptions", () => {
  test("maps available models to value/label pairs", () => {
    const available: ModelEntry[] = [
      {
        id: "uuid-gpt-4",
        modelId: "gpt-4",
        displayName: "GPT-4",
        provider: "openai",
        providerDisplayName: "OpenAI",
        contextLimit: null,
        outputLimit: null,
      },
      {
        id: "uuid-claude-3",
        modelId: "claude-3",
        displayName: "Claude 3",
        provider: "anthropic",
        providerDisplayName: "Anthropic",
        contextLimit: null,
        outputLimit: null,
      },
    ];
    const result = buildModelOptions(available);
    expect(result).toEqual([
      { value: "openai/gpt-4", label: "OpenAI/GPT-4" },
      { value: "anthropic/claude-3", label: "Anthropic/Claude 3" },
    ]);
  });

  test("uses resource key for shared models and keeps server display name", () => {
    const available: ModelEntry[] = [
      {
        id: "shared-model",
        modelId: "shared-model",
        displayName: "Shared Model",
        provider: "openai",
        providerDisplayName: "OpenAI Shared",
        contextLimit: null,
        outputLimit: null,
        providerResourceKey: "org-source/provider-uid",
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
      { value: "org-source/provider-uid/shared-model", label: "Source Team/OpenAI Shared/Shared Model" },
    ]);
  });

  test("returns empty array for empty available list", () => {
    const result = buildModelOptions([]);
    expect(result).toEqual([]);
  });

  test("handles null/undefined fields gracefully", () => {
    const available = [
      { id: "uuid-test", modelId: "test", displayName: "Test", provider: "p", providerDisplayName: "Provider" },
    ] as ModelEntry[];
    const result = buildModelOptions(available);
    expect(result).toEqual([{ value: "p/test", label: "Provider/Test" }]);
  });
});
