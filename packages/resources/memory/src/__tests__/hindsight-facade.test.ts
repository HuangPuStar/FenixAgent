// Hindsight Facade 的隔离语义用例：`actor → bank` 的解析、拒绝语义与跨资源编排都在这层决定。
//
// 与既有用例的分工：`round60-hindsight-routes.test.ts` 走 HTTP 面，证明「切组织即切 bank、解析不出返回
// 403」在协议层的表现；本文件直接对 Facade 求值，证明**它交给上游的那个 bank 来自 actor 的哪个字段**。
// 路由用例经过 Facade，因此门面把映射弄反（例如拿 userId 当 bank、或用组织名兜底）时两边都会红；本文件
// 是那条链路上离判据最近的一层，反转实验的现场也在这一层。
//
// 这里断言的是**语义**而不是字符串形状：身份目录替身给每个 (组织, 用户) 发一个不同的 bank，用例看的是
// 「上游收到的 URL 落在谁的 bank 下」「越权请求有没有真的发出去」。只断言「URL 里出现过某个 id」的写法
// 拦不住把两个 actor 映射到同一个 bank，也拦不住解析失败时退化到共享 bank。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ForbiddenError } from "@fenix/platform-sdk";
import { resetAllStubs, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { hindsightFacade } from "../server/facades/hindsight-facade";
import { initializeMemoryModuleConfig } from "../server/testing";

/** 测试用 Hindsight 服务地址（经模块配置写入，不读 process.env）。 */
const TEST_HINDSIGHT_URL = "http://localhost:8888";

/** 两个组织的同一用户：隔离维度是「组织 + 用户」，同一人在不同组织必须是两个 bank。 */
const ACTOR_ORG_A = { organizationId: "org-a", userId: "user-1" } as const;
const ACTOR_ORG_B = { organizationId: "org-b", userId: "user-1" } as const;
/** 同组织内的另一个人：同一组织也必须按成员分 bank。 */
const ACTOR_ORG_A_OTHER = { organizationId: "org-a", userId: "user-2" } as const;

/** 成员映射表：(组织, 用户) → bank。查不到即「非本组织成员」，与生产一致。 */
const MEMBERSHIPS: Record<string, string> = {
  "org-a/user-1": "member-org-a-1",
  "org-b/user-1": "member-org-b-1",
  "org-a/user-2": "member-org-a-2",
};

describe("Hindsight Facade 的 bank 解析与拒绝语义", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: string[] = [];
  let upstream: () => Promise<Response> = async () => Response.json({ ok: true });

  beforeEach(() => {
    initializeMemoryModuleConfig({ hindsightMcpUrl: TEST_HINDSIGHT_URL });
    fetchCalls = [];
    upstream = async () => Response.json({ ok: true });
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return upstream();
    }) as typeof fetch;
    stubIdentityDirectory({
      resolveMembershipId: async ({ organizationId, userId }) => MEMBERSHIPS[`${organizationId}/${userId}`],
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAllStubs();
  });

  // 代理路径的 bank 必须由 actor 的「组织 + 用户」共同决定：同一用户换组织即换 bank，否则跨组织读到他人记忆。
  test("proxy 把请求落到 actor 自己组织与本人的 bank 下", async () => {
    await hindsightFacade.proxy(ACTOR_ORG_A, "/memories");
    await hindsightFacade.proxy(ACTOR_ORG_B, "/memories");

    expect(fetchCalls).toEqual([
      `${TEST_HINDSIGHT_URL}/v1/default/banks/member-org-a-1/memories`,
      `${TEST_HINDSIGHT_URL}/v1/default/banks/member-org-b-1/memories`,
    ]);
    // 隔离的语义断言：两个 actor 的 bank 必须不同，且 A 的请求 URL 不含 B 的 bank。
    expect(fetchCalls[0]).not.toContain("member-org-b-1");
    expect(fetchCalls[1]).not.toContain("member-org-a-1");
  });

  // 同组织的另一个人的 bank 也不可进入：隔离维度是成员而不是组织。
  test("proxy 不落到同组织他人 bank", async () => {
    await hindsightFacade.proxy(ACTOR_ORG_A_OTHER, "/memories/list");

    expect(fetchCalls).toEqual([`${TEST_HINDSIGHT_URL}/v1/default/banks/member-org-a-2/memories/list`]);
    expect(fetchCalls[0]).not.toContain("member-org-a-1");
  });

  // 解析不出 bank 时必须拒绝且不发出请求（fail-closed）：退化到共享 bank 等于把他人记忆暴露给非成员。
  test("proxy 无成员映射时抛 Forbidden 且不访问上游", async () => {
    await expect(
      hindsightFacade.proxy({ organizationId: "org-a", userId: "not-a-member" }, "/memories"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fetchCalls).toHaveLength(0);
  });

  // 未配置服务时 status 只报告「未启用」，不解析 bank——未部署记忆不该触碰身份目录。
  test("status 未配置时不解析 bank", async () => {
    initializeMemoryModuleConfig();
    let directoryCalls = 0;
    stubIdentityDirectory({
      resolveMembershipId: async () => {
        directoryCalls += 1;
        return "member-org-a-1";
      },
    });

    await expect(hindsightFacade.status(ACTOR_ORG_A)).resolves.toEqual({ enabled: false });
    expect(directoryCalls).toBe(0);
  });

  // 启用时 status 报告地址与该 actor 的 bank；无成员映射或缺上下文时 bankId 为 null（不是错误）。
  test("status 启用时报告当前 actor 的 bank，解析不出则为 null", async () => {
    await expect(hindsightFacade.status(ACTOR_ORG_A)).resolves.toEqual({
      enabled: true,
      url: TEST_HINDSIGHT_URL,
      bankId: "member-org-a-1",
    });
    await expect(hindsightFacade.status({ organizationId: "org-a", userId: "not-a-member" })).resolves.toMatchObject({
      bankId: null,
    });
    await expect(hindsightFacade.status(null)).resolves.toMatchObject({ bankId: null });
  });
});
