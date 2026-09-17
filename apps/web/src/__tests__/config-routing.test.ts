import { describe, expect, test } from "bun:test";
import { parseConfigView } from "../App";

describe("parseConfigView", () => {
  test("/ctrl/providers → null (已移除)", () => {
    expect(parseConfigView("/ctrl/providers")).toBeNull();
  });

  test("/ctrl/models → models", () => {
    expect(parseConfigView("/ctrl/models")).toBe("models");
  });

  test("/ctrl/agents → agents", () => {
    expect(parseConfigView("/ctrl/agents")).toBe("agents");
  });

  test("/ctrl/skills → skills", () => {
    expect(parseConfigView("/ctrl/skills")).toBe("skills");
  });

  test("/ctrl/knowledge-bases → knowledge-bases", () => {
    expect(parseConfigView("/ctrl/knowledge-bases")).toBe("knowledge-bases");
  });

  test("/ctrl/channels → channels", () => {
    expect(parseConfigView("/ctrl/channels")).toBe("channels");
  });

  test("/ctrl/ → null", () => {
    expect(parseConfigView("/ctrl/")).toBeNull();
  });

  test("/ctrl/some-session-id → null", () => {
    expect(parseConfigView("/ctrl/some-session-id")).toBeNull();
  });
});
