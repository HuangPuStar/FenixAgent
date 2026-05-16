import { test, expect, mock, describe, beforeEach } from "bun:test";

// ── mock.module 必须在 import 被测模块之前注册 ──

const mockBuses = new Map();

mock.module("../services/event-service", () => ({
  eventService: { getAllBuses: () => mockBuses },
}));

mock.module("../repositories", () => ({
  sessionRepo: {
    listByEnvironment: mock(() => Promise.resolve([])),
    create: mock(() => Promise.resolve({ id: "ses_test" })),
    bindOwner: mock(() => Promise.resolve()),
  },
}));

mock.module("uuid", () => ({
  v4: () => "test-uuid",
}));

import { getSession, resolveExistingSessionId, createSession } from "../services/session";

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

describe("createSession — 返回轻量存根", () => {
  // createSession 返回 { id: "session_<uuid去中划线>", status: "idle" }
  test("createSession returns { id: session_testuuidwithoutdashes, status: idle }", async () => {
    const result = await createSession({});
    // uuid v4 mock 返回 "test-uuid"，去中划线后为 "testuuid"
    expect(result).toEqual({
      id: "session_testuuid",
      status: "idle",
    });
  });
});
