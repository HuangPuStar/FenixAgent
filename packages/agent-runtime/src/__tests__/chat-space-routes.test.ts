import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebChatSpacesRoutes } from "@fenix/agent-runtime/server";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { initializeAgentRuntimeModuleConfig, resetEnvironmentRepoStub, stubEnvironmentRepo } from "../server/testing";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

/**
 * `/web/chat-spaces/**` 的协议面：状态码、响应形状与跨租户行为。
 *
 * 授权链读两份数据，替身来源不同、必须分别设置（同 `web-control-routes.test.ts`）：
 * - 实例归属走真实仓储（`agentInstanceService.getOwnedInstance` → `db.select().from().where().limit()`），用
 *   `stubDb` 按调用顺序发号；
 * - 环境组织归属走 `environmentRepo.getById`，经 `../server/testing` 的 `stubEnvironmentRepo` 设置。
 *
 * 分组行同样经 `stubDb` 发号。断言重点是两件用户可观察的事：跨用户/跨组织被拒，且 **scope 只来自认证
 * 上下文**——请求体或查询串里塞 `userId` 不能改变实际查写的归属。以分组定位的两个动作（PATCH / PUT）
 * 还多一层：`instanceUid` 是权威作用域，分组行必须落在该实例内，否则 404；移出（DELETE）以实例 + 会话定位，
 * 摘除范围由服务端按 scope 决定，调用方不传分组 id。
 */

const DIALECT = new PgDialect();
const INSTANCE_UID = "inst_0123456789abcdef0123456789abcdef";
const SPACE_ID = "space_0123456789abcdef0123456789abcdef";
const SESSION_ID = "ses_0123456789abcdef";
const NOW = new Date("2026-10-15T00:00:00.000Z");

/** 视图的冻结字段集：归属列（userId）不回报，多一个字段都是契约变化。 */
const SPACE_VIEW_KEYS = ["createdAt", "id", "instanceUid", "name", "sessionIds", "updatedAt"];

const route = createWebChatSpacesRoutes({
  authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(),
});

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function json(path: string, method: string, body?: unknown) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 以分组定位的动作（PATCH / PUT）与移出（DELETE）都带 `instanceUid`：它是服务端的权威作用域。 */
function instanceQuery(): string {
  return `?instanceUid=${INSTANCE_UID}`;
}

function instanceRow() {
  return {
    id: INSTANCE_UID,
    environmentId: "env-1",
    ownerUserId: "user-1",
    creationSource: "user",
    name: "default",
    isDefault: true,
    createdByUserId: "user-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function spaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SPACE_ID,
    name: "研发",
    userId: "user-1",
    instanceUid: INSTANCE_UID,
    sessionIds: [SESSION_ID],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

type SelectChain = Promise<unknown[]> & {
  limit: () => SelectChain;
  orderBy: () => SelectChain;
  for: () => SelectChain;
};
type WriteChain = Promise<unknown[]> & { returning: () => Promise<unknown[]> };

interface CapturedStatement {
  readonly kind: "select" | "update" | "insert";
  readonly where: unknown;
  readonly values: Record<string, unknown> | null;
}

/** DB 句柄替身：三类语句各按调用顺序发号，并记录 where 与写入值供断言。 */
function installDb(
  options: {
    readonly selectRows?: readonly unknown[][];
    readonly updateRows?: readonly unknown[][];
    readonly insertRows?: readonly unknown[][];
  } = {},
) {
  const selects = [...(options.selectRows ?? [])];
  const updates = [...(options.updateRows ?? [])];
  const inserts = [...(options.insertRows ?? [])];
  const captured: CapturedStatement[] = [];

  function selectChain(rows: unknown[]): SelectChain {
    const chain: SelectChain = Object.assign(Promise.resolve(rows), {
      limit: () => chain,
      orderBy: () => chain,
      for: () => chain,
    });
    return chain;
  }

  function writeChain(rows: unknown[]): WriteChain {
    return Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) });
  }

  function makeHandle() {
    return {
      select: () => ({
        from: () => ({
          where: (where: unknown) => {
            captured.push({ kind: "select", where, values: null });
            return selectChain(selects.shift() ?? []);
          },
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: unknown) => {
            captured.push({ kind: "update", where, values });
            return writeChain(updates.shift() ?? []);
          },
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          captured.push({ kind: "insert", where: null, values });
          const chain = writeChain(inserts.shift() ?? []);
          return Object.assign(chain, { onConflictDoNothing: () => chain });
        },
      }),
    };
  }

  const txHandle = makeHandle();
  const db = {
    ...makeHandle(),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(txHandle),
  };

  stubDb(db as never);
  return { captured };
}

/** 渲染捕获到的 SQL 对象（与真实下发的语句同一条方言渲染路径）。 */
function render(statement: unknown): { sql: string; params: unknown[] } {
  return DIALECT.sqlToQuery(statement as SQL);
}

function statements(captured: readonly CapturedStatement[], kind: CapturedStatement["kind"]) {
  return captured.filter((statement) => statement.kind === kind);
}

/** 归属链的环境维度替身：默认组织一致，`organizationId` 换成别的组织即模拟跨组织。 */
function stubEnvironment(organizationId: string | null) {
  stubEnvironmentRepo({ getById: async () => ({ id: "env-1", userId: "user-1", organizationId }) });
}

beforeEach(() => {
  resetAllStubs();
  initializeAgentRuntimeModuleConfig();
  setTestAuth({ organizationId: "org-1", userId: "user-1" });
});

afterEach(() => {
  resetEnvironmentRepoStub();
  resetTestAuth();
  resetAllStubs();
});

describe("Web Chat Spaces Routes", () => {
  // 与宿主 `/web/*` 共用同一份认证：未认证请求由守卫拦下，路由不自行解析凭据。
  test("未认证请求返回 401", async () => {
    resetTestAuth();

    const response = await request(`/chat-spaces?instanceUid=${INSTANCE_UID}`);

    expect(response.status).toBe(401);
  });

  // 认证缺少组织上下文时无法判定环境归属，保守拒绝为 403（不放行到仓储层）。
  test("缺少组织上下文返回 403", async () => {
    setTestAuth({ organizationId: "", userId: "user-1" });

    const response = await request(`/chat-spaces?instanceUid=${INSTANCE_UID}`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  // 实例不属于当前用户时返回 404：与「实例不存在」同一响应，不泄露跨用户的实例存在性。
  test("实例不属于当前用户时返回 404", async () => {
    installDb({ selectRows: [[]] });

    const response = await request(`/chat-spaces?instanceUid=${INSTANCE_UID}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found", message: "Agent Instance not found" } });
  });

  // 实例属于当前用户但其环境属于别的组织时返回 403（多租户隔离）。
  test("环境属于别的组织时返回 403", async () => {
    installDb({ selectRows: [[instanceRow()]] });
    stubEnvironment("org-2");

    const response = await request(`/chat-spaces?instanceUid=${INSTANCE_UID}`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  // 列表只查当前用户与实例：查询串里塞 userId 不能改变隔离谓词，响应只含该 scope 的分组。
  test("列表按认证用户与实例过滤，忽略请求里夹带的 userId", async () => {
    const { captured } = installDb({ selectRows: [[instanceRow()], [spaceRow()]] });
    stubEnvironment("org-1");

    const response = await request(`/chat-spaces?instanceUid=${INSTANCE_UID}&userId=user-2`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { spaces: Record<string, unknown>[] } };
    expect(body.data.spaces).toHaveLength(1);
    expect(Object.keys(body.data.spaces[0] ?? {}).sort()).toEqual(SPACE_VIEW_KEYS);
    expect(body.data.spaces[0]).toMatchObject({ instanceUid: INSTANCE_UID, sessionIds: [SESSION_ID] });

    const { sql, params } = render(statements(captured, "select")[1]?.where);
    expect(sql).toContain('"chat_space"."user_id" = ');
    expect(sql).toContain('"chat_space"."instance_uid" = ');
    expect(params).toEqual([INSTANCE_UID, "user-1"]);
  });

  // 创建分组的归属列取自认证上下文：请求体里夹带 userId 无效（不接受客户端指定属主）。
  test("创建分组以认证用户为属主，请求体夹带 userId 无效", async () => {
    const { captured } = installDb({ selectRows: [[instanceRow()], []], insertRows: [[spaceRow({ name: "生产" })]] });
    stubEnvironment("org-1");

    const response = await json("/chat-spaces", "POST", {
      instanceUid: INSTANCE_UID,
      name: " 生产 ",
      userId: "user-2",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { space: Record<string, unknown> } };
    expect(Object.keys(body.data.space).sort()).toEqual(SPACE_VIEW_KEYS);
    expect(body.data.space).toMatchObject({ name: "生产", instanceUid: INSTANCE_UID });
    expect(statements(captured, "insert")[0]?.values).toMatchObject({ userId: "user-1", name: "生产" });
  });

  // 同 scope 重名由唯一索引拒绝，映射为 409 name_conflict（前端据此提示重名而不是报错）。
  test("创建重名返回 409 name_conflict", async () => {
    installDb({ selectRows: [[instanceRow()], []], insertRows: [[]] });
    stubEnvironment("org-1");

    const response = await json("/chat-spaces", "POST", { instanceUid: INSTANCE_UID, name: "研发" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "name_conflict" } });
  });

  // 名称规则由领域层裁决：空白名返回 400 invalid_name，而不是协议层的 422。
  test("空白名称返回 400 invalid_name", async () => {
    installDb({ selectRows: [[instanceRow()]] });
    stubEnvironment("org-1");

    const response = await json("/chat-spaces", "POST", { instanceUid: INSTANCE_UID, name: "   " });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_name" } });
  });

  // 重命名以 `instanceUid` 为权威作用域：先过实例归属（含组织），再确认分组行落在该实例内，成功返回最新状态。
  test("重命名分组先按 instanceUid 授权再校验分组归属", async () => {
    const { captured } = installDb({
      selectRows: [[instanceRow()], [spaceRow()]],
      updateRows: [[spaceRow({ name: "归档" })]],
    });
    stubEnvironment("org-1");

    const response = await json(`/chat-spaces/${SPACE_ID}${instanceQuery()}`, "PATCH", { name: "归档" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { space: Record<string, unknown> } };
    expect(body.data.space).toMatchObject({ id: SPACE_ID, name: "归档" });
    // 第一条查询是实例归属，第二条按 (分组 id, 属主) 定位分组；两条都下发即两段校验都在链上
    expect(statements(captured, "select")).toHaveLength(2);
    expect(render(statements(captured, "select")[1]?.where).params).toEqual([SPACE_ID, "user-1"]);
  });

  // 分组挂在别的实例下时同样 404 且不写入：同属主跨实例去碰一个分组不因「两边都属于他」而放行。
  test("分组不属于给定实例时返回 404 且零写入", async () => {
    const { captured } = installDb({
      selectRows: [[instanceRow()], [spaceRow({ instanceUid: "inst_other" })]],
    });
    stubEnvironment("org-1");

    const response = await json(`/chat-spaces/${SPACE_ID}${instanceQuery()}`, "PATCH", { name: "归档" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found", message: "Chat space not found" } });
    expect(captured.filter((statement) => statement.kind !== "select")).toHaveLength(0);
  });

  // 分组不属于当前用户时连行都取不到：404 且不发生任何写入（跨用户零写）。
  test("重命名他人分组返回 404 且零写入", async () => {
    const { captured } = installDb({ selectRows: [[instanceRow()], []] });
    stubEnvironment("org-1");

    const response = await json(`/chat-spaces/${SPACE_ID}${instanceQuery()}`, "PATCH", { name: "归档" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found", message: "Chat space not found" } });
    expect(captured.filter((statement) => statement.kind !== "select")).toHaveLength(0);
  });

  // 移入成功时返回更新后的分组：会话出现在 sessionIds 中（原子摘除发生在同一事务内）。
  test("移入会话返回更新后的分组", async () => {
    installDb({
      selectRows: [[instanceRow()], [spaceRow({ sessionIds: [] })], [{ id: SPACE_ID }]],
      updateRows: [[], [spaceRow({ sessionIds: [SESSION_ID] })]],
    });
    stubEnvironment("org-1");

    const response = await json(`/chat-spaces/${SPACE_ID}/sessions/${SESSION_ID}${instanceQuery()}`, "PUT");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { space: Record<string, unknown> } };
    expect(body.data.space).toMatchObject({ id: SPACE_ID, sessionIds: [SESSION_ID] });
  });

  // 移入目标分组属于别人时返回 404，且不发起任何改分组内容的写（否则既能探测存在性又能改别人的数据）。
  test("移入他人分组返回 404 且无写语句", async () => {
    const { captured } = installDb({ selectRows: [[instanceRow()], []] });
    stubEnvironment("org-1");

    const response = await json(`/chat-spaces/${SPACE_ID}/sessions/${SESSION_ID}${instanceQuery()}`, "PUT");

    expect(response.status).toBe(404);
    expect(statements(captured, "update")).toHaveLength(0);
  });

  // 移出幂等：会话不在任何分组内时同样成功（`space: null`），摘除范围由服务端按 scope 决定，
  // 调用方不传分组 id——传了就得先反查归属，而那正是会被在途写入的滞后快照骗到的地方。
  test("移出会话按 scope 摘除且幂等", async () => {
    const { captured } = installDb({
      selectRows: [[instanceRow()], [{ id: SPACE_ID }], [instanceRow()], [{ id: SPACE_ID }]],
      updateRows: [[spaceRow({ sessionIds: [] })], []],
    });
    stubEnvironment("org-1");

    const first = await request(`/chat-spaces/sessions/${SESSION_ID}${instanceQuery()}`, { method: "DELETE" });
    const second = await request(`/chat-spaces/sessions/${SESSION_ID}${instanceQuery()}`, { method: "DELETE" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // 命中分组时回报摘除后的分组；本就不在任何分组时 `null`——两种都是成功。
    const firstBody = (await first.json()) as { data: { space: Record<string, unknown> | null } };
    const secondBody = (await second.json()) as { data: { space: Record<string, unknown> | null } };
    expect(firstBody.data.space).toMatchObject({ id: SPACE_ID, sessionIds: [] });
    expect(secondBody.data.space).toBeNull();

    // 单条 UPDATE，且谓词同时带 scope 与「数组含该会话」：不读改写，也不推进无关分组的 updated_at。
    const updates = statements(captured, "update");
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      const rendered = render(update.where);
      expect(rendered.sql).toContain("instance_uid");
      expect(rendered.sql).toContain("user_id");
      expect(rendered.sql).toContain("@>");
      // 会话 id 经参数化 JSON 数组传入（`@>` 的右操作数），不以字面量拼进 SQL。
      expect(rendered.params.some((param) => typeof param === "string" && param.includes(SESSION_ID))).toBe(true);
    }
  });

  // 摘除范围只由认证作用域决定：请求串里塞 userId / spaceId 不改变实际谓词。
  test("移出会话时请求串夹带的 scope 不生效", async () => {
    const { captured } = installDb({ selectRows: [[instanceRow()]], updateRows: [[]] });
    stubEnvironment("org-1");

    const response = await request(
      `/chat-spaces/sessions/${SESSION_ID}${instanceQuery()}&userId=user-2&spaceId=${SPACE_ID}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    const updateWhere = statements(captured, "update")[0]?.where;
    expect(updateWhere).toBeDefined();
    const rendered = render(updateWhere);
    expect(rendered.params).toContain("user-1");
    expect(rendered.params).not.toContain("user-2");
  });
});
