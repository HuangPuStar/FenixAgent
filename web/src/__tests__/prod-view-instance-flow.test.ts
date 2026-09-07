import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_VIEW_PAGE_PATH = resolve(import.meta.dir, "../pages/prod-view/ProdViewPage.tsx");

describe("ProdView 实例连接数据流", () => {
  test("将加载接口返回的持久实例传给 ChatArea", () => {
    const source = readFileSync(PROD_VIEW_PAGE_PATH, "utf8");

    expect(source).toContain("sessionId={viewConfig.instanceUid}");
  });

  test("加载或实例准备失败后通过原请求 refresh 恢复", () => {
    const source = readFileSync(PROD_VIEW_PAGE_PATH, "utf8");

    expect(source).toContain("refresh,");
    expect(source).toContain("onClick={refresh}");
    expect(source).not.toContain("window.location.reload()");
  });
});
