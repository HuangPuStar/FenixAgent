import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";

import { createWorkflowStaticApp } from "../server/routes/web/workflow-proxy";
import { initializeWorkflowModuleConfig } from "../server/testing";
import { createStubSessionAuthGuard } from "./guard-stubs";

const ACPX_G_URL = "http://upstream.test:8848";

const guard = createStubSessionAuthGuard();

const route = createWorkflowStaticApp({ authGuardPlugin: guard });

/** 上游 fetch 替身：记录被转发的完整 URL，并返回可识别的响应体。 */
function installUpstreamStub() {
  const forwarded: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    forwarded.push(String(input));
    return new Response("UPSTREAM_OK", { status: 200 });
  }) as typeof fetch;
  return {
    forwarded,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function request(path: string) {
  return route.handle(new Request(`http://localhost${path}`));
}

let upstream: ReturnType<typeof installUpstreamStub>;

describe("Workflow UI 静态代理的转发目标约束", () => {
  beforeEach(() => {
    initializeWorkflowModuleConfig({ acpxGUrl: ACPX_G_URL });
    guard.setActor({ organizationId: "org-proxy", userId: "user-proxy" });
    upstream = installUpstreamStub();
  });

  afterEach(() => {
    upstream.restore();
    guard.setActor(null);
    resetAllStubs();
  });

  // 挂载根路径转发到上游根路径：转发目标是 acpx-g 的 `/`，不是 `/workflow-ui`。
  test("根路径请求转发到上游根路径", async () => {
    const res = await request("/workflow-ui/");
    expect(res.status).toBe(200);
    expect(upstream.forwarded).toEqual([`${ACPX_G_URL}/`]);
  });

  // 普通静态资源仍是单段透传：合法请求不能被路径校验误伤，且编码字符按段重新编码后原样送达。
  test("合法单段资源按原路径转发", async () => {
    const res = await request("/workflow-ui/app%20bundle.js");
    expect(res.status).toBe(200);
    expect(upstream.forwarded).toEqual([`${ACPX_G_URL}/app%20bundle.js`]);
  });

  // 段内 `%2F` 会把 `..` 送进转发路径，`fetch` 解析 URL 时归一化点段即逃出 `/workflow-ui` 前缀
  // （实测 Elysia 1.4.30 下 `params.path` 就是 `../../admin`），因此必须在转发前拒绝、且不产生上游请求。
  test("编码斜杠夹带的点段路径被拒绝且不触达上游", async () => {
    const res = await request("/workflow-ui/..%2F..%2Fadmin");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { type: "invalid_path", message: expect.stringContaining("/workflow-ui") },
    });
    expect(upstream.forwarded).toEqual([]);
  });

  // 百分号编码的点段（`%2e%2e`）与裸 `..` 在解码后语义相同，大小写与编码形态都不能成为绕过口。
  test("各种编码形态的点段一律被拒绝", async () => {
    for (const path of [
      "/workflow-ui/%2e%2e%2fadmin",
      "/workflow-ui/..%2fadmin",
      "/workflow-ui/%2E%2E%2Fadmin",
      "/workflow-ui/..%2F..%2F..%2Fadmin",
    ]) {
      const res = await request(path);
      expect(res.status, `path should be rejected: ${path}`).toBe(400);
    }
    expect(upstream.forwarded).toEqual([]);
  });

  // 未认证请求在守卫处就被拒，转发逻辑不得执行（代理不成为匿名内网读取入口）。
  test("未认证请求被守卫拦下且不触达上游", async () => {
    guard.setActor(null);
    const res = await request("/workflow-ui/..%2F..%2Fadmin");
    expect(res.status).toBe(401);
    expect(upstream.forwarded).toEqual([]);
  });
});
