// 记忆开关的数据访问与组合判定：`agent_memory_config` 是 Agent 级开关的唯一存储，写错一列就会让
// 「关掉记忆的 Agent 仍在写记忆」或反之，因此读写两条分支都要钉住。
//
// 覆盖边界：本文件用最小 Drizzle 链式替身覆盖仓储的**读写分支**与两级判定的组合；`where(eq(...))`
// 的 SQL 语义（列名、参数绑定）由 Drizzle 与真实数据库负责，不在这里用替身复刻——替身里自己实现的
// 过滤只能证明替身本身，属假覆盖。

import { afterEach, describe, expect, test } from "bun:test";
import {
  type DbStub,
  initializeTestApplicationInfrastructure,
  resetAllStubs,
  stubDb,
} from "@fenix/platform-sdk/testing";
import {
  getByAgentConfigId,
  isAgentMemoryEnabled,
  setEnabled,
  shouldEnableAgentMemory,
} from "@fenix/resource-memory/server";
import { createMemoryModuleConfig } from "../server/testing";

/** 存储行形状：与 `agent_memory_config` 的读取投影一致（时间列只用于断言是否被刷新）。 */
interface MemoryRow {
  agentConfigId: string;
  enabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/** 校验通过的最小替身实现：只实现本包仓储用到的 select / insert / update 三段链。 */
function createDbStub(rows: MemoryRow[]) {
  const store = [...rows];
  const writes = { inserted: [] as MemoryRow[], updated: [] as MemoryRow[] };

  const db: DbStub = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => store,
        }),
      }),
    }),
    insert: () => ({
      values: (values: MemoryRow) => ({
        returning: async () => {
          const row = { ...values, createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date() };
          store.push(row);
          writes.inserted.push(values);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<MemoryRow>) => ({
        where: () => ({
          returning: async () => {
            const row = { ...store[0], ...patch } as MemoryRow;
            store[0] = row;
            writes.updated.push(patch as MemoryRow);
            return [row];
          },
        }),
      }),
    }),
  };

  return { db, writes, store };
}

/**
 * 以给定的记忆模块配置与 DB 替身装配测试基础设施。
 *
 * 顺序即生产装配顺序：先登记 DB 句柄替身，再初始化基础设施（基础设施持有的是**引用**，
 * 反转顺序会让 `getMemoryDatabase()` 读到空对象）。
 */
function installInfrastructure(hindsightMcpUrl: string | undefined, db: DbStub): void {
  resetAllStubs();
  stubDb(db);
  initializeTestApplicationInfrastructure({
    moduleConfigs: { memory: createMemoryModuleConfig({ hindsightMcpUrl }) },
  });
}

describe("agent_memory_config 仓储", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 存储里有一行时按 agentConfigId 读回该行。
  test("getByAgentConfigId 读回已存在的开关记录", async () => {
    const { db } = createDbStub([{ agentConfigId: "agent-1", enabled: true }]);
    installInfrastructure("http://hindsight.test", db);
    await expect(getByAgentConfigId("agent-1")).resolves.toMatchObject({ agentConfigId: "agent-1", enabled: true });
  });

  // 没有记录等价于「未启用」，必须返回 null 而不是抛错或返回空对象。
  test("getByAgentConfigId 无记录时返回 null", async () => {
    const { db } = createDbStub([]);
    installInfrastructure("http://hindsight.test", db);
    await expect(getByAgentConfigId("agent-1")).resolves.toBeNull();
  });

  // 首次开启走 insert，并原样写入 agentConfigId 与 enabled。
  test("setEnabled 无记录时插入新行", async () => {
    const { db, writes } = createDbStub([]);
    installInfrastructure("http://hindsight.test", db);

    const row = await setEnabled("agent-2", true);
    expect(row).toMatchObject({ agentConfigId: "agent-2", enabled: true });
    expect(writes.inserted).toEqual([{ agentConfigId: "agent-2", enabled: true }]);
  });

  // 已有记录走 update：改写 enabled 并刷新 updatedAt，不得再插一行（唯一性由主键保证）。
  test("setEnabled 已有记录时更新并刷新 updatedAt", async () => {
    const previousUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
    const { db, writes } = createDbStub([{ agentConfigId: "agent-1", enabled: true, updatedAt: previousUpdatedAt }]);
    installInfrastructure("http://hindsight.test", db);

    const row = await setEnabled("agent-1", false);
    expect(row.enabled).toBe(false);
    expect(writes.updated).toHaveLength(1);
    expect(writes.inserted).toHaveLength(0);
    expect(writes.updated[0].enabled).toBe(false);
    expect(writes.updated[0].updatedAt).not.toBe(previousUpdatedAt);
  });
});

describe("记忆开关的两级判定", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 系统级可用 + Agent 级开启 → 记忆生效。
  test("两级都满足时 shouldEnableAgentMemory 返回 true", async () => {
    const { db } = createDbStub([{ agentConfigId: "agent-1", enabled: true }]);
    installInfrastructure("http://hindsight.test", db);
    await expect(isAgentMemoryEnabled("agent-1")).resolves.toBe(true);
    await expect(shouldEnableAgentMemory("agent-1")).resolves.toBe(true);
  });

  // 系统级不可用时即使 Agent 开关为开，也不得启用记忆（否则会指向不存在的服务）。
  test("系统级未配置时 shouldEnableAgentMemory 返回 false", async () => {
    const { db } = createDbStub([{ agentConfigId: "agent-1", enabled: true }]);
    installInfrastructure(undefined, db);
    await expect(shouldEnableAgentMemory("agent-1")).resolves.toBe(false);
  });

  // 未开开关的 Agent 不因系统级可用而被启用。
  test("Agent 级未开启时 shouldEnableAgentMemory 返回 false", async () => {
    const { db } = createDbStub([]);
    installInfrastructure("http://hindsight.test", db);
    await expect(isAgentMemoryEnabled("agent-1")).resolves.toBe(false);
    await expect(shouldEnableAgentMemory("agent-1")).resolves.toBe(false);
  });
});
