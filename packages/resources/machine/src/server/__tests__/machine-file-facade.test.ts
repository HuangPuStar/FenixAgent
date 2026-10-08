// Machine 文件域门面的授权用例：`actor → 显式范围` 的转换、角色下传与错误分类。
//
// 与 `agent-file-service.test.ts` 的分工：那份用例经门面打开执行面、覆盖本地/远程的文件行为（读写、
// 路径校验、背压、错误映射）；本文件只钉门面自己的判据——**授权在打开执行面之前完成**，且交给归属校验的
// 身份来自 actor 而不是请求数据。放在单独文件里而不是塞回执行面用例：那是执行面与门面两层职责的分界，
// 混在一起会让「这层测的是谁」在改动时反复需要重读整份用例。
//
// 第二组覆盖 WS 订阅入口（`authorizeEventSubscription`）：它与 `open` 共用同一份归属判定，
// `file-events-subscribe-auth.test.ts` 在路由/连接层验证同一判据的协议表现，两份用例合起来才能说明
// 「路由不再自行判定」没有把跨组织与跨属主的环境放进来。
//
// 归属校验的实现（`getOwnedEnvironment`）在生产由 agent-runtime 提供，它自己的 member → 403 规则由
// `agent-runtime/src/__tests__/registry-environment-isolation-coverage.test.ts` 覆盖；本文件用替身表达
// 同一份契约，只证明门面把 actor 的四个维度原样交给它、并把失败映射成文件域错误信封。

import { afterEach, describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { MachineEnvironmentRecord } from "../environment-port";
import { type MachineFileActor, machineFileFacade } from "../facades/machine-file-facade";
import { stubMachineEnvironment } from "../testing";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";

/** 调用方 actor：组织 + 属主 + 角色（与宿主 `store.authContext` 的形状一致）。 */
const ACTOR: MachineFileActor = { organizationId: ORG_ID, userId: USER_ID, role: "owner" };

/** 每次归属校验收到的完整入参；门面把它们原样下传，用例据此断言。 */
let ownershipCalls: unknown[][] = [];

/** 用一条「属于当前 actor」的环境记录替换归属校验，并记录调用入参。 */
function recordOwnership(impl?: (role: string | undefined) => void): void {
  ownershipCalls = [];
  stubMachineEnvironment({
    getOwnedEnvironment: async (environmentId, organizationId, userId, role) => {
      ownershipCalls.push([environmentId, organizationId, userId, role]);
      impl?.(role);
      return { id: ENV_ID, organizationId: ORG_ID, userId: USER_ID };
    },
  });
}

describe("Machine 文件域门面的授权判据", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 环境、组织、用户与角色四项都必须来自 actor：少传角色会让「member」这类门槛静默失效，
  // 少传组织/用户则让跨组织与跨属主的环境变得可达。
  test("门面把 actor 的组织、用户与角色都交给环境归属校验", async () => {
    recordOwnership();

    await machineFileFacade.open({ organizationId: ORG_ID, userId: USER_ID, role: "admin" }, ENV_ID);

    expect(ownershipCalls).toEqual([[ENV_ID, ORG_ID, USER_ID, "admin"]]);
  });

  // 未声明角色时不猜一个默认角色：未声明与「声明了 owner」在归属校验里是两种语义。
  test("actor 未声明角色时原样下传 undefined", async () => {
    recordOwnership();

    await machineFileFacade.open({ organizationId: ORG_ID, userId: USER_ID }, ENV_ID);

    expect(ownershipCalls).toEqual([[ENV_ID, ORG_ID, USER_ID, undefined]]);
  });

  // 角色门槛的拒绝语义由门面映射成文件域信封：`member` 被归属校验拒绝后按 `forbidden` + 403 上抛
  // （fail-closed），且不构造执行面——授权失败时调用方拿不到任何后端句柄。
  test("member 角色被归属校验拒绝 → 403 forbidden", async () => {
    recordOwnership((role) => {
      if (role === "member") throw new ForbiddenError("成员无权操作该环境的文件");
    });

    await expect(machineFileFacade.open({ ...ACTOR, role: "member" }, ENV_ID)).rejects.toMatchObject({
      type: "forbidden",
      statusCode: 403,
    });
  });
});

/**
 * 用一条环境记录表达生产归属规则：记录缺失 / 跨组织 / agent 绑定环境非本人 → `NotFoundError`
 * （与 agent-runtime 的 `getOwnedEnvironment` 同类型同消息，见 `../testing` 的说明）。
 * 替身里重述这条规则而不是「按入参直接放行」，是为了让跨组织与跨属主两个用例走真实的判定分支。
 */
function stubOwnershipRule(record: MachineEnvironmentRecord): void {
  ownershipCalls = [];
  stubMachineEnvironment({
    getOwnedEnvironment: async (environmentId, organizationId, userId, role) => {
      ownershipCalls.push([environmentId, organizationId, userId, role]);
      if (environmentId !== record.id || record.organizationId !== organizationId)
        throw new NotFoundError("环境不存在");
      if (record.agentConfigId && record.userId !== userId) throw new NotFoundError("环境不存在");
      return record;
    },
  });
}

describe("Machine 文件域门面的事件订阅授权", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 跨组织的 environment 不可订阅：判定归门面，失败按文件域信封上抛（not_found 404），
  // 端点据此回 subscribe_error 而不是建立订阅。
  test("跨组织的 environment 不可订阅 → not_found 404", async () => {
    stubOwnershipRule({ id: ENV_ID, organizationId: "org-2", userId: USER_ID });

    await expect(machineFileFacade.authorizeEventSubscription(ACTOR, ENV_ID)).rejects.toMatchObject({
      type: "not_found",
      statusCode: 404,
    });
    // 判定用的身份来自 actor：组织/用户被原样交给归属校验，请求数据无法影响这个判定。
    expect(ownershipCalls).toEqual([[ENV_ID, ORG_ID, USER_ID, undefined]]);
  });

  // 非本人的 environment 同样不可订阅（agent 绑定的环境属个人 workspace，共享 agent 不等于共享 workspace）。
  test("非本人持有的 environment 不可订阅 → not_found 404", async () => {
    stubOwnershipRule({ id: ENV_ID, organizationId: ORG_ID, userId: "user-2", agentConfigId: "ac-1" });

    await expect(machineFileFacade.authorizeEventSubscription(ACTOR, ENV_ID)).rejects.toMatchObject({
      type: "not_found",
      statusCode: 404,
    });
  });

  // 订阅是读操作：归属判定不下传角色，因此 member 也能订阅共享环境的变更（迁移前 WS 端点同样不传角色，
  // 拦在订阅外属行为变更）。与 `open` 的写侧 fail-closed 门槛的不对称是有意的，不是漏传。
  test("订阅入口按读操作语义判定：不下传角色", async () => {
    stubOwnershipRule({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID });

    await machineFileFacade.authorizeEventSubscription({ ...ACTOR, role: "member" }, ENV_ID);

    expect(ownershipCalls).toEqual([[ENV_ID, ORG_ID, USER_ID, undefined]]);
  });
});
