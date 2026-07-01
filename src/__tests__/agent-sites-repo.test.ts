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

  test("create 默认 appType 为 pocketbase", async () => {
    // 通过 captured 捕获 insert.values() 收到的数据，验证默认值兜底
    const captured: Record<string, unknown> = {};
    stubDb({
      insert: () => ({
        values: (data: Record<string, unknown>) => {
          Object.assign(captured, data);
          return { returning: () => Promise.resolve([{ ...data, id: "new-id" }]) };
        },
      }),
    });

    await repo.create({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-test1",
      name: "test",
      platformToken: "tok",
      platformTokenId: "tok-1",
    });
    expect(captured.appType).toBe("pocketbase");
  });

  test("create 显式传 appType=custom", async () => {
    const captured: Record<string, unknown> = {};
    stubDb({
      insert: () => ({
        values: (data: Record<string, unknown>) => {
          Object.assign(captured, data);
          return { returning: () => Promise.resolve([{ ...data, id: "new-id" }]) };
        },
      }),
    });

    await repo.create({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-test2",
      name: "test",
      platformToken: "tok",
      platformTokenId: "tok-1",
      appType: "custom",
    });
    expect(captured.appType).toBe("custom");
  });

  test("update 支持部署字段", async () => {
    // 捕获 update.set() 收到的数据，验证 entryFile/activeSlot/deployedAt 透传
    const captured: Record<string, unknown> = {};
    stubDb({
      update: () => ({
        set: (data: Record<string, unknown>) => {
          Object.assign(captured, data);
          return {
            where: () => ({ returning: () => Promise.resolve([{ id: "x", ...data }]) }),
          };
        },
      }),
    });

    await repo.update("x", {
      entryFile: "main.ts",
      activeSlot: "a",
      deployedAt: new Date("2026-07-01"),
    });
    expect(captured.entryFile).toBe("main.ts");
    expect(captured.activeSlot).toBe("a");
    expect(captured.deployedAt).toEqual(new Date("2026-07-01"));
  });
});
