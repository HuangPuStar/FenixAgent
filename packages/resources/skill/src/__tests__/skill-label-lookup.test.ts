/**
 * Skill 展示标签投影（`findSkillLabelsByIds`）的取数契约。
 *
 * 本函数是任务 1.7 B5 之后 agent-config 侧「技能怎么显示」的唯一数据来源：宿主在装配期把它经
 * `@fenix/resource-skill/server/config` 交给关联资源视图。用例关注**取数形状**而非拼接格式——
 * 取的是 `name` 列、空入参不查库、缺失的 id 不造值。B3 的同类投影（`findModelLabelsByIds`）曾出现
 * 「判据无覆盖、删掉不报错」的情况，这条投影按同一标准钉住。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { findSkillLabelsByIds } from "../server/repositories/skill";

type SkillRow = { id: string; name: string };

/**
 * 记录一次 `select` 的 from / where 入参，并按顺序返回给定批次的行。
 *
 * 顺序必须是「复位 → 登记句柄替身 → 初始化基础设施」：基础设施持有的是**引用**，先初始化再换替身不会
 * 生效；而 `resetAllStubs()` 会连同基础设施一起复位（`resetApplicationInfrastructure`），因此每次
 * 重新登记都要重跑一次初始化。本包其余用例同形（见 `skill-dir-config.test.ts`）。
 */
function stubSkillRows(batches: SkillRow[][]): { conditions: unknown[] } {
  const conditions: unknown[] = [];
  let call = 0;
  resetAllStubs();
  stubDb({
    select: () => ({
      from: () => ({
        where: async (condition: unknown) => {
          conditions.push(condition);
          return batches[call++] ?? [];
        },
      }),
    }),
  });
  initializeTestApplicationInfrastructure();
  return { conditions };
}

describe("Skill 展示标签投影", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 标签就是技能名：调用方拿绑定表给出的 ID 集合换 `name`，命中集合的形状必须是 id → name。
  test("按 id 批量取到 name 标签", async () => {
    stubSkillRows([
      [
        { id: "skill-1", name: "检索" },
        { id: "skill-2", name: "写作" },
      ],
    ]);

    const labels = await findSkillLabelsByIds(["skill-1", "skill-2"]);

    expect(labels.size).toBe(2);
    expect(labels.get("skill-1")).toBe("检索");
    expect(labels.get("skill-2")).toBe("写作");
  });

  // 已被删除的技能 id 不得在 Map 里造值：调用方靠「取不到就退回 id」区分「查不到」与「名字就是 id」。
  test("查不到的 id 不产出标签", async () => {
    stubSkillRows([[{ id: "skill-1", name: "检索" }]]);

    const labels = await findSkillLabelsByIds(["skill-1", "skill-missing"]);

    expect(labels.size).toBe(1);
    expect(labels.has("skill-missing")).toBe(false);
  });

  // 空入参是常态（Agent 没绑定技能）：直接返回空 Map，不产生 DB 往返，也不发一条 `in ()` 的空谓词。
  test("入参为空时不查库", async () => {
    const { conditions } = stubSkillRows([]);

    const labels = await findSkillLabelsByIds([]);

    expect(labels.size).toBe(0);
    expect(conditions).toEqual([]);
  });
});
