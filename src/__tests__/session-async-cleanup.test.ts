// ── session.ts async 函数移除冗余 Promise.resolve 验证 ──
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _setEventService,
  _setUuid,
  archiveSession,
  createSession,
  getSession,
  resolveExistingSessionId,
  updateSessionStatus,
} from "../services/session";

// 注入 mock eventService
const mockBuses = new Map<string, { publish: typeof mock }>();
const mockRemoveBus = mock((_id: string) => {});

_setEventService({
  getAllBuses: () => mockBuses,
  removeBus: mockRemoveBus,
} as any);

_setUuid(() => "test-uuid-1234-5678-9abc-def012345678");

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
    mockBuses.set("ses_active", { publish: mock(() => {}) } as any);
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
    mockBuses.set("ses_found", { publish: mock(() => {}) } as any);
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
    mockBuses.set("ses_archive", { publish } as any);
    archiveSession("ses_archive");
    expect(mockRemoveBus).toHaveBeenCalledWith("ses_archive");
  });
});
