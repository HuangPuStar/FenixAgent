import { expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { TemporaryEnvironmentFacade } from "../../facades/temporary-environment-facade";
import type { AgentInstanceRecord } from "../repositories/agent-instance";
import type { EnvironmentRecord } from "../repositories/environment";
import { TemporaryEnvironmentLifecycle } from "../services/temporary-environment-lifecycle";

function fixture() {
  const rows = new Map<string, EnvironmentRecord>();
  const instances = new Map<string, AgentInstanceRecord>();
  let starts = 0;
  let allowed = true;
  let executionUnavailable = false;
  const lifecycle = new TemporaryEnvironmentLifecycle({
    markReclaimed: async () => {},
    read: async (id) => rows.get(id),
    writeExpiry: async (id, expiresAt) => {
      rows.get(id)!.expiresAt = expiresAt;
    },
    stop: async () => {},
  });
  const facade = new TemporaryEnvironmentFacade({
    findAgent: async () => (allowed ? { id: "agent" } : null),
    ttl: async () => 3600,
    createEnvironment: async (input) => {
      const row = { ...input, createdAt: new Date(), updatedAt: new Date() } as EnvironmentRecord;
      rows.set(row.id, row);
      return row;
    },
    getOwnedEnvironment: async (id, owner) => {
      const row = rows.get(id);
      if (!row || row.organizationId !== owner.organizationId || row.userId !== owner.userId)
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      return row;
    },
    createInstance: async (environmentId, ownerUserId) => {
      const row: AgentInstanceRecord = {
        id: `inst-${environmentId}`,
        environmentId,
        ownerUserId,
        creationSource: "api",
        name: "api",
        isDefault: false,
        createdByUserId: ownerUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      instances.set(environmentId, row);
      return row;
    },
    findInstance: async (id) => instances.get(id),
    ensureRuntime: async () => {
      starts++;
      if (executionUnavailable) throw new AppError("Machine unavailable", "SERVICE_UNAVAILABLE", 503);
    },
    transaction: async (operation) => operation(),
    schedule: () => {},
    lifecycle,
  });
  return {
    facade,
    rows,
    starts: () => starts,
    deny: () => {
      allowed = false;
    },
    unavailable: () => {
      executionUnavailable = true;
    },
  };
}
const owner = { organizationId: "org", userId: "user" };
// 每次创建仅落库，执行节点不可用也不阻止创建独立环境与非默认 API Instance。
test("creates independent temporary environments without starting runtimes", async () => {
  const f = fixture();
  f.unavailable();
  const a = await f.facade.create(owner, "agent"),
    b = await f.facade.create(owner, "agent");
  expect(a.environmentId).toStartWith("temp-");
  expect(a.environmentId).not.toBe(b.environmentId);
  expect(a.instanceId).not.toBe(b.instanceId);
  expect(f.starts()).toBe(0);
  expect(f.rows.get(a.environmentId)).toMatchObject({ autoStart: false, agentConfigId: "agent" });
  expect(new Date(a.expiresAt).getTime() - Date.now()).toBeGreaterThan(3590000);
});
// 授权先于资源创建，拒绝访问时不能残留可寻址的环境身份。
test("authorization failure leaves no environment", async () => {
  const f = fixture();
  f.deny();
  await expect(f.facade.create(owner, "agent")).rejects.toMatchObject({ statusCode: 404 });
  expect(f.rows.size).toBe(0);
});
// 到期环境续期保持实例身份，跨用户返回 404 而不是期限信息。
test("renew preserves instance identity and reauthorizes owner and Agent use", async () => {
  const f = fixture();
  const a = await f.facade.create(owner, "agent");
  f.rows.get(a.environmentId)!.expiresAt = new Date(0);
  await expect(f.facade.renew({ ...owner, userId: "other" }, a.environmentId)).rejects.toMatchObject({
    statusCode: 404,
  });
  const renewed = await f.facade.renew(owner, a.environmentId);
  expect(renewed.instanceId).toBe(a.instanceId);
  expect(f.starts()).toBe(1);
  f.deny();
  await expect(f.facade.renew(owner, a.environmentId)).rejects.toMatchObject({ statusCode: 404 });
});

// 续期沿原启动流程，执行节点不可用仍保留新期限与原实例，允许后续重试。
test("renew runtime failure preserves the deadline and instance identity", async () => {
  const f = fixture();
  const existing = await f.facade.create(owner, "agent");
  f.rows.get(existing.environmentId)!.expiresAt = new Date(0);
  f.unavailable();
  await expect(f.facade.renew(owner, existing.environmentId)).rejects.toMatchObject({
    statusCode: 503,
    code: "SERVICE_UNAVAILABLE",
  });
  expect(f.rows.size).toBe(1);
  expect(f.rows.get(existing.environmentId)!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  expect(f.starts()).toBe(1);
});
