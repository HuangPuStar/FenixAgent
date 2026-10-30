import { afterEach, expect, spyOn, test } from "bun:test";
import { createMcpBatch } from "../pages/agent-panel/pages/agent-mcp-utils";

afterEach(() => {
  jestRestore();
});
let jestRestore = () => {};

// 第二条创建失败时仅按服务端返回的 ID 补偿，不能删除原有同名条目。
test("批量创建失败只删除本次已创建 ID，并保留创建错误", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    if (method === "DELETE")
      return Response.json({ success: false, error: { code: "ROLLBACK", message: "rollback failed" } });
    if (calls.length === 1) return Response.json({ success: true, data: { id: "new-row-uuid", name: "same-name" } });
    return Response.json({ success: false, error: { code: "CONFLICT", message: "second create failed" } });
  });
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  jestRestore = () => {
    fetchSpy.mockRestore();
    logSpy.mockRestore();
  };
  await expect(
    createMcpBatch([
      { name: "same-name", config: { type: "remote", url: "https://example.com/mcp" } },
      { name: "existing", config: { type: "remote", url: "https://example.com/mcp" } },
    ]),
  ).rejects.toMatchObject({ message: "second create failed" });
  expect(calls).toEqual([
    { path: "/web/config/mcp", method: "POST" },
    { path: "/web/config/mcp", method: "POST" },
    { path: "/web/config/mcp/new-row-uuid", method: "DELETE" },
  ]);
  expect(logSpy).toHaveBeenCalled();
});
