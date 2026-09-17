import { beforeEach, describe, expect, mock, test } from "bun:test";

const fetchCalls: Array<[string, RequestInit]> = [];

beforeEach(() => {
  fetchCalls.length = 0;
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    fetchCalls.push([url, init]);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            instanceUid: "ins_1",
            environmentId: "env_1",
            name: "worker",
            status: "running",
            createdAt: "2026-08-31T00:00:00.000Z",
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as unknown as typeof fetch;
});

describe("instance API client", () => {
  // spawn 响应应使用稳定 instanceUid 契约，不引入运行时编号。
  test("spawn returns the stable instance view model", async () => {
    const { instanceApi } = await import("../api/instances");

    const result = await instanceApi.spawn({ environmentId: "env/a" });

    expect(result).toEqual({
      success: true,
      data: {
        instanceUid: "ins_1",
        environmentId: "env_1",
        name: "worker",
        status: "running",
        createdAt: "2026-08-31T00:00:00.000Z",
      },
    });
    expect(fetchCalls[0]?.[0]).toBe("/web/instances/from-environment");
    expect(fetchCalls[0]?.[1].method).toBe("POST");
    expect(JSON.parse(fetchCalls[0]?.[1].body as string)).toEqual({ environmentId: "env/a" });
  });

  // 删除实例的两个公开入口必须等价，并对路径参数进行编码。
  test("del and delete send equivalent encoded DELETE requests", async () => {
    const { instanceApi } = await import("../api/instances");

    await instanceApi.del({ id: "ins/a" });
    await instanceApi.delete({ id: "ins/a" });

    expect(fetchCalls).toHaveLength(2);
    for (const [url, init] of fetchCalls) {
      expect(url).toBe("/web/instances/ins%2Fa");
      expect(init.method).toBe("DELETE");
    }
  });
});
