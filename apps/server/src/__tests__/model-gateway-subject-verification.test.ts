import { afterEach, describe, expect, test } from "bun:test";
import { agentConfigResource } from "@fenix/agent-config/server";
import { createStubAccessControl } from "@fenix/model-management/server/testing";
import { ResourceAccessDeniedError } from "@fenix/platform-sdk";
import { getIdentityDirectoryStub, resetAllStubs, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { createModelGatewaySubjectVerification } from "../services/model-gateway-subject-verification";

/**
 * 主体复验端口实现的拒绝路径回归（1.52 的 S5 验收缺口）。
 *
 * 这是**签发上游网关凭据前的权限判定**：`model-management` 声明窄端口、宿主装配真实实现。它新增了
 * 三种原先恒不可达的拒绝原因（用户 / 组织 / Agent 不存在），凭据吊销检测据原因决定"删除上游凭据"
 * 还是"保留映射等待权限恢复"——因此原因必须精确，且**判定顺序**也是契约：顺序变了，同一种失效会
 * 被归到另一个原因上，处置方式随之漂移。
 *
 * 覆盖点：五种拒绝原因各自的触发条件与顺序早退、非权限异常原样上抛（不得伪装成"权限已被收回"），
 * 以及放行路径下 actor 是否携带**全量**成员关系（身份投影的形态要求：授权只读其中"当前组织"那一条，
 * 但主体必须整体带上，只带当前组织一项等于丢失投影）。
 */

const INPUT = { organizationId: "org-1", userId: "user-1", agentConfigId: "agent-1" } as const;

/** 构造被测端口；Agent 归属读取与授权结果按用例覆盖，并回传调用记录供断言。 */
function createSubjectVerification(
  overrides: {
    ownerOrganizationId?: string;
    authorize?: () => Promise<void>;
    findAgentConfigOrganization?: (agentConfigId: string) => Promise<string | undefined>;
  } = {},
) {
  const authorizeCalls: { action?: string; resourceId?: string; resource?: unknown; actor?: unknown }[] = [];
  const ownershipReads: string[] = [];
  const port = createModelGatewaySubjectVerification({
    accessControl: createStubAccessControl({
      authorize: async (input) => {
        authorizeCalls.push(input);
        await overrides.authorize?.();
      },
    }),
    identity: getIdentityDirectoryStub(),
    findAgentConfigOrganization: async (agentConfigId) => {
      ownershipReads.push(agentConfigId);
      if (overrides.findAgentConfigOrganization) return overrides.findAgentConfigOrganization(agentConfigId);
      return "ownerOrganizationId" in overrides ? overrides.ownerOrganizationId : "org-1";
    },
  });
  return { port, authorizeCalls, ownershipReads };
}

/** 补齐「存在用户 / 存在组织 / 成员关系」三项最小身份数据，供拒绝原因靠后的用例共用。 */
function stubMemberIdentity() {
  stubIdentityDirectory({
    getUser: async () => ({ id: "user-1", name: "u", email: "u@example.test" }),
    getOrganization: async () => ({ id: "org-1", name: "o" }),
    // 全量成员关系：主体要整体带上身份投影（第二个组织只用于证明"全量"，不扩大可见范围）。
    listMemberships: async () => [
      { organizationId: "org-1", role: "owner" },
      { organizationId: "org-2", role: "member" },
    ],
  });
}

describe("模型网关主体复验", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 用户已不存在必须报 USER_NOT_FOUND：吊销检测据此删除上游凭据，而不是保留映射等待权限恢复。
  test("用户不存在时返回 USER_NOT_FOUND，且不再继续后续判定", async () => {
    stubIdentityDirectory({ getUser: async () => undefined });
    const { port, authorizeCalls, ownershipReads } = createSubjectVerification();

    expect(await port.verify(INPUT)).toEqual({ valid: false, reason: "USER_NOT_FOUND" });
    expect(authorizeCalls).toHaveLength(0);
    expect(ownershipReads).toHaveLength(0);
  });

  // 组织已不存在同属"主体已消失"，与成员关系缺失（权限问题）必须区分开。
  test("组织不存在时返回 ORGANIZATION_NOT_FOUND，且不读 Agent 归属", async () => {
    stubIdentityDirectory({
      getUser: async () => ({ id: "user-1", name: "u", email: "u@example.test" }),
      getOrganization: async () => undefined,
    });
    const { port, authorizeCalls, ownershipReads } = createSubjectVerification();

    expect(await port.verify(INPUT)).toEqual({ valid: false, reason: "ORGANIZATION_NOT_FOUND" });
    expect(authorizeCalls).toHaveLength(0);
    expect(ownershipReads).toHaveLength(0);
  });

  // 非成员是权限问题而非主体消失：原因必须与 USER_NOT_FOUND 区分，否则上游凭据会被误删。
  test("非组织成员时返回 MEMBERSHIP_NOT_FOUND", async () => {
    stubIdentityDirectory({
      getUser: async () => ({ id: "user-1", name: "u", email: "u@example.test" }),
      getOrganization: async () => ({ id: "org-1", name: "o" }),
      listMemberships: async () => [{ organizationId: "org-2", role: "member" }],
    });
    const { port, authorizeCalls } = createSubjectVerification();

    expect(await port.verify(INPUT)).toEqual({ valid: false, reason: "MEMBERSHIP_NOT_FOUND" });
    expect(authorizeCalls).toHaveLength(0);
  });

  // Agent 归属其它组织时对本次复验等同于不存在——不得把"别人的 Agent"算作可达。
  test("Agent 归属其它组织时返回 AGENT_NOT_FOUND", async () => {
    stubMemberIdentity();
    const { port, authorizeCalls } = createSubjectVerification({ ownerOrganizationId: "org-2" });

    expect(await port.verify(INPUT)).toEqual({ valid: false, reason: "AGENT_NOT_FOUND" });
    expect(authorizeCalls).toHaveLength(0);
  });

  // Agent 行已删除时同样是 AGENT_NOT_FOUND：归属读取返回 undefined 不能被当成"无归属即放行"。
  test("Agent 不存在时返回 AGENT_NOT_FOUND", async () => {
    stubMemberIdentity();
    const { port, authorizeCalls } = createSubjectVerification({ findAgentConfigOrganization: async () => undefined });

    expect(await port.verify(INPUT)).toEqual({ valid: false, reason: "AGENT_NOT_FOUND" });
    expect(authorizeCalls).toHaveLength(0);
  });

  // 资源存在但授权不通过时才是"权限被收回"：凭据映射保留，等权限恢复后自动可用。
  test("授权拒绝映射为 AGENT_ACCESS_REVOKED", async () => {
    stubMemberIdentity();
    const { port, authorizeCalls } = createSubjectVerification({
      authorize: async () => {
        throw new ResourceAccessDeniedError();
      },
    });

    expect(await port.verify(INPUT)).toEqual({ valid: false, reason: "AGENT_ACCESS_REVOKED" });
    expect(authorizeCalls).toHaveLength(1);
  });

  // 基础设施故障（数据库不可用等）必须原样上抛：伪装成"权限已被收回"会误删用户的上游凭据。
  test("非权限异常原样上抛，不伪装成权限收回", async () => {
    stubMemberIdentity();
    const failure = new Error("database unavailable");
    const { port } = createSubjectVerification({
      authorize: async () => {
        throw failure;
      },
    });

    await expect(port.verify(INPUT)).rejects.toBe(failure);
  });

  // 放行路径必须走同一份 agent_config 真实授权规则，且 actor 是完整的身份投影（全量成员关系）。
  test("放行时以全量成员关系与 use 动作调用真实资源注册", async () => {
    stubMemberIdentity();
    const { port, authorizeCalls } = createSubjectVerification();

    expect(await port.verify(INPUT)).toEqual({ valid: true });
    expect(authorizeCalls).toHaveLength(1);
    expect(authorizeCalls[0]).toMatchObject({
      action: "use",
      resourceId: "agent-1",
      resource: agentConfigResource.definition,
      actor: {
        kind: "user",
        userId: "user-1",
        activeOrganizationId: "org-1",
        memberships: [
          { organizationId: "org-1", role: "owner" },
          { organizationId: "org-2", role: "member" },
        ],
      },
    });
  });
});
