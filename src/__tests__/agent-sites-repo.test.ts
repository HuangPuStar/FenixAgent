import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

describe("agentSiteAppRepo", () => {
  // repo 方法导入需要懒加载：stubDb 返回的 db 对象在 lazy import 之前设置
  let repo: typeof import("../repositories/agent-site-app").agentSiteAppRepo;

  beforeEach(async () => {
    resetAllStubs();
    const mod = await import("../repositories/agent-site-app");
    repo = mod.agentSiteAppRepo;
  });

  test("create 写入 DB 后返回 row，默认 visibility 为 private", async () => {
    const recordId = "test-uuid";
    const insertResult = {
      id: recordId,
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-abc12345",
      name: "test-app",
      description: null,
      platformToken: "tok-xxx.yyy",
      platformTokenId: "tok-001",
      visibility: "private",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    stubDb({
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([insertResult]),
        }),
      }),
    });

    const row = await repo.create({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-abc12345",
      name: "test-app",
      platformToken: "tok-xxx.yyy",
      platformTokenId: "tok-001",
    });
    expect(row.id).toBe(recordId);
    expect(row.remoteAppId).toBe("app-abc12345");
    expect(row.visibility).toBe("private");
  });

  test("create 可指定 visibility", async () => {
    const insertResult = {
      id: "uuid-2",
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-public01",
      name: "public-app",
      description: null,
      platformToken: "tok-2",
      platformTokenId: "tok-002",
      visibility: "public",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    stubDb({
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([insertResult]),
        }),
      }),
    });

    const row = await repo.create({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-public01",
      name: "public-app",
      platformToken: "tok-2",
      platformTokenId: "tok-002",
      visibility: "public",
    });
    expect(row.visibility).toBe("public");
  });

  test("listByOrg 返回按 createdAt 排序的列表", async () => {
    const rows = [
      {
        id: "a",
        organizationId: "org-1",
        userId: "u1",
        remoteAppId: "app-aaa",
        name: "A",
        description: null,
        platformToken: "t1",
        platformTokenId: "tid1",
        visibility: "private",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
      {
        id: "b",
        organizationId: "org-1",
        userId: "u1",
        remoteAppId: "app-bbb",
        name: "B",
        description: null,
        platformToken: "t2",
        platformTokenId: "tid2",
        visibility: "org",
        createdAt: new Date("2026-01-02"),
        updatedAt: new Date("2026-01-02"),
      },
    ];

    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(rows),
          }),
        }),
      }),
    });

    const result = await repo.listByOrg("org-1");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("A");
    expect(result[1].name).toBe("B");
  });

  test("getById 返回单条记录或 undefined", async () => {
    const row = {
      id: "test-id",
      organizationId: "org-1",
      userId: "u1",
      remoteAppId: "app-xxx",
      name: "X",
      description: null,
      platformToken: "t",
      platformTokenId: "tid",
      visibility: "private" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
    });

    const result = await repo.getById("test-id");
    expect(result).toBeDefined();
    expect(result?.name).toBe("X");
  });

  test("getById 无匹配返回 undefined", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([] as never[]),
          }),
        }),
      }),
    });

    const result = await repo.getById("nonexistent");
    expect(result).toBeUndefined();
  });

  test("delete 返回 boolean", async () => {
    stubDb({
      delete: () => ({
        where: () => Promise.resolve({ count: 1 }),
      }),
    });

    const result = await repo.delete("test-id");
    expect(result).toBe(true);
  });
});
