import { describe, expect, test } from "bun:test";

const {
  cn,
  formatTime,
  statusClass,
  isClosedSessionStatus,
  truncate,
  generateMessageUuid,
  extractEventText,
  isConversationClearedStatus,
} = await import("@/src/lib/utils");

// =============================================================================
// formatTime()
// =============================================================================

describe("formatTime", () => {
  test("returns empty string for null", () => {
    expect(formatTime(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(formatTime(undefined)).toBe("");
  });

  test("returns empty string for 0", () => {
    expect(formatTime(0)).toBe("");
  });

  test("formats valid unix timestamp", () => {
    const result = formatTime(1700000000);
    expect(result).toContain("2023");
  });
});

// =============================================================================
// statusClass()
// =============================================================================

describe("statusClass", () => {
  test("maps known statuses correctly", () => {
    expect(statusClass("active")).toBe("active");
    expect(statusClass("running")).toBe("running");
    expect(statusClass("idle")).toBe("idle");
    expect(statusClass("inactive")).toBe("inactive");
    expect(statusClass("requires_action")).toBe("requires_action");
    expect(statusClass("archived")).toBe("archived");
    expect(statusClass("error")).toBe("error");
  });

  test("returns default for unknown status", () => {
    expect(statusClass("unknown")).toBe("default");
  });

  test("returns default for null", () => {
    expect(statusClass(null)).toBe("default");
  });

  test("returns default for undefined", () => {
    expect(statusClass(undefined)).toBe("default");
  });

  test("returns default for empty string", () => {
    expect(statusClass("")).toBe("default");
  });
});

// =============================================================================
// isClosedSessionStatus()
// =============================================================================

describe("isClosedSessionStatus", () => {
  test("returns true for archived", () => {
    expect(isClosedSessionStatus("archived")).toBe(true);
  });

  test("returns true for inactive", () => {
    expect(isClosedSessionStatus("inactive")).toBe(true);
  });

  test("returns false for active", () => {
    expect(isClosedSessionStatus("active")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isClosedSessionStatus(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isClosedSessionStatus(undefined)).toBe(false);
  });
});

// =============================================================================
// truncate()
// =============================================================================

describe("truncate", () => {
  test("returns empty string for null", () => {
    expect(truncate(null, 10)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(truncate(undefined, 10)).toBe("");
  });

  test("returns original string when shorter than max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("returns original string when exactly max length", () => {
    expect(truncate("12345", 5)).toBe("12345");
  });

  test("truncates and appends ... when longer than max", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });
});

// =============================================================================
// generateMessageUuid()
// =============================================================================

describe("generateMessageUuid", () => {
  test("returns a non-empty string", () => {
    const uuid = generateMessageUuid();
    expect(typeof uuid).toBe("string");
    expect(uuid.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// extractEventText()
// =============================================================================

describe("extractEventText", () => {
  test("returns empty string for null", () => {
    expect(extractEventText(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(extractEventText(undefined)).toBe("");
  });

  test("returns empty string for non-object", () => {
    expect(extractEventText("string" as any)).toBe("");
  });

  test("extracts payload.content string", () => {
    expect(extractEventText({ content: "hello" })).toBe("hello");
  });

  test("extracts from message.content text blocks array", () => {
    const payload = {
      message: {
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
    };
    expect(extractEventText(payload)).toBe("line 1\nline 2");
  });

  test("ignores non-text blocks", () => {
    const payload = {
      message: {
        content: [
          { type: "image", data: "base64..." },
          { type: "text", text: "only text" },
        ],
      },
    };
    expect(extractEventText(payload)).toBe("only text");
  });

  test("returns empty string when message.content has no text blocks", () => {
    const payload = {
      message: { content: [{ type: "image", data: "base64" }] },
    };
    expect(extractEventText(payload)).toBe("");
  });

  test("returns empty string for empty object", () => {
    expect(extractEventText({})).toBe("");
  });
});

// =============================================================================
// isConversationClearedStatus()
// =============================================================================

describe("isConversationClearedStatus", () => {
  test("returns true when payload.status is conversation_cleared", () => {
    expect(isConversationClearedStatus({ status: "conversation_cleared" })).toBe(true);
  });

  test("returns true when payload.raw.status is conversation_cleared", () => {
    expect(isConversationClearedStatus({ raw: { status: "conversation_cleared" } })).toBe(true);
  });

  test("returns false for null", () => {
    expect(isConversationClearedStatus(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isConversationClearedStatus(undefined)).toBe(false);
  });

  test("returns false for other status", () => {
    expect(isConversationClearedStatus({ status: "active" })).toBe(false);
  });

  test("returns false when raw has different status", () => {
    expect(isConversationClearedStatus({ raw: { status: "running" } })).toBe(false);
  });

  test("returns false for empty object", () => {
    expect(isConversationClearedStatus({})).toBe(false);
  });
});

// =============================================================================
// cn()
// =============================================================================

// 用例从宿主 `ui-components.test.ts` 并入（§1.6 T10b3）：那份 smoke 用例的导出断言已由包内
// `packages/ui-components/web/__tests__/barrel-exports.test.ts` 逐名覆盖（更强），只有 `cn` 这两条
// 守护的是宿主自己的 `cn`，故留下、其余删除。
describe("cn", () => {
  test("concatenates class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  test("filters falsy values", () => {
    expect(cn("a", false && "b")).toBe("a");
  });
});
