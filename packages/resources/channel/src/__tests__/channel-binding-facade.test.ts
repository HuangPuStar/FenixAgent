// 通道绑定 Facade 的职责断言：**把 actor 换成显式归属**，并把「绑定目标 Environment 属不属于调用者
// 组织」这一判断钉在本层。
//
// 与 `./round54-channels-routes.test.ts` 的分工：路由用例证明对外协议行为（状态码、响应形状、鉴权声明），
// 本文件证明**交给领域服务与仓储的那个范围确实来自 actor**——替身按收到的环境 ID 集合模拟
// `agent_id IN (...)`，因此这里钉的是下推的谓词，而不是替身自己实现的过滤结果。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChannelEnvironmentLookup } from "../server/facades/channel-binding-facade";
import { createChannelBindingFacade } from "../server/facades/channel-binding-facade";
import type { ChannelBindingRow } from "../server/repositories/channel-binding";
import { channelBindingRepo } from "../server/repositories/channel-binding";

const NOW = new Date("2026-08-19T00:00:00.000Z");
const ACTOR = { organizationId: "org-1" } as const;

/** 环境替身：`env-1` 属于 org-1，`env-foreign` 属于 org-2。 */
const environments: Record<string, { id: string; name: string; organizationId: string | null }> = {
  "env-1": { id: "env-1", name: "团队环境", organizationId: "org-1" },
  "env-2": { id: "env-2", name: "新环境", organizationId: "org-1" },
  "env-foreign": { id: "env-foreign", name: "他人环境", organizationId: "org-2" },
};

/** 环境归属查询替身：按组织列出环境，按 ID 取环境；`listByOrganizationId` 的入参被记录下来供断言。 */
const environmentLookup: ChannelEnvironmentLookup = {
  getById: async (id) => environments[id],
  listByOrganizationId: async () => [],
};
/** 最近一次组织级环境查询收到的组织 ID：归属范围必须由 actor 的组织推导，而不是请求参数。 */
let queriedOrganizationIds: string[] = [];

/** 领域服务映射后的绑定视图（不含仓储时间戳）；Facade 在它之上补 `agentName`。 */
function view(overrides: Partial<Omit<ChannelBindingRow, "createdAt" | "updatedAt">> = {}) {
  const row = binding(overrides);
  return { id: row.id, platform: row.platform, chatId: row.chatId, agentId: row.agentId, enabled: row.enabled };
}

function binding(overrides: Partial<ChannelBindingRow> = {}): ChannelBindingRow {
  return {
    id: "binding-1",
    platform: "feishu",
    chatId: "chat-1",
    agentId: "env-1",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const originals = {
  create: channelBindingRepo.create,
  delete: channelBindingRepo.delete,
  getById: channelBindingRepo.getById,
  listByAgentIds: channelBindingRepo.listByAgentIds,
  update: channelBindingRepo.update,
};

function restoreRepo(): void {
  channelBindingRepo.create = originals.create;
  channelBindingRepo.delete = originals.delete;
  channelBindingRepo.getById = originals.getById;
  channelBindingRepo.listByAgentIds = originals.listByAgentIds;
  channelBindingRepo.update = originals.update;
}

describe("Channel 绑定 Facade 的归属推导", () => {
  const facade = createChannelBindingFacade({ environmentLookup });

  beforeEach(() => {
    restoreRepo();
    queriedOrganizationIds = [];
    environmentLookup.getById = async (id) => environments[id];
    environmentLookup.listByOrganizationId = async (organizationId) => {
      queriedOrganizationIds.push(organizationId);
      return Object.values(environments).filter((environment) => environment.organizationId === organizationId);
    };
    channelBindingRepo.create = mock(async (input) => binding(input));
    channelBindingRepo.delete = mock(async () => true);
    channelBindingRepo.getById = mock(async (id: string) => (id === "binding-1" ? binding() : null));
    // 替身模拟 SQL 的 `agent_id IN (...)`：范围之外的行走不到调用方，因此越权的行不可能出现在结果里。
    channelBindingRepo.listByAgentIds = mock(async (agentIds: readonly string[]) =>
      [binding()].filter((row) => agentIds.includes(row.agentId)),
    );
    channelBindingRepo.update = mock(async () => {});
  });

  afterEach(() => {
    restoreRepo();
    queriedOrganizationIds = [];
    environmentLookup.getById = async () => undefined;
    environmentLookup.listByOrganizationId = async () => [];
  });

  // 列表的组织范围只能来自 actor：组织交给环境查询，环境 ID 集合作为谓词下推给仓储（跨组织不可达）。
  test("list 用 actor 的组织解析归属并下推环境 ID 谓词", async () => {
    const listByAgentIds = mock(async (agentIds: readonly string[]) =>
      [binding()].filter((row) => agentIds.includes(row.agentId)),
    );
    channelBindingRepo.listByAgentIds = listByAgentIds;

    const views = await facade.list(ACTOR);

    expect(queriedOrganizationIds).toEqual(["org-1"]);
    expect(listByAgentIds).toHaveBeenCalledWith(["env-1", "env-2"]);
    expect(views).toEqual([{ ...view(), agentName: "团队环境" }]);
  });

  // 组织内没有任何环境时不得读绑定表：空范围应当短路成空结果，而不是退化成一次全表查询。
  test("list 在组织没有环境时不查询绑定", async () => {
    environmentLookup.listByOrganizationId = async () => [];
    const listByAgentIds = mock(async () => [binding()]);
    channelBindingRepo.listByAgentIds = listByAgentIds;

    await expect(facade.list(ACTOR)).resolves.toEqual([]);
    expect(listByAgentIds).not.toHaveBeenCalled();
  });

  // 环境已删除（归属查询返回空）时列表只把名称补空，不把整次读取判为失败。
  test("list 对环境不可读的绑定补空名称", async () => {
    environmentLookup.getById = async () => undefined;

    await expect(facade.list(ACTOR)).resolves.toEqual([{ ...view(), agentName: null }]);
  });

  // 创建绑定：目标环境属于其他组织时按「Agent 不存在」拒绝，且不得写入任何行。
  test("create 拒绝跨组织环境且不写库", async () => {
    const create = mock(async (input) => binding(input));
    channelBindingRepo.create = create;

    const result = await facade.create(ACTOR, { platform: "feishu", chatId: "chat-x", agentId: "env-foreign" });

    expect(result).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Agent 不存在" } });
    expect(create).not.toHaveBeenCalled();
  });

  // 创建成功后回显的环境名取自目标环境，归属不来自请求体之外的任何来源。
  test("create 成功时回显目标环境名称", async () => {
    const result = await facade.create(ACTOR, { platform: "feishu", chatId: "chat-x", agentId: "env-1" });

    expect(result.success).toBe(true);
    expect(result).toMatchObject({ data: { chatId: "chat-x", agentId: "env-1", agentName: "团队环境" } });
  });

  // 删除绑定：绑定不存在与跨组织分别给出 404 / 403，两者都不得触达删除语句。
  test("remove 对不存在与跨组织绑定分别拒绝且不删库", async () => {
    const remove = mock(async () => true);
    channelBindingRepo.delete = remove;

    await expect(facade.remove(ACTOR, "missing")).resolves.toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "绑定不存在" },
    });

    channelBindingRepo.getById = mock(async () => binding({ agentId: "env-foreign" }));
    await expect(facade.remove(ACTOR, "binding-1")).resolves.toEqual({
      success: false,
      error: { code: "FORBIDDEN", message: "无权操作此绑定" },
    });

    expect(remove).not.toHaveBeenCalled();
  });

  // 删除成功只回 `null` 数据（协议层据此返回空 data）。
  test("remove 成功返回空数据", async () => {
    await expect(facade.remove(ACTOR, "binding-1")).resolves.toEqual({ success: true, data: null });
  });

  // 更新绑定：请求体里的 `agentId` 是这次写入的新目标，跨组织时必须在写库前拒绝。
  test("update 拒绝改指其他组织环境且不写库", async () => {
    const update = mock(async () => {});
    channelBindingRepo.update = update;

    const result = await facade.update(ACTOR, "binding-1", { agentId: "env-foreign" });

    expect(result).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Agent 不存在" } });
    expect(update).not.toHaveBeenCalled();
  });

  // 更新绑定：原绑定的环境属于其他组织时按无权操作拒绝，同样不得写库。
  test("update 拒绝跨组织原绑定且不写库", async () => {
    channelBindingRepo.getById = mock(async () => binding({ agentId: "env-foreign" }));
    const update = mock(async () => {});
    channelBindingRepo.update = update;

    const result = await facade.update(ACTOR, "binding-1", { enabled: false });

    expect(result).toEqual({ success: false, error: { code: "FORBIDDEN", message: "无权操作此绑定" } });
    expect(update).not.toHaveBeenCalled();
  });

  // 改指到本组织内的另一个环境是合法更新，回显的是**新**环境的名称。
  test("update 允许改指本组织环境并回显新环境名", async () => {
    channelBindingRepo.getById = mock(async () => binding({ agentId: "env-2" }));

    const result = await facade.update(ACTOR, "binding-1", { agentId: "env-2" });

    expect(result.success).toBe(true);
    expect(result).toMatchObject({ data: { agentId: "env-2", agentName: "新环境" } });
  });
});
