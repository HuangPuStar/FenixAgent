import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── session.ts async 函数移除冗余 Promise.resolve 验证 ──

const mockBuses = new Map<string, { publish: typeof mock }>();
const mockGetAllBuses = mock(() => mockBuses);
const mockRemoveBus = mock((_id: string) => {});

mock.module("../services/event-service", () => ({
  eventService: {
    getAllBuses: mockGetAllBuses,
    removeBus: mockRemoveBus,
  },
}));

mock.module("uuid", () => ({
  v4: () => "test-uuid-1234-5678-9abc-def012345678",
}));

mock.module("../repositories", () => ({
  sessionRepo: {
    listByEnvironment: mock(async () => []),
    create: mock(async (p: { id: string }) => ({ id: p.id })),
    bindOwner: mock(async () => {}),
  },
}));

const { getSession, resolveExistingSessionId, createSession, updateSessionStatus, archiveSession } = await import("../services/session");

describe("session async cleanup (removed redundant Promise.resolve)", () => {
  beforeEach(() => {
    mockBuses.clear();
    mockRemoveBus.mockClear();
  });

  // getSession 返回 null（无 bus）
  test("getSession returns null when no bus", async () => {
    const result = await getSession("nonexistent");
    expect(result).toBeNull();
  });

  // getSession 返回 active session（有 bus）
  test("getSession returns active session when bus exists", async () => {
    mockBuses.set("ses_active", { publish: mock(() => {}) } as unknown as typeof mock);
    const result = await getSession("ses_active");
    expect(result).toEqual({ id: "ses_active", status: "active" });
  });

  // resolveExistingSessionId 返回 null
  test("resolveExistingSessionId returns null when no bus", async () => {
    const result = await resolveExistingSessionId("nonexistent");
    expect(result).toBeNull();
  });

  // resolveExistingSessionId 返回 sessionId
  test("resolveExistingSessionId returns id when bus exists", async () => {
    mockBuses.set("ses_found", { publish: mock(() => {}) } as unknown as typeof mock);
    const result = await resolveExistingSessionId("ses_found");
    expect(result).toBe("ses_found");
  });

  // createSession 返回正确格式
  test("createSession returns lightweight session stub", async () => {
    const result = await createSession({});
    expect(result.id).toMatch(/^session_/);
    expect(result.status).toBe("idle");
  });

  // updateSessionStatus 无 bus 时静默退出
  test("updateSessionStatus is a no-op when no bus", () => {
    expect(() => updateSessionStatus("nonexistent", "active")).not.toThrow();
  });

  // archiveSession 清理 bus
  test("archiveSession removes bus", () => {
    const publish = mock(() => {});
    mockBuses.set("ses_archive", { publish } as unknown as typeof mock);
    archiveSession("ses_archive");
    expect(mockRemoveBus).toHaveBeenCalledWith("ses_archive");
  });
});
