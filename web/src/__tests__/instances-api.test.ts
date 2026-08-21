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
            id: "ins_1",
            group_id: "group_1",
            environment_id: "env_1",
            session_id: null,
            instance_number: 2,
            created_at: 123,
            port: 3000,
            status: "running",
            error: null,
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as unknown as typeof fetch;
});

describe("instance API client", () => {
  // spawn 响应应只转换顶层 snake_case 字段，供前端使用稳定的 camelCase InstanceInfo。
  test("spawn maps top-level instance fields from snake_case to camelCase", async () => {
    const { instanceApi } = await import("../api/instances");

    const result = await instanceApi.spawn({ environmentId: "env/a" });

    expect(result).toEqual({
      success: true,
      data: {
        id: "ins_1",
        groupId: "group_1",
        environmentId: "env_1",
        sessionId: null,
        instanceNumber: 2,
        createdAt: 123,
        port: 3000,
        status: "running",
        error: null,
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
