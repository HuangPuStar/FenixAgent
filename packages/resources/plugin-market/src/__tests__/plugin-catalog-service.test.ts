import { describe, expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { createMemoryCatalog, digestOf, snapshotJsonOf, TEST_PACKAGE_NAME } from "./catalog-harness";

/**
 * 目录规则的契约测试（对应源项目 `open-mcp-market` 的 `tests/catalog/service.test.ts`）。
 *
 * 这些用例锁定的是**没有第二层实现可以复述**的规则：严格幂等、从不可变快照恢复、latest 的移动与回退、
 * 以及「可见的包必有 latest」。它们全部经 `./catalog-harness` 的内存底座驱动**生产**的规则函数与事务时序，
 * 本文件不读写任何全局状态、不连接数据库（测试进程里也没有 Postgres）。
 *
 * 每条 `test` 上方的中文注释说明该用例锁定的业务契约；`describe` 只做分组。
 */

/** 断言调用以某个错误码失败，并返回该错误以便进一步断言细节。 */
const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
};

describe("publish", () => {
  // 首次发布必须同时建聚合根与首个版本行，并让 latest 指向它——否则包存在但公开面永远看不到它。
  test("creates the package and makes the first version latest", async () => {
    const catalog = createMemoryCatalog();
    const change = await catalog.publish("1.0.0");

    expect(change.action).toBe("publish");
    expect(change.packageName).toBe(TEST_PACKAGE_NAME);
    expect(change.previousLatestPublicationId).toBeNull();
    expect(change.latestPublicationId).toBe(change.publicationId);

    expect(catalog.state()?.package.latestPublicationId).toBe(change.publicationId);
    expect(catalog.visibleVersions().map((entry) => entry.exactVersion)).toEqual(["1.0.0"]);
  });

  // 发布更新的版本必须把 latest 移过去：否则「首页显示最新版」这条承诺失效，且不变量 I3 立刻被破坏。
  test("moves latest to a newly published version", async () => {
    const catalog = createMemoryCatalog();
    const first = await catalog.publish("1.0.0");
    const second = await catalog.publish("1.1.0");

    expect(second.action).toBe("publish");
    expect(second.previousLatestPublicationId).toBe(first.publicationId);
    expect(second.latestPublicationId).toBe(second.publicationId);
    expect(catalog.visibleVersions().map((entry) => entry.exactVersion)).toEqual(["1.1.0", "1.0.0"]);
  });

  // 重复发布一个已可见版本必须严格空转：写清单为空（零 SQL），且**不得**把 latest 拨回旧版本。
  test("is strictly idempotent for an already visible version", async () => {
    const catalog = createMemoryCatalog();
    const first = await catalog.publish("1.0.0");
    await catalog.publish("1.1.0");
    const again = await catalog.publish("1.0.0");

    expect(again.action).toBe("noop");
    expect(again.publicationId).toBe(first.publicationId);
    expect(again.previousLatestPublicationId).toBe(again.latestPublicationId);
    expect(again.affectedVersions).toEqual([]);
    expect(catalog.lastWrites()).toEqual([]);
    expect(catalog.state()?.package.latestPublicationId).toBe(again.latestPublicationId);

    // 空转还必须已经反映在可见版本集合上：latest 仍是 1.1.0，且版本总数没变。
    expect(catalog.visibleVersions().map((entry) => entry.exactVersion)).toEqual(["1.1.0", "1.0.0"]);
  });

  // 快照发布后不可变：带着不同内容重复发布同一版本，存储里的快照与时刻都必须一字不动（幂等分支不产生写清单）。
  test("does not rewrite the stored snapshot on a repeated publish", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    const before = catalog.publicationOf("1.0.0");

    await catalog.publish("1.0.0", {
      metadataJson: snapshotJsonOf("1.0.0", "改写后的名字"),
      metadataDigest: digestOf("1.0.0-rewritten"),
    });

    const after = catalog.publicationOf("1.0.0");
    expect(after?.metadataJson).toBe(before?.metadataJson);
    expect(after?.metadataDigest).toBe(before?.metadataDigest);
    expect(after?.publishedAt.getTime()).toBe(before?.publishedAt.getTime());
  });

  // 审计流水必须与真实变更一一对应：重复发布不得留下第二条记录，否则「市场被改过几次」无法从流水回答。
  test("records one operation per real change and none for a no-op", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    await catalog.publish("1.0.0");

    expect(catalog.auditActions()).toEqual(["publish"]);
  });

  // 同一版本的并发确认必须收敛成一条记录：一个调用者写入，其余读到「已可见」并报空转，且都拿到同一个版本 ID。
  test("collapses concurrent publishes of one version into a single record", async () => {
    const catalog = createMemoryCatalog();
    const results = await Promise.all(Array.from({ length: 8 }, () => catalog.publish("1.0.0")));

    expect(new Set(results.map((change) => change.publicationId)).size).toBe(1);
    expect(results.filter((change) => change.action === "publish")).toHaveLength(1);
    expect(results.filter((change) => change.action === "noop")).toHaveLength(7);
    expect(catalog.state()?.publications).toHaveLength(1);
    expect(catalog.auditActions()).toEqual(["publish"]);
    expect(catalog.state()?.package.latestPublicationId).toBe(results[0]?.publicationId);
  });
});

describe("unpublish", () => {
  // 下架非 latest 版本只置水印，latest 必须原地不动——否则每次下架旧版本都会把首页内容换掉。
  test("hides a non-latest version without moving latest", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    const second = await catalog.publish("1.1.0");
    const change = await catalog.unpublish("1.0.0");

    expect(change.action).toBe("unpublish");
    expect(change.latestPublicationId).toBe(second.publicationId);
    expect(catalog.visibleVersions().map((entry) => entry.exactVersion)).toEqual(["1.1.0"]);
  });

  // 下架 latest 必须回退到「剩余可见版本中最新的那个」，而不是置空：置空会让整包从公开面消失。
  test("falls back to the newest remaining visible version", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    const second = await catalog.publish("1.1.0");
    const change = await catalog.unpublish("1.1.0");

    expect(change.previousLatestPublicationId).toBe(second.publicationId);
    expect(change.latestPublicationId).not.toBe(second.publicationId);
    expect(catalog.visibleVersions().map((entry) => entry.exactVersion)).toEqual(["1.0.0"]);
  });

  // 最后一个可见版本被下架后整个包隐藏：latest 置空、可见集合为空（公开面按「不存在」处理）。
  test("hides the whole package when the last visible version is withdrawn", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    const change = await catalog.unpublish("1.0.0");

    expect(change.latestPublicationId).toBeNull();
    expect(catalog.state()?.package.latestPublicationId).toBeNull();
    expect(catalog.visibleVersions()).toEqual([]);
  });

  // 重复下架必须空转：零写入、零审计（版本行已经是隐藏态，再置一次水印会把下架时刻改掉）。
  test("is idempotent for an already hidden version", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    await catalog.unpublish("1.0.0");
    const again = await catalog.unpublish("1.0.0");

    expect(again.action).toBe("noop");
    expect(catalog.lastWrites()).toEqual([]);
    expect(catalog.auditActions()).toEqual(["publish", "unpublish"]);
  });

  // 下架一个不存在的版本是 404 而不是静默成功：静默成功会让管理台显示「已下架」而库里什么都没变。
  test("reports an unknown version as not found", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    expect(await codeOf(catalog.unpublish("9.9.9"))).toBe("PUBLICATION_NOT_FOUND");
  });

  // 下架一个从未发布过的包也是 404：包不存在与版本不存在对调用方是同一件事（都没得下架）。
  test("reports an unknown package as not found", async () => {
    const catalog = createMemoryCatalog();
    expect(await codeOf(catalog.unpublish("1.0.0"))).toBe("PUBLICATION_NOT_FOUND");
  });
});

describe("restore", () => {
  // 恢复必须复用首次快照与首次发布时刻；只有可见性水印与逻辑时刻前进（快照不可变是恢复路径的前提）。
  test("reuses the original snapshot and first publication time", async () => {
    const catalog = createMemoryCatalog();
    const first = await catalog.publish("1.0.0");
    const before = catalog.publicationOf("1.0.0");
    expect(before).not.toBeNull();

    await catalog.unpublish("1.0.0");
    const restored = await catalog.publish("1.0.0");

    expect(restored.action).toBe("restore");
    expect(restored.publicationId).toBe(first.publicationId);
    expect(restored.latestPublicationId).toBe(first.publicationId);

    const after = catalog.publicationOf("1.0.0");
    expect(after?.metadataJson).toBe(before?.metadataJson);
    expect(after?.firstPublishedAt.getTime()).toBe(before?.firstPublishedAt.getTime());
    expect(after?.unpublishedAt).toBeNull();
    // 恢复算一次新的发布：时刻必须**真的前进**，不能只保持「不更旧」。
    expect(after?.publishedAt.getTime()).toBeGreaterThan(before?.publishedAt.getTime() ?? 0);
  });

  // 恢复必须越过当前最新版本的时刻：否则排序上它仍是旧版本，界面显示的 latest 与实际指针不一致。
  test("moves the restored version ahead of the newest recorded instant", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    await catalog.publish("1.1.0");
    const displacedBefore = catalog.publicationOf("1.1.0");
    await catalog.unpublish("1.0.0");
    await catalog.publish("1.0.0");

    const restored = catalog.publicationOf("1.0.0");
    expect(restored?.publishedAt.getTime()).toBeGreaterThan(displacedBefore?.publishedAt.getTime() ?? 0);
    expect(catalog.visibleVersions()[0]?.exactVersion).toBe("1.0.0");
  });

  // 恢复后该版本重新成为 latest：这是「下架后还能撤销」这条承诺在公开面的最终表现。
  test("makes the restored version latest again", async () => {
    const catalog = createMemoryCatalog();
    await catalog.publish("1.0.0");
    await catalog.publish("1.1.0");
    await catalog.unpublish("1.0.0");
    await catalog.publish("1.0.0");

    expect(catalog.state()?.package.latestPublicationId).toBe(catalog.publicationOf("1.0.0")?.id ?? null);
    expect(catalog.visibleVersions().map((entry) => entry.exactVersion)).toEqual(["1.0.0", "1.1.0"]);
  });

  // 恢复读的是库内快照而不是回源：即使 registry 已经不可用，已下架的版本也必须能被重新发布出来。
  test("restores from storage instead of re-reading the registry", async () => {
    const catalog = createMemoryCatalog();
    const first = await catalog.publish("1.0.0");
    const stored = catalog.publicationOf("1.0.0")?.metadataJson;
    await catalog.unpublish("1.0.0");

    // 传入一份内容完全不同的元数据，模拟「调用方以为要重新发布」：恢复路径必须忽略它。
    await catalog.publish("1.0.0", {
      metadataJson: snapshotJsonOf("1.0.0", "不该被写入的名字"),
      metadataDigest: digestOf("should-not-be-stored"),
    });

    expect(catalog.publicationOf("1.0.0")?.metadataJson).toBe(stored);
    expect(catalog.publicationOf("1.0.0")?.id).toBe(first.publicationId);
  });
});
