import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  initializeTestApplicationInfrastructure,
  resetAllStubs,
  stubIdentityDirectory,
} from "@fenix/platform-sdk/testing";
import Elysia from "elysia";
import { resetTicketsServerModule } from "../server/runtime";
import {
  BINDING_A,
  createTicketHarness,
  DATABASE_STUB,
  installTicketRoutes,
  ORG_A,
  ORG_B,
  PROJECT_A,
  type StubMember,
  stubDirectory,
  type TicketHarness,
  testActor,
} from "./ticket-harness";

/**
 * 成员候选投影的契约（backend contract §12 `ticket-members.test.ts` / §1.1 第 9 条 / 裁定二.6）。
 *
 * 这条路由有两处必须钉住：**透传**（`page` / `pageSize` / `q` 原样到身份目录）与**收窄**（只回
 * `userId` 与 `name`）。走路由级是唯一能同时验证两者的层次——协议层的分页解析（默认值、上限）也一起被
 * 验证；只测 Facade 会让「参数在 schema 里被吞掉」这类缺陷漏网。
 *
 * 权限面只有一条：候选名单是组织成员的公开信息，**项目 `read` 即可**（不是管理动作），因此本文件没有 403
 * 用例，普通成员读得到（用例 ① 的 actor 就是 member）。
 */

const MEMBERS: readonly StubMember[] = [
  { userId: "user_a", name: "张创建" },
  { userId: "user_b", name: "王管理" },
  { userId: "user_c", name: "李其他" },
];

/** 身份目录收到的每次成员查询；「透传」与「跨组织零调用」都断言它。 */
interface MemberQuery {
  readonly organizationId: string;
  readonly keyword?: string;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * 记录型成员投影：按收到的 `page` / `pageSize` 切片，让「透传的数字真的被用上」可见（替身若忽略它们，
 * 断言就只能证明参数到了身份目录、证明不了响应用了它）。
 *
 * 刻意不实现关键字过滤：模糊匹配的语义归 `@fenix/identity` 的用例，这里只断言关键字原样到达。
 */
function recordMemberProjection(items: readonly StubMember[] = MEMBERS): MemberQuery[] {
  const calls: MemberQuery[] = [];
  stubIdentityDirectory({
    listOrganizationMembers: async (input) => {
      calls.push({ ...input });
      const start = (input.page - 1) * input.pageSize;
      return { items: items.slice(start, start + input.pageSize), total: items.length };
    },
  });
  return calls;
}

async function setup(): Promise<TicketHarness> {
  stubDirectory({
    users: MEMBERS.map((member) => ({ id: member.userId, name: member.name })),
    membersOf: { [ORG_A]: MEMBERS },
  });
  const harness = createTicketHarness();
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, repositoryRef: BINDING_A });
  return harness;
}

/** 请求一次成员列表；`query` 含前导 `?`，默认无参数。 */
async function requestMembers(
  harness: TicketHarness,
  actor: ReturnType<typeof testActor>,
  query = "",
): Promise<{
  readonly status: number;
  readonly payload: {
    readonly success: boolean;
    readonly data?: { readonly items: ReadonlyArray<Record<string, unknown>>; readonly total: number };
    readonly error?: { readonly code: string };
  };
}> {
  const app = new Elysia().use(installTicketRoutes(harness, actor));
  const response = await app.handle(new Request(`http://localhost/ticket-projects/${PROJECT_A}/members${query}`));
  return {
    status: response.status,
    payload: (await response.json()) as {
      success: boolean;
      data?: { items: ReadonlyArray<Record<string, unknown>>; total: number };
      error?: { code: string };
    },
  };
}

beforeEach(() => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
});

afterEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
});

describe("成员候选投影", () => {
  // 分页参数必须原样到身份目录：协议层解析出的 page/pageSize 被吞掉或改写时，前端翻页会静默错位。
  test("分页参数按声明透传，total 原样回显", async () => {
    const harness = await setup();
    const calls = recordMemberProjection();

    const { status, payload } = await requestMembers(
      harness,
      testActor("user_a", ORG_A, "member"),
      "?page=2&pageSize=1",
    );

    expect(status).toBe(200);
    expect(calls).toEqual([{ organizationId: ORG_A, page: 2, pageSize: 1 }]);
    expect(payload.data).toEqual({ items: [MEMBERS[1]], total: 3 });
  });

  // 缺省参数取平台默认（page 1 / pageSize 20）：未传参时不得把 undefined 透给身份目录。
  test("缺省分页取平台默认值", async () => {
    const harness = await setup();
    const calls = recordMemberProjection();

    const { status } = await requestMembers(harness, testActor("user_a", ORG_A, "member"));

    expect(status).toBe(200);
    expect(calls).toEqual([{ organizationId: ORG_A, page: 1, pageSize: 20 }]);
  });

  // 关键字只在姓名上模糊匹配：路由层不得自行过滤或改写，q 必须原样到达身份目录。
  test("姓名关键字原样透传", async () => {
    const harness = await setup();
    const calls = recordMemberProjection();

    const { status, payload } = await requestMembers(harness, testActor("user_a", ORG_A, "member"), "?q=王");

    expect(status).toBe(200);
    expect(calls[0]).toEqual({ organizationId: ORG_A, keyword: "王", page: 1, pageSize: 20 });
    expect(payload.data?.total).toBe(3);
  });

  // 跨组织项目与不存在同形 404；且不得为它查成员名单，否则对方的组织成员成了可探测情报。
  test("跨组织项目：404 且身份目录零调用", async () => {
    const harness = await setup();
    const calls = recordMemberProjection();

    const { status, payload } = await requestMembers(harness, testActor("user_b", ORG_B, "member"));

    expect(status).toBe(404);
    expect(payload.success).toBe(false);
    expect(calls).toEqual([]);
  });

  // 投影只搬 userId 与 name：身份目录里的 email / 手机号 / 账号状态不得经这条路由外泄（裁定二.6）。
  test("投影只含 userId 与 name", async () => {
    const harness = await setup();
    // 变量而非字面量传入：运行时字段真实存在，才能验证白名单搬运确实丢掉了它们。
    const leakyMember = {
      userId: "user_a",
      name: "张创建",
      email: "zhang@example.test",
      phone: "13800000000",
      status: "active",
    };
    recordMemberProjection([leakyMember]);

    const { status, payload } = await requestMembers(harness, testActor("user_a", ORG_A, "member"));

    expect(status).toBe(200);
    expect(payload.data?.items).toEqual([{ userId: "user_a", name: "张创建" }]);
    expect(Object.keys(payload.data?.items[0] ?? {})).toEqual(["userId", "name"]);
  });
});
