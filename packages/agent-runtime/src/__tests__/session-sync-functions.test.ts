// ── session.ts 同步函数返回 Promise 验证 ──
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { _setEventService, _setUuid, getSession, resolveExistingSessionId } from "../services/session";

// 注入 mock eventService
const mockBuses = new Map();

_setEventService({
  getAllBuses: () => mockBuses,
  removeBus: () => {},
} as any);

_setUuid(() => "test-uuid");

describe("getSession — 同步返回 Promise", () => {
  beforeEach(() => {
    mockBuses.clear();
  });

  // 有活跃 EventBus 时返回 { id, status: "active" }
  test("getSession with active bus returns { id, status: active }", async () => {
    mockBuses.set("ses_123", { publish: mock(() => {}) });
    const result = await getSession("ses_123");
    expect(result).toEqual({ id: "ses_123", status: "active" });
  });

  // 没有 EventBus 时返回 null
  test("getSession with no bus returns null", async () => {
    const result = await getSession("ses_nonexistent");
    expect(result).toBeNull();
  });
});

describe("resolveExistingSessionId — 同步返回 Promise", () => {
  beforeEach(() => {
    mockBuses.clear();
  });

  // 有活跃 EventBus 时返回 sessionId
  test("resolveExistingSessionId with active bus returns sessionId", async () => {
    mockBuses.set("ses_abc", { publish: mock(() => {}) });
    const result = await resolveExistingSessionId("ses_abc");
    expect(result).toBe("ses_abc");
  });

  // 没有 EventBus 时返回 null
  test("resolveExistingSessionId with no bus returns null", async () => {
    const result = await resolveExistingSessionId("ses_nonexistent");
    expect(result).toBeNull();
  });
});
