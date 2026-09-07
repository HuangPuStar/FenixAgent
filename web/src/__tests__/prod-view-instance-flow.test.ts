import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROD_VIEW_PAGE_PATH = resolve(import.meta.dir, "../pages/prod-view/ProdViewPage.tsx");

describe("ProdView 实例连接数据流", () => {
  test("将加载接口返回的持久实例传给 ChatArea", () => {
    const source = readFileSync(PROD_VIEW_PAGE_PATH, "utf8");

    expect(source).toContain("sessionId={viewConfig.instanceUid}");
  });

  test("路由切换重新加载并拒绝旧请求覆盖新结果", () => {
    const source = readFileSync(PROD_VIEW_PAGE_PATH, "utf8");

    expect(source).toContain("refreshDeps: [prodViewId]");
    expect(source).toContain("generation !== requestGeneration.current");
  });

  test("路由切换以完整 relay identity 卸载旧 ChatArea，同时保留同视图 identity", () => {
    const source = readFileSync(PROD_VIEW_PAGE_PATH, "utf8");

    expect(source).toContain("key={`${prodViewId}:${viewConfig.environmentId}:${viewConfig.instanceUid}`}");
    expect(source).toContain("generation !== requestGeneration.current");
  });

  test("GET load 只解析实例身份，不提前启动 runtime", () => {
    const servicePath = resolve(import.meta.dir, "../../../src/services/prod-view.ts");
    const source = readFileSync(servicePath, "utf8");

    expect(source).toContain("findOrCreateDefaultInstance");
    expect(source).not.toContain("ensureInstanceRuntime");
  });

  test("加载或实例准备失败后通过原请求 refresh 恢复", () => {
    const source = readFileSync(PROD_VIEW_PAGE_PATH, "utf8");

    expect(source).toContain("refresh,");
    expect(source).toContain("onClick={refresh}");
    expect(source).not.toContain("window.location.reload()");
  });
});
