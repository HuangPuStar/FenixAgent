import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readJson, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";

import { createHookRoutes } from "../server/routes/hooks";
import { initializeWorkflowModuleConfig } from "../server/testing";

// 无守卫依赖：webhook 的「无认证」是协议语义而非待注入项，因此本工厂不接收 deps。
const route = createHookRoutes();

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

/** `getByHash` 的替身：`db.select().from().where().limit()` 按队列返回给定行。 */
function stubTriggerLookup(...results: unknown[][]) {
  let index = 0;
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(results[index++] ?? []),
        }),
      }),
    }),
  } as never);
}

/** 一行 trigger 记录；只有 `enabled` 与触发所需字段参与本文件的断言。 */
function triggerRow(enabled: boolean) {
  return {
    id: "trigger-1",
    publicHash: "hash-1",
    enabled,
    type: "webhook",
    organizationId: "org-1",
    workflowId: "workflow-1",
  };
}

describe("workflow webhook routes", () => {
  beforeEach(() => {
    initializeWorkflowModuleConfig();
  });

  afterEach(() => {
    resetAllStubs();
  });

  // trigger 不存在时返回 404，且响应体只有错误说明——不暴露内部标识。
  test("未知 publicHash 返回 404", async () => {
    stubTriggerLookup([]);

    const response = await request("/hooks/unknown-hash", { method: "POST" });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "trigger not found" });
  });

  // 已禁用的 trigger 与不存在的 trigger 返回同一个响应：否则穷举 hash 就能探测出哪些 trigger 存在。
  test("已禁用的 trigger 与未知 hash 返回相同的 404 响应", async () => {
    stubTriggerLookup([triggerRow(false)]);

    const response = await request("/hooks/hash-1", { method: "POST" });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "trigger not found" });
  });

  // 超过 1MB 的请求体在 HTTP 边缘被拒绝，不进入领域层（避免把超大 payload 带进 workflow 上下文）。
  // 这里显式声明 `content-length`：真实部署下该头由 HTTP 传输层按实际 body 长度写入，而内存构造的
  // `Request` 不带它（实测 body 推导值为 null），两者在边缘层等价。
  test("声明超过 1MB 的请求体返回 413", async () => {
    stubTriggerLookup([triggerRow(true)]);

    const response = await request("/hooks/hash-1", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) },
      body: "{}",
    });

    expect(response.status).toBe(413);
    expect(await readJson(response)).toEqual({ error: "payload too large" });
  });

  // 接受路径：立即回 200（触发是 fire-and-forget，不等 workflow 跑完）。
  test("命中已启用的 trigger 立即返回 200", async () => {
    // 后续的触发链（引擎 / workflow 定义查询）在此用例内不参与断言，多备几项空结果让它安静失败。
    stubTriggerLookup([triggerRow(true)], [], []);

    const response = await request("/hooks/hash-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "ping" }),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ received: true });
  });
});
