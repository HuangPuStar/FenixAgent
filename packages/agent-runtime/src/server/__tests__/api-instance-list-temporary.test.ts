import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { ApiInstanceListQuerySchema } from "../../schemas/api-instance.schema";
import { agentInstanceRepo } from "../repositories/agent-instance";
import { bindAgentConfigLookupPort, resetAgentConfigLookupPort } from "../services/agent-config-lookup-port";
import { listApiInstances } from "../services/api-instance";
import { initializeAgentRuntimeModuleConfig } from "../testing";

afterEach(() => {
  resetAgentConfigLookupPort();
  resetAllStubs();
});
function fixture() {
  initializeAgentRuntimeModuleConfig();
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE environment (id TEXT PRIMARY KEY, organization_id TEXT, user_id TEXT, agent_config_id TEXT);
    CREATE TABLE agent_instance (id TEXT PRIMARY KEY, environment_id TEXT, owner_user_id TEXT, creation_source TEXT, name TEXT, is_default INTEGER, created_by_user_id TEXT, created_at TEXT, updated_at TEXT);`);
  for (const [index, environmentId] of ["env-normal-a", "temp-live", "temp-expired", "env-normal-b"].entries()) {
    database.run("INSERT INTO environment VALUES (?, 'org', 'user', 'agent')", [environmentId]);
    database.run("INSERT INTO agent_instance VALUES (?, ?, 'user', 'api', 'api', 0, 'user', ?, ?)", [
      `instance-${index}`,
      environmentId,
      "2026-11-11T00:00:00.000Z",
      "2026-11-11T00:00:00.000Z",
    ]);
  }
  for (const prefix of ["env", "temp"]) {
    for (const [scope, organizationId, environmentUserId, agentId, ownerUserId, source] of [
      ["other-org", "other-org", "user", "agent", "user", "api"],
      ["other-environment-user", "org", "other-user", "agent", "user", "api"],
      ["other-instance-owner", "org", "user", "agent", "other-user", "api"],
      ["other-agent", "org", "user", "other-agent", "user", "api"],
      ["workflow", "org", "user", "agent", "user", "workflow"],
    ] as const) {
      const id = `${prefix}-${scope}`;
      database.run("INSERT INTO environment VALUES (?, ?, ?, ?)", [id, organizationId, environmentUserId, agentId]);
      database.run("INSERT INTO agent_instance VALUES (?, ?, ?, ?, 'api', 0, ?, ?, ?)", [
        `foreign-${id}`,
        id,
        ownerUserId,
        source,
        ownerUserId,
        "2026-11-11T00:00:00.000Z",
        "2026-11-11T00:00:00.000Z",
      ]);
    }
  }
  // 仅替换数据库连接；SQL 构建、过滤、分页、count 和结果映射都使用生产实现。
  const client = {
    query: async (query: { text: string; rowMode?: string }, params: Array<string | number | null>) => ({
      rows:
        query.rowMode === "array"
          ? database.query(query.text).values(...params)
          : database.query(query.text).all(...params),
    }),
  };
  stubDb(drizzle({ client: client as unknown as Pool }));
  resetAgentConfigLookupPort();
  bindAgentConfigLookupPort({
    findVisibleAgentConfig: async () => ({
      id: "agent",
      name: "Agent",
      organizationId: "org",
      description: null,
      node: null,
    }),
    findAgentConfig: async () => null,
    findAgentConfigExecutionFields: async () => null,
    findAgentConfigNamesByIds: async () => new Map(),
  });
  return database;
}

// 三种筛选及默认值都在数据库分页与计数前生效，不能突破组织、环境属主和实例属主边界。
test.each([
  [undefined, ["env-normal-a", "env-normal-b"]],
  ["regular", ["env-normal-a", "env-normal-b"]],
  ["temporary", ["temp-live", "temp-expired"]],
  ["all", ["env-normal-a", "temp-live", "temp-expired", "env-normal-b"]],
] as const)("API instance pages and total respect environmentType=%s", async (environmentType, expected) => {
  const database = fixture();
  try {
    const pages = await Promise.all(
      Array.from({ length: expected.length + 1 }, (_, index) =>
        listApiInstances({ organizationId: "org", userId: "user" }, "agent", {
          page: index + 1,
          pageSize: 1,
          environmentType,
        }),
      ),
    );
    expect(pages.every((page) => page.total === expected.length)).toBe(true);
    expect(pages.flatMap((page) => page.items.map((item) => item.environmentId))).toEqual(expected);
    expect(pages.at(-1)?.items).toEqual([]);
    expect(Object.keys(pages[0] ?? {}).sort()).toEqual(["items", "page", "pageSize", "total"]);
    expect((await agentInstanceRepo.getById("instance-2"))?.environmentId).toBe("temp-expired");
  } finally {
    database.close();
  }
});

// 不传筛选参数时保持普通实例契约，显式筛选可与分页参数一起通过协议校验。
test("instance list query defaults to regular and accepts explicit temporary or all filters", () => {
  expect(ApiInstanceListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20, environmentType: "regular" });
  for (const environmentType of ["regular", "temporary", "all"]) {
    expect(ApiInstanceListQuerySchema.parse({ page: "2", pageSize: "5", environmentType })).toEqual({
      page: 2,
      pageSize: 5,
      environmentType,
    });
  }
});

// 非法筛选不能静默扩大到全部实例。
test.each(["unknown", "TEMPORARY", "", true])("instance list query rejects invalid environmentType=%s", (value) => {
  expect(ApiInstanceListQuerySchema.safeParse({ environmentType: value }).success).toBe(false);
});
