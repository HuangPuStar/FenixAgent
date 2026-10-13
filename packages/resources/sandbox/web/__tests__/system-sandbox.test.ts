// web/__tests__/system-sandbox.test.ts
// 资源池请求构造的回归测试（原位于 apps/web/src/__tests__/system-sandbox.test.ts）。
//
// 从包外移入包内的意义：断言的对象是 sandbox 自己的请求契约，随包演进；
// 且这里经 `@fenix/resource-sandbox/web` 公开出口导入，顺带验证 exports["./web"] 可用。

import { afterEach, describe, expect, test } from "bun:test";
import { buildSandboxRebuildRequest, buildSandboxResourcePatch, systemSandboxApi } from "@fenix/resource-sandbox/web";

const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
/** 测试进程没有浏览器全局：master key 按最小替身注入，用完恢复（`getDiagnostics` 会读它拼 Authorization）。 */
const globalScope = globalThis as Record<string, unknown>;

afterEach(() => {
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

/** 替换全局 fetch 并固定响应；返回的 restore 必须在用例结束前调用（全局替换会泄漏到其它文件）。 */
function stubFetch(response: Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe("system sandbox request helpers", () => {
  // 资源表单只应提交 CPU、内存、磁盘和 GPU 四项覆盖值，空值用于取消对应覆盖。
  test("builds a restricted resource patch", () => {
    expect(
      buildSandboxResourcePatch({
        cpu: "2",
        memoryMb: "4096",
        diskGb: "",
        gpuCount: "0",
      }),
    ).toEqual({ cpu: 2, memoryMb: 4096, diskGb: null, gpuCount: 0 });
  });

  // 重建范围必须生成后端可识别的互斥参数。
  test("builds pool, instance, and user rebuild requests", () => {
    expect(buildSandboxRebuildRequest({ poolId: "pool-1", scope: "pool" })).toEqual({ sandboxPoolId: "pool-1" });
    expect(buildSandboxRebuildRequest({ poolId: "pool-1", instanceId: "sbi-1", scope: "instance" })).toEqual({
      sandboxPoolId: "pool-1",
      instanceIds: ["sbi-1"],
    });
    expect(buildSandboxRebuildRequest({ poolId: "pool-1", userId: "user-1", scope: "user" })).toEqual({
      sandboxPoolId: "pool-1",
      userIds: ["user-1"],
    });
  });
});

// 文本 / 流式端点（getDiagnostics / executeCommand / downloadTunnelConfig）的失败文案契约：
// 调用方把 `ApiError.message` 直接当 toast 的 description（见 ClusterPanel、RemoteSandboxPanel），
// 所以这里钉住「什么能进文案、什么不能」。断言经 `systemSandboxApi.server.getDiagnostics` 走真实入口，
// 不导出内部函数（`buildStreamError` 是模块私有实现）。
describe("sandbox stream error message", () => {
  const diagnosticsError = async (response: Response) => {
    globalScope.sessionStorage = { getItem: () => "master-key", setItem: () => {}, removeItem: () => {} };
    const restore = stubFetch(response);
    const error = await systemSandboxApi.server.getDiagnostics("srv-1", "sbx-1").catch((cause: unknown) => cause);
    restore();
    return error as Error & { code?: string };
  };

  // 网关 / 代理直接回 HTML 时退化为状态码文案：把网关页正文塞进 toast 是无意义的噪声，
  // 长 HTML 还会撑爆 description；正文只用于尝试解析信封，解析失败即丢弃。
  test("非信封响应只回状态码文案，不回显正文", async () => {
    const error = await diagnosticsError(new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }));

    expect(error.message).toBe("HTTP 502");
    expect(error.code).toBe("UNKNOWN");
  });

  // 信封内的 message 与 code 是后端有意给的信息（如「沙箱不存在」），必须原样保留。
  test("信封内的 code 与 message 原样保留", async () => {
    const error = await diagnosticsError(
      new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "sandbox not found" } }), { status: 404 }),
    );

    expect(error.message).toBe("sandbox not found");
    expect(error.code).toBe("NOT_FOUND");
  });

  // 信封 message 仍要封顶：后端在上游返回非 JSON 时会把上游响应正文原样透传成 message，
  // 不封顶等于同一类长正文换个字段进 toast。截断只影响极端长文，短消息不受影响（见上一个用例）。
  test("超长信封 message 截断并加省略号", async () => {
    const longMessage = "x".repeat(1_000);
    const error = await diagnosticsError(
      new Response(JSON.stringify({ error: { code: "CLUSTER_ERROR", message: longMessage } }), { status: 503 }),
    );

    expect(error.code).toBe("CLUSTER_ERROR");
    expect(error.message.length).toBeLessThan(longMessage.length);
    expect(error.message.endsWith("…")).toBe(true);
  });
});
