import { describe, test, expect } from "bun:test";
import { buildModelOptions } from "@/components/config/ModelConfigDialog";
import type { ModelEntry } from "../types/config";

describe("buildModelOptions", () => {
  test("maps available models to value/label pairs", () => {
    const available: ModelEntry[] = [
      { id: "gpt-4", provider: "openai", label: "GPT-4", fullId: "openai/gpt-4" },
      { id: "claude-3", provider: "anthropic", label: "Claude 3", fullId: "anthropic/claude-3" },
    ];
    const result = buildModelOptions(available);
    expect(result).toEqual([
      { value: "openai/gpt-4", label: "GPT-4 (openai)" },
      { value: "anthropic/claude-3", label: "Claude 3 (anthropic)" },
    ]);
  });

  test("returns empty array for empty available list", () => {
    const result = buildModelOptions([]);
    expect(result).toEqual([]);
  });

  test("handles null/undefined fields gracefully", () => {
    const available = [
      { id: "test", provider: "p", label: "Test", fullId: "p/test" },
    ] as ModelEntry[];
    const result = buildModelOptions(available);
    expect(result).toEqual([{ value: "p/test", label: "Test (p)" }]);
  });
});
