import { describe, expect, test } from "bun:test";
import { parseConfigView } from "../App";

describe("parseConfigView MCP 路由", () => {
  test("/ctrl/mcp → mcp", () => {
    expect(parseConfigView("/ctrl/mcp")).toBe("mcp");
  });

  test("/ctrl/mcp/ → mcp", () => {
    expect(parseConfigView("/ctrl/mcp/")).toBe("mcp");
  });
});

describe("parseConfigView 现有路由不受影响", () => {
  test("/ctrl/models → models", () => {
    expect(parseConfigView("/ctrl/models")).toBe("models");
  });

  test("/ctrl/agents → agents", () => {
    expect(parseConfigView("/ctrl/agents")).toBe("agents");
  });

  test("/ctrl/skills → skills", () => {
    expect(parseConfigView("/ctrl/skills")).toBe("skills");
  });

  test("/ctrl/ → null", () => {
    expect(parseConfigView("/ctrl/")).toBeNull();
  });

  test("/ctrl/session-123 → null", () => {
    expect(parseConfigView("/ctrl/session-123")).toBeNull();
  });
});
