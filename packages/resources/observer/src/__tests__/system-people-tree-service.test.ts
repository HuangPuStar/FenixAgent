// 系统人员树 service 的业务规则用例（真实 service + agent-config 公开取数面的真实实现，
// 只替换平台契约的身份目录端口与 DB 句柄）。
//
// 为什么必须补：协议层用例走 `setSystemPeopleTreeServiceForTests` 注入假 service，服务自身的规则完全
// 覆盖不到。这些规则写错时接口照样返回 200——只是树上少了一批历史 owner（他们名下的智能体随之在系统
// 视图里消失），或者给没有 member 行的人编造出一个角色。批量补齐还承担性能契约：缺失 owner 必须一次
// 批量投影，不能在循环里逐行查询（组织多、owner 多时是 N+1）。
//
// 取数在 B7 后由 agent-config 的 `listAgentConfigsByOrganization()` 承担，但它与宿主的其它仓储同源于
// platform-sdk 的 `getDatabase()`，因此 `stubDb()` 登记的替身同样拦得住——service 仍按组织各查一次、
// 只拿到本组织的行，这条多租户隔离断言不因换接 owner 而失效。

import { beforeEach, describe, expect, test } from "bun:test";
import type { OrganizationWithMembers, UserDisplayInfo } from "@fenix/platform-sdk";
import { resetAllStubs, stubDb, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { createSystemPeopleTreeService } from "../server/services/system-people-tree-service";
import { createPeopleTreeDbStub, systemPeopleAgentRow } from "./system-people-db-stub";

/** 身份目录替身：返回给定组织名录，并记录批量补齐的实际入参（断言「一次批量」而非逐行）。 */
function stubDirectory(input: {
  organizations: OrganizationWithMembers[];
  displayInfo?: ReadonlyMap<string, UserDisplayInfo>;
}) {
  const batchCalls: string[][] = [];
  stubIdentityDirectory({
    listOrganizationsWithMembers: async () => input.organizations,
    listUserDisplayInfo: async (userIds) => {
      batchCalls.push([...userIds]);
      const found = new Map<string, UserDisplayInfo>();
      for (const userId of userIds) {
        const info = input.displayInfo?.get(userId);
        if (info) found.set(userId, info);
      }
      return found;
    },
  });
  return { batchCalls };
}

/** 组织名录夹具；只写本用例关心的字段，`slug` 固定以免每条用例重复。 */
function organization(
  input: Partial<OrganizationWithMembers> & Pick<OrganizationWithMembers, "id" | "members">,
): OrganizationWithMembers {
  return { name: "研发部", slug: "engineering", ...input };
}

describe("system-people-tree service", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 用户集合是「组织成员 ∪ agent owner」的并集：缺 member 行的历史 owner 仍要出现在树上，
  // 且 role 为 null（不能编造成员角色），其展示信息由目录批量投影补齐，手机号按契约不进投影。
  test("成员与 agent owner 取并集，缺 member 行者 role 为 null", async () => {
    const db = createPeopleTreeDbStub({
      "org-1": [
        systemPeopleAgentRow({ id: "agent-bob", userId: "user-bob", name: "Bob 的助手" }),
        systemPeopleAgentRow({ id: "agent-alice", userId: "user-alice", name: "Alice 的助手" }),
      ],
    });
    stubDb(db.db);
    const directory = stubDirectory({
      organizations: [
        organization({
          id: "org-1",
          members: [
            {
              userId: "user-bob",
              name: "Bob",
              email: "bob@example.com",
              phoneNumber: "+8613800138000",
              role: "owner",
            },
          ],
        }),
      ],
      displayInfo: new Map([["user-alice", { id: "user-alice", name: "Alice", email: "alice@example.com" }]]),
    });

    const [org] = await createSystemPeopleTreeService().listTree();

    // 排序按 name（再按 id），与界面展示顺序一致
    expect(org.users.map((user) => user.id)).toEqual(["user-alice", "user-bob"]);

    const alice = org.users[0];
    expect(alice).toEqual({
      id: "user-alice",
      name: "Alice",
      email: "alice@example.com",
      phoneNumber: null,
      role: null,
      agents: [expect.objectContaining({ id: "agent-alice" })],
    });

    const bob = org.users[1];
    expect(bob.role).toBe("owner");
    expect(bob.phoneNumber).toBe("+8613800138000");
    expect(bob.agents.map((agent) => agent.id)).toEqual(["agent-bob"]);

    // 只补齐缺失的 owner，且是一次批量（入参是去重后的缺失集合）
    expect(directory.batchCalls).toEqual([["user-alice"]]);
  });

  // 全部 owner 都是组织成员时不触发任何补齐查询：成员投影已经带齐展示信息，多查一次就是无谓的 N+1。
  test("owner 均有 member 行时不查询目录补齐", async () => {
    const db = createPeopleTreeDbStub({
      "org-1": [systemPeopleAgentRow({ id: "agent-bob", userId: "user-bob" })],
    });
    stubDb(db.db);
    const directory = stubDirectory({
      organizations: [
        organization({
          id: "org-1",
          members: [{ userId: "user-bob", name: "Bob", email: "bob@example.com", phoneNumber: null, role: "member" }],
        }),
      ],
    });

    const [org] = await createSystemPeopleTreeService().listTree();

    expect(org.users.map((user) => user.id)).toEqual(["user-bob"]);
    expect(directory.batchCalls).toEqual([]);
  });

  // 目录里也查不到该 owner 时回退原始 id 与空邮箱：宁可显示 id，也不能删掉这个人连同他的智能体。
  test("目录缺失 owner 展示信息时回退原始 id", async () => {
    const db = createPeopleTreeDbStub({
      "org-1": [systemPeopleAgentRow({ id: "agent-ghost", userId: "user-ghost" })],
    });
    stubDb(db.db);
    stubDirectory({
      organizations: [organization({ id: "org-1", members: [] })],
      displayInfo: new Map(),
    });

    const [org] = await createSystemPeopleTreeService().listTree();

    expect(org.users).toEqual([
      {
        id: "user-ghost",
        name: "user-ghost",
        email: "",
        phoneNumber: null,
        role: null,
        agents: [expect.objectContaining({ id: "agent-ghost" })],
      },
    ]);
  });

  // 组织之间互不串行：每个组织各查一次取数面，agent 只挂到本组织的用户下（多租户隔离的最低要求）。
  test("按组织分别取数，agent 不跨组织挂载", async () => {
    const db = createPeopleTreeDbStub({
      "org-1": [systemPeopleAgentRow({ id: "agent-1", userId: "user-1" })],
      "org-2": [systemPeopleAgentRow({ id: "agent-2", userId: "user-2" })],
    });
    stubDb(db.db);
    stubDirectory({
      organizations: [
        organization({
          id: "org-1",
          members: [{ userId: "user-1", name: "甲", email: "a@example.com", phoneNumber: null, role: "member" }],
        }),
        organization({
          id: "org-2",
          members: [{ userId: "user-2", name: "乙", email: "b@example.com", phoneNumber: null, role: "member" }],
        }),
      ],
    });

    const organizations = await createSystemPeopleTreeService().listTree();

    expect(organizations.map((org) => org.id)).toEqual(["org-1", "org-2"]);
    expect(organizations[0].users.map((user) => [user.id, user.agents.map((agent) => agent.id)])).toEqual([
      ["user-1", ["agent-1"]],
    ]);
    expect(organizations[1].users.map((user) => [user.id, user.agents.map((agent) => agent.id)])).toEqual([
      ["user-2", ["agent-2"]],
    ]);
    expect(db.whereClauses).toHaveLength(2);
  });

  // 同一用户多个 agent 全部挂上，且保持取数面的返回顺序（owner 的 SQL 已按 name → id 排序，服务不得重排）。
  test("同一用户的多个 agent 全量挂载并保持仓储顺序", async () => {
    const db = createPeopleTreeDbStub({
      "org-1": [
        systemPeopleAgentRow({ id: "agent-a", userId: "user-1", name: "alpha" }),
        systemPeopleAgentRow({ id: "agent-b", userId: "user-1", name: "beta" }),
        systemPeopleAgentRow({ id: "agent-c", userId: "user-1", name: "gamma" }),
      ],
    });
    stubDb(db.db);
    stubDirectory({
      organizations: [
        organization({
          id: "org-1",
          members: [{ userId: "user-1", name: "Bob", email: "bob@example.com", phoneNumber: null, role: "admin" }],
        }),
      ],
    });

    const [org] = await createSystemPeopleTreeService().listTree();

    expect(org.users[0].agents.map((agent) => agent.id)).toEqual(["agent-a", "agent-b", "agent-c"]);
  });

  // 空组织（既无成员也无智能体）返回空用户列表而不是抛错：新组织在系统视图里是合法的空节点。
  test("空组织返回空用户列表", async () => {
    const db = createPeopleTreeDbStub({});
    stubDb(db.db);
    stubDirectory({ organizations: [organization({ id: "org-empty", members: [] })] });

    const [org] = await createSystemPeopleTreeService().listTree();

    expect(org).toEqual({ id: "org-empty", name: "研发部", slug: "engineering", users: [] });
  });
});
