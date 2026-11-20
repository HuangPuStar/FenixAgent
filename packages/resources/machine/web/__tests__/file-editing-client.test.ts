import { afterEach, expect, test } from "bun:test";
import { EditingError } from "@fenix/file-editing/contracts";
import { machineEditingClient } from "../api/file-editing";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// 保存携带目标内容版本和稳定操作标识，读取的文件名必须按路径逐段编码。
test("editing transport preserves target versions and operation ids", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({
        success: true,
        data: { path: "user/a#b.txt", name: "a#b.txt", content: "hello", size: 5, encoding: "utf-8", version: "v1" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const file = { environmentId: "env_1", path: "user/a#b.txt" };
  expect((await machineEditingClient.readText(file)).version).toBe("v1");
  expect(calls[0].url).toContain("a%23b.txt");
  expect(calls[0].url).toContain("includeVersion=true");
  await machineEditingClient.saveText(file, "next", { expectedVersion: "v1", opId: "operation-1" });
  expect(JSON.parse(String(calls[1].init?.body)).expectedVersion).toBe("v1");
  expect(new Headers(calls[1].init?.headers).get("x-file-op-id")).toBe("operation-1");
});

// 不接受缺少已提交版本的成功响应，避免将错误基线配给后续编辑。
test("missing response version is rejected rather than treated as saved", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ success: true, data: { path: "a.txt", size: 1 } }), {
    preconnect: originalFetch.preconnect,
  });
  expect(machineEditingClient.readText({ environmentId: "env", path: "a.txt" })).rejects.toBeInstanceOf(EditingError);
});

// 远端保存冲突转换为编辑包错误，错误不能作为普通成功返回。
test("normalizes save conflicts into the independent editor contract", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json(
        { error: { code: "version_conflict", type: "version_conflict", message: "changed" } },
        { status: 409 },
      ),
    { preconnect: originalFetch.preconnect },
  );
  try {
    await machineEditingClient.saveText({ environmentId: "env", path: "a.txt" }, "new", {
      expectedVersion: "old",
      opId: "op-1",
    });
    throw new Error("expected conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(EditingError);
    expect((error as EditingError).code).toBe("conflict");
  }
});

// Office 路由已使用独立包错误码，浏览器不能把可裁决的冲突降级成服务不可用。
test("preserves Office session conflict and missing-file errors", async () => {
  let code = "conflict";
  globalThis.fetch = Object.assign(
    async () => Response.json({ success: false, error: { code, message: "session changed" } }, { status: 409 }),
    { preconnect: originalFetch.preconnect },
  );
  await expect(machineEditingClient.overwriteOffice("session")).rejects.toMatchObject({ code: "conflict" });
  code = "not-found";
  await expect(machineEditingClient.getSession("session")).rejects.toMatchObject({ code: "not-found" });
});
