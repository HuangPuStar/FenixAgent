import { describe, test, expect } from "bun:test";
import { parseConfigView } from "../App";

describe("parseConfigView", () => {
  test("/code/providers → providers", () => {
    expect(parseConfigView("/code/providers")).toBe("providers");
  });

  test("/code/models → models", () => {
    expect(parseConfigView("/code/models")).toBe("models");
  });

  test("/code/agents → agents", () => {
    expect(parseConfigView("/code/agents")).toBe("agents");
  });

  test("/code/skills → skills", () => {
    expect(parseConfigView("/code/skills")).toBe("skills");
  });

  test("/code/ → null", () => {
    expect(parseConfigView("/code/")).toBeNull();
  });

  test("/code/some-session-id → null", () => {
    expect(parseConfigView("/code/some-session-id")).toBeNull();
  });
});
