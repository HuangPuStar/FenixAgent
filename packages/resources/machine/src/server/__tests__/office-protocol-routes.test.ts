import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createOfficeProtocolRoutes } from "../routes/protocols/office";
import { initializeMachineModuleConfig } from "../testing";

beforeEach(() => initializeMachineModuleConfig());
afterEach(resetAllStubs);

// 文档回源失败必须保留显式状态与禁止缓存，不能把 JSON 错误当二进制成功返回。
test("Office document failures retain HTTP semantics and no-store", async () => {
  const routes = createOfficeProtocolRoutes();
  const response = await routes.handle(new Request("http://localhost/office/documents/signed-reference"));
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ success: false, error: { code: "unavailable" } });
});

// 回调失败使用提供方错误信封，未知正文也要经过处理器而不是回显原始输入。
test("Office callback failures return provider error without cache or body echo", async () => {
  const routes = createOfficeProtocolRoutes();
  const response = await routes.handle(
    new Request("http://localhost/office/callbacks/signed-reference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["signed-body-value"]),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: 1 });
});
