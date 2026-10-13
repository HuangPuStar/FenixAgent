import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { sessionAccessFacade } from "../facades/session-access-facade";
import { bindSessionEventBusPort, resetSessionEventBusPort } from "../server/services/session-event-bus-port";
import { initializeAgentRuntimeModuleConfig, resetEnvironmentRepoStub, stubEnvironmentRepo } from "../server/testing";
import { getAllEventBuses, getEventBus, removeEventBus } from "../transport/event-bus";

// 控制面的资源标识是持久 instanceUid（`inst_` + 32 位十六进制），会话在事件总线里的键与它同值。
const INSTANCE_UID = "inst_0123456789abcdef0123456789abcdef";

/** 实例归属读真实仓储（`agentInstanceService.getOwnedInstance` → `db.select().from().where().limit()`）。 */
function stubInstanceOwnership(...results: unknown[][]) {
  const queue = [...results];
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(queue.shift() ?? []),
        }),
      }),
    }),
  } as never);
}

function instanceRow() {
  return { id: INSTANCE_UID, environmentId: "env-1", ownerUserId: "user-1" };
}

function stubEnvironment(organizationId: string | null) {
  stubEnvironmentRepo({ getById: async () => ({ id: "env-1", userId: "user-1", organizationId }) });
}

describe("SessionAccessFacade 的归属链结论", () => {
  beforeEach(() => {
    initializeAgentRuntimeModuleConfig();
    bindSessionEventBusPort({ getAllBuses: getAllEventBuses, removeBus: removeEventBus });
  });

  afterEach(() => {
    removeEventBus(INSTANCE_UID);
    resetSessionEventBusPort();
    resetEnvironmentRepoStub();
    resetAllStubs();
  });

  // 会话不在事件总线中即不存在——不区分「从未存在」与「已结束」，避免用返回值探测会话。
  test("会话不在事件总线中时拒绝为 session_not_found", async () => {
    const access = await sessionAccessFacade.resolveAccess(INSTANCE_UID, "org-1", "user-1");

    expect(access).toEqual({ granted: false, denial: "session_not_found" });
  });

  // 实例不属于请求方（仓储查不到该用户的实例）时拒绝为 session_not_owned。
  test("实例不属于请求方时拒绝为 session_not_owned", async () => {
    getEventBus(INSTANCE_UID);
    stubInstanceOwnership([]);

    const access = await sessionAccessFacade.resolveAccess(INSTANCE_UID, "org-1", "user-1");

    expect(access).toEqual({ granted: false, denial: "session_not_owned" });
  });

  // 实例绑定的环境属于别的组织时拒绝为 environment_foreign_organization（多租户隔离的核心用例）。
  test("实例绑定的环境属于别的组织时拒绝为 environment_foreign_organization", async () => {
    getEventBus(INSTANCE_UID);
    stubInstanceOwnership([instanceRow()]);
    stubEnvironment("org-2");

    const access = await sessionAccessFacade.resolveAccess(INSTANCE_UID, "org-1", "user-1");

    expect(access).toEqual({ granted: false, denial: "environment_foreign_organization" });
  });

  // 归属链全部通过时返回已解析的会话标识，调用方据此拿到后续动作用的身份。
  test("归属链通过时返回已解析的会话标识", async () => {
    getEventBus(INSTANCE_UID);
    stubInstanceOwnership([instanceRow()]);
    stubEnvironment("org-1");

    const access = await sessionAccessFacade.resolveAccess(INSTANCE_UID, "org-1", "user-1");

    expect(access).toEqual({ granted: true, sessionId: INSTANCE_UID });
  });
});
