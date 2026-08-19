import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { getPeriTaskDetail } from "../api/peri-task-details";
import { ApiError } from "../api/request";

const originalFetch = globalThis.fetch;
const fetchCalls: Array<[string, RequestInit]> = [];
let responseBody: unknown;
let responseStatus: number;

beforeEach(() => {
  fetchCalls.length = 0;
  responseStatus = 200;
  responseBody = {
    success: true,
    data: {
      kind: "preview",
      taskId: "task/1",
      taskKind: "subagent",
      items: [{ type: "text", content: "任务输出" }],
      nextCursor: null,
      complete: false,
      limitation: "source_only_provides_preview",
    },
  };
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    fetchCalls.push([url, init]);
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("peri task details API client", () => {
  // 读取任务详情必须编码三个路径标识、固定请求最小预览范围，并透传调用方的取消信号。
  test("uses encoded detail endpoint, preview limits, and caller signal", async () => {
    const controller = new AbortController();

    const result = await getPeriTaskDetail("env/a", "session b", "task/1", controller.signal);

    expect(result).toEqual(responseBody.data);
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0] ?? [];
    expect(url).toBe("/web/agents/env%2Fa/sessions/session%20b/peri-tasks/task%2F1/detail?limit=1&byteLimit=2000");
    expect(init?.method).toBeUndefined();
    expect(init?.signal).not.toBe(controller.signal);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });

  // 后端不可用响应必须由统一 unwrap 转为保留错误码的 ApiError，供界面展示明确失败状态。
  test("throws ApiError with backend unavailable reason", async () => {
    responseStatus = 404;
    responseBody = {
      success: false,
      error: {
        code: "PERI_TASK_DETAIL_UNAVAILABLE",
        message: "任务详情已过期",
      },
      data: { reason: "expired" },
    };

    const result = getPeriTaskDetail("env-1", "session-1", "task-1", new AbortController().signal);

    try {
      await result;
      throw new Error("expected task detail request to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as InstanceType<typeof ApiError>;
      expect(apiError.code).toBe("PERI_TASK_DETAIL_UNAVAILABLE");
      expect(apiError.message).toBe("任务详情已过期");
      expect(apiError.data).toEqual({ reason: "expired" });
    }
  });
});
