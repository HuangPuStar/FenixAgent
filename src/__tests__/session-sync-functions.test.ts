// ── session.ts 同步函数返回 Promise 验证 ──
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ISessionRepo } from "../repositories";
import {
  _setEventService,
  _setSessionRepo,
  _setUuid,
  createSession,
  getSession,
  resolveExistingSessionId,
} from "../services/session";

// 注入 mock eventService
const mockBuses = new Map();

_setEventService({
  getAllBuses: () => mockBuses,
  removeBus: () => {},
} as any);

_setUuid(() => "test-uuid");

// 注入 mock sessionRepo（避免 createSession 打到真实数据库）
const mockSessionRepo: ISessionRepo = {
  create: mock(async (params) => ({
    id: `${params.idPrefix || "session_"}testuuid`,
    environmentId: params.environmentId ?? null,
    title: params.title ?? null,
    status: "idle",
    source: params.source ?? "acp",
    username: params.username ?? null,
    userId: params.userId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  getById: mock(async () => undefined),
  update: mock(async () => true),
  delete: mock(async () => true),
  listAll: mock(async () => []),
  listByEnvironment: mock(async () => []),
  listByUserId: mock(async () => []),
  bindOwner: mock(async () => {}),
  reset: () => {},
};
_setSessionRepo(mockSessionRepo);

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
