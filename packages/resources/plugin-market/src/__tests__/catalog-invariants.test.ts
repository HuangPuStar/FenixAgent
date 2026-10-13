import { describe, expect, test } from "bun:test";
import { findInvariantViolations } from "../server/domain/invariants";
import type { CatalogState } from "../server/domain/types";
import { createMemoryCatalog, type MemoryCatalog } from "./catalog-harness";

/**
 * latest 不变量的审计契约（对应源项目 `open-mcp-market` 的 `describe("invariants")`）。
 *
 * 三条不变量本身由写入路径的顺序保证（见 `../server/domain/catalog.ts` 与 `db/schema.ts` 的承载说明），
 * 但**保证**与**可发现**是两件事：破坏不变量不会引发任何报错，只会让首页显示一个不是最新的版本。因此这里
 * 逐条断言审计能报出来——包括那条最容易被漏掉的「指针合法但陈旧」。
 *
 * 用例全部经内存底座驱动生产规则；本文件不读写任何全局状态、不连接数据库。
 */

/** 取非空状态：不变量审计的输入是「已存在的聚合根」，空状态不是它的输入域。 */
const stateOf = (catalog: MemoryCatalog): CatalogState => {
  const state = catalog.state();
  if (!state) throw new Error("用例应已先发布至少一个版本");
  return state;
};

describe("invariants", () => {
  // 一串任意操作之后必须仍然一致：这是「规则彼此相容」的总体检查，比任何单条用例都更能反映写入路径。
  test("stays consistent across an arbitrary operation sequence", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    await catalog.publish("1.1.0");
    await catalog.publish("2.0.0");
    await catalog.unpublish("2.0.0");
    await catalog.unpublish("1.1.0");
    await catalog.publish("1.1.0");
    await catalog.unpublish("2.0.0");
    await catalog.unpublish("1.0.0");
    await catalog.unpublish("1.1.0");
    await catalog.publish("1.0.0");

    expect(findInvariantViolations(stateOf(catalog))).toEqual([]);
  });

  // 全部版本下架后包必须保持隐藏（latest 为 NULL）且不变量仍成立：这正是「包级隐藏」的表达方式。
  test("keeps the package hidden after every version is withdrawn", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    await catalog.publish("1.1.0");
    await catalog.unpublish("1.0.0");
    await catalog.unpublish("1.1.0");

    expect(catalog.state()?.package.latestPublicationId).toBeNull();
    expect(findInvariantViolations(stateOf(catalog))).toEqual([]);
  });

  // 审计必须能看见**合法但陈旧**的指针：它仍指向本包一个可见版本，前两条规则都会放行，只有第三条能报出来。
  test("reports a latest that is no longer the newest visible publication", async () => {
    const catalog = createMemoryCatalog();
    const first = await catalog.publish("1.0.0");
    catalog.seedPublication({ id: "pub-newer", version: "1.1.0", publishedAt: new Date("2030-01-01T00:00:00.000Z") });

    expect(findInvariantViolations(stateOf(catalog))).toEqual([
      `package ${first.packageId} latest ${first.publicationId} is not the newest visible publication`,
    ]);
  });

  // 指针悬空（版本行已不存在）必须被第二条规则报出：这种状态下公开面会 500 或显示空白，而不是 404。
  test("reports a latest that does not exist", async () => {
    const catalog = createMemoryCatalog();
    const first = await catalog.publish("1.0.0");
    catalog.seed((draft) => {
      draft.package.latestPublicationId = "pub-missing";
    });

    expect(findInvariantViolations(stateOf(catalog))).toEqual([
      `package ${first.packageId} latest is not a visible publication of the same package`,
    ]);
  });

  // 指针指向一个已下架版本同样属于「不是可见版本」：这正是「先移指针再置水印」要避免的中间态。
  test("reports a latest that points at a hidden publication", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    await catalog.publish("1.1.0");
    catalog.seed((draft) => {
      const hidden = draft.publications.find((publication) => publication.exactVersion === "1.0.0");
      if (hidden) hidden.unpublishedAt = new Date("2026-02-01T00:00:00.000Z");
      draft.package.latestPublicationId = hidden?.id ?? null;
    });

    const state = stateOf(catalog);
    expect(findInvariantViolations(state)).toHaveLength(1);
    expect(findInvariantViolations(state)[0]).toContain("is not a visible publication of the same package");
  });

  // 有可见版本却没有 latest 必须被第一条规则报出：此时包还在库里，却永远不会出现在任何列表里。
  test("reports visible publications without a latest", async () => {
    const catalog = createMemoryCatalog();
    const first = await catalog.publish("1.0.0");
    catalog.seed((draft) => {
      draft.package.latestPublicationId = null;
    });

    expect(findInvariantViolations(stateOf(catalog))).toEqual([
      `package ${first.packageId} has visible publications but no latest`,
    ]);
  });

  /**
   * 定长序列扫描：每条生成序列都跑一遍服务，**每一步之后**都审计一次（而不是只在结尾审计）——否则一个
   * 被后续步骤顺手修好的违规会永远看不见。序列由固定种子生成，失败必然可复现，不依赖时钟或运气。
   */
  const SEQUENCE_VERSIONS = ["1.0.0", "1.1.0", "2.0.0"];
  type SequenceStep = { kind: "publish" | "unpublish"; version: string };

  /** 骨架保证每条序列都覆盖三类真实转换（含一次恢复、一次 latest 撤下），尾段才是随机部分。 */
  const SEQUENCE_BACKBONE: SequenceStep[] = [
    { kind: "publish", version: "1.0.0" },
    { kind: "publish", version: "1.1.0" },
    { kind: "unpublish", version: "1.0.0" },
    { kind: "publish", version: "1.0.0" },
    { kind: "unpublish", version: "1.0.0" },
    { kind: "publish", version: "2.0.0" },
  ];

  const publicationSequences = (): Array<[number, SequenceStep[]]> =>
    Array.from({ length: 12 }, (_, index) => {
      let state = index + 1;
      const next = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const tail: SequenceStep[] = Array.from({ length: 4 }, () => ({
        kind: next() < 0.5 ? "publish" : "unpublish",
        version: SEQUENCE_VERSIONS[Math.floor(next() * SEQUENCE_VERSIONS.length)] ?? "1.0.0",
      }));
      return [index + 1, [...SEQUENCE_BACKBONE, ...tail]];
    });

  test.each(
    publicationSequences(),
  )("holds the three latest invariants after every step of sequence %i", async (seed, steps) => {
    const catalog = createMemoryCatalog();
    const actions: string[] = [];

    for (const [index, step] of steps.entries()) {
      const label = `sequence ${seed}, step ${index + 1}: ${step.kind} ${step.version}`;
      const change =
        step.kind === "publish" ? await catalog.publish(step.version) : await catalog.unpublish(step.version);
      actions.push(change.action);

      expect({ label, violations: findInvariantViolations(stateOf(catalog)) }).toEqual({ label, violations: [] });

      // latest 还必须与存储顺序本身一致：公开的 latest 就是可见集合的首位，版本历史是同一集合的同一顺序。
      const visible = catalog.visibleVersions();
      expect({
        label,
        latest: catalog.state()?.package.latestPublicationId ?? null,
        versions: visible.map((entry) => entry.exactVersion),
      }).toEqual({
        label,
        latest: visible[0]?.id ?? null,
        versions: visible.map((entry) => entry.exactVersion),
      });
    }

    // 每条序列都真的走过三类真实转换，扫描因此不可能因为「全是不存在的版本」而空跑。
    const kinds = new Set(actions);
    const hasAllKinds = ["publish", "restore", "unpublish"].every((kind) => kinds.has(kind));
    expect({ seed, hasAllKinds }).toEqual({ seed, hasAllKinds: true });
  });
});
