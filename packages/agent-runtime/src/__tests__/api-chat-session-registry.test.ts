import { expect, test } from "bun:test";
import { ApiChatSessionRegistry } from "../services/api-chat-session-registry";

const owner = {
  organizationId: "org",
  userId: "user",
  agentConfigId: "agent",
  environmentId: "env",
  instanceId: "inst_a",
  runtimeGeneration: 1,
};
// 长回复结束后仍有完整闲置窗口，不把执行时间计入闲置时间。
test("idle expiry starts when a successful turn releases its lease", () => {
  let now = 0;
  const registry = new ApiChatSessionRegistry({ now: () => now, ttlMs: 100 });
  const lease = registry.reserve(owner);
  registry.confirm(lease, "ses_private");
  now = 150;
  registry.release(lease, true);
  now = 249;
  expect(registry.acquire(lease.handle, owner)).toBe(lease);
  registry.release(lease, true);
  now = 350;
  expect(() => registry.acquire(lease.handle, owner)).toThrow("Session unavailable");
});
// 句柄绑定主体与实例代次，只有成功完成的会话可以继续。
test("handles bind owner, generation and one active turn", () => {
  let now = 0;
  const registry = new ApiChatSessionRegistry({ now: () => now, ttlMs: 100, perOwner: 2, maxEntries: 3 });
  const reservation = registry.reserve(owner);
  registry.confirm(reservation, "ses_private");
  registry.release(reservation, true);
  expect(reservation.handle).toStartWith("fcs_");
  expect(reservation.handle).not.toContain("ses_private");
  expect(() => registry.acquire(reservation.handle, { ...owner, userId: "other" })).toThrow("Session unavailable");
  const lease = registry.acquire(reservation.handle, owner);
  expect(() => registry.acquire(reservation.handle, owner)).toThrow("Session busy");
  registry.release(lease, true);
  now = 101;
  expect(() => registry.acquire(reservation.handle, owner)).toThrow("Session unavailable");
});
// 容量在 prompt 前预留，不能淘汰活动会话或挤掉其他请求。
test("capacity evicts idle entries only and cancellation invalidates", () => {
  const registry = new ApiChatSessionRegistry({ perOwner: 2, maxEntries: 2 });
  const first = registry.reserve(owner),
    second = registry.reserve(owner);
  expect(() => registry.reserve(owner)).toThrow("Session capacity reached");
  registry.confirm(first, "ses_a");
  registry.release(first, true);
  const third = registry.reserve(owner);
  expect(() => registry.acquire(first.handle, owner)).toThrow("Session unavailable");
  registry.release(third, false);
  registry.release(second, false);
  const next = registry.reserve(owner);
  registry.confirm(next, "ses_b");
  registry.release(next, true);
  registry.invalidateInstance(owner.instanceId);
  expect(() => registry.acquire(next.handle, owner)).toThrow("Session unavailable");
});
