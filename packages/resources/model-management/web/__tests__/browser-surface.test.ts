import { expect, test } from "bun:test";

// 浏览器入口不能经值导入服务端模型管理实现。
test("浏览器入口不导入服务端模型管理实现", async () => {
  const source = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text();

  expect(source).not.toMatch(/from\s+["'](?:\.\/server|node:|drizzle-orm|@fenix\/model-gateway-litellm)/);
});
