/**
 * ApiExecutor + RemoteExecutorBase 测试
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiExecutor } from "../../executor/api-executor";
import { RemoteExecutorBase } from "../../executor/remote-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { ApiNodeDef } from "../../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";

// ---------- 辅助工具 ----------

/** 创建测试用的 NodeExecutionContext */
function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: "test-run-001",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

/** 创建 API 节点定义 */
function apiNode(overrides?: Partial<ApiNodeDef>): ApiNodeDef {
  return {
    id: "api-node",
    type: "api",
    url: "https://httpbin.org/get",
    ...overrides,
  };
}

/** 创建 mock fetch */
function mockFetch(response: { status?: number; body?: string; ok?: boolean; error?: Error }): typeof globalThis.fetch {
  return async () => {
    if (response.error) throw response.error;
    return {
      ok: response.ok ?? (response.status ? response.status >= 200 && response.status < 300 : true),
      status: response.status ?? 200,
      text: async () => response.body ?? "",
      json: async () => (response.body ? JSON.parse(response.body) : undefined),
      headers: new Headers(),
    } as Response;
  };
}

// ========== ApiExecutor 基础测试 ==========

describe("ApiExecutor", () => {
  let executor: ApiExecutor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    executor = new ApiExecutor();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // GET 请求成功
  test("GET 请求返回正确 stdout 和 exit_code 0", async () => {
    globalThis.fetch = mockFetch({ body: '{"result":"ok"}' });
    const ctx = makeCtx();
    const node = apiNode({ method: "GET" });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('{"result":"ok"}');
    expect(output.json).toEqual({ result: "ok" });
    expect(output.size).toBeGreaterThan(0);
  });

  // POST with JSON body
  test("POST with body 发送请求", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => '{"created":true}',
        headers: new Headers(),
      } as Response;
    };
    const ctx = makeCtx();
    const node = apiNode({
      method: "POST",
      url: "https://httpbin.org/post",
      body: '{"name":"test"}',
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.json).toEqual({ created: true });
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe('{"name":"test"}');
  });

  // 404 响应 → exit_code 404 + FAILED
  test("404 响应抛出 WorkflowError，exit_code 404", async () => {
    globalThis.fetch = mockFetch({ status: 404, body: "Not Found" });
    const ctx = makeCtx();
    const node = apiNode({ url: "https://httpbin.org/notfound" });

    try {
      await executor.execute(node, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe(WorkflowErrorCode.NODE_FAILED);
      expect((e as WorkflowError).details?.exit_code).toBe(404);
    }
  });

  // 500 响应 → exit_code 500
  test("500 响应抛出 WorkflowError，exit_code 500", async () => {
    globalThis.fetch = mockFetch({ status: 500, body: "Internal Server Error" });
    const ctx = makeCtx();
    const node = apiNode();

    try {
      await executor.execute(node, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).details?.exit_code).toBe(500);
    }
  });

  // 非 JSON 响应 → json 为 undefined
  test("非 JSON 响应 json 字段为 undefined", async () => {
    globalThis.fetch = mockFetch({ body: "plain text response" });
    const ctx = makeCtx();
    const node = apiNode();
    const output = await executor.execute(node, ctx);

    expect(output.json).toBeUndefined();
    expect(output.stdout).toBe("plain text response");
  });

  // 非法节点类型
  test("非 api 节点抛出错误", async () => {
    const ctx = makeCtx();
    const node = { id: "bad", type: "shell", command: "echo hi" } as any;

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // node.started 事件
  test("执行产生 node.started 事件", async () => {
    globalThis.fetch = mockFetch({ body: "ok" });
    const ctx = makeCtx();
    const node = apiNode();
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "api-node" });
    const startedEvents = events.filter((e) => e.type === "node.started");
    expect(startedEvents.length).toBe(1);
    expect(startedEvents[0].metadata?.url).toBe("https://httpbin.org/get");
  });

  // node.completed 事件
  test("成功执行产生 node.completed 事件", async () => {
    globalThis.fetch = mockFetch({ body: '{"ok":true}' });
    const ctx = makeCtx();
    const node = apiNode();
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "api-node" });
    const completedEvents = events.filter((e) => e.type === "node.completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].metadata?.exit_code).toBe(0);
  });

  // node.failed 事件（404）
  test("404 产生 node.failed 事件", async () => {
    globalThis.fetch = mockFetch({ status: 404, body: "Not Found" });
    const ctx = makeCtx();
    const node = apiNode();

    try {
      await executor.execute(node, ctx);
    } catch {}

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "api-node" });
    const failedEvents = events.filter((e) => e.type === "node.failed");
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].metadata?.error).toBe("HTTP 404");
    expect(failedEvents[0].metadata?.exit_code).toBe(404);
  });
});

// ========== resolvedInputs 测试 ==========

describe("ApiExecutor resolvedInputs", () => {
  let executor: ApiExecutor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    executor = new ApiExecutor();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // resolvedInputs.url 注入到 fetch 请求
  test("resolvedInputs.url 注入到 fetch 请求", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = async (url) => {
      capturedUrl = url as string;
      return {
        ok: true,
        status: 200,
        text: async () => "ok",
        headers: new Headers(),
      } as Response;
    };
    const ctx = makeCtx({
      params: { host: "example.com", path: "users" },
      resolvedInputs: { url: "https://example.com/users" },
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
    const node = apiNode({ url: "https://${{ params.host }}/${{ params.path }}" });
    await executor.execute(node, ctx);

    expect(capturedUrl).toBe("https://example.com/users");
  });

  // resolvedInputs.headers 注入到 fetch 请求
  test("resolvedInputs.headers 注入到 fetch 请求", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => "ok",
        headers: new Headers(),
      } as Response;
    };
    const ctx = makeCtx({
      secrets: { API_KEY: "key123" },
      resolvedInputs: { headers: { Authorization: "Bearer key123" } },
    });
    const node = apiNode({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
      headers: { Authorization: "Bearer ${{ secrets.API_KEY }}" },
    });
    await executor.execute(node, ctx);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer key123");
  });

  // resolvedInputs.body 注入到 fetch 请求
  test("resolvedInputs.body 注入到 fetch 请求", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => '{"done":true}',
        headers: new Headers(),
      } as Response;
    };
    const ctx = makeCtx({
      params: { name: "test-user" },
      resolvedInputs: { body: '{"user":"test-user"}' },
    });
    const node = apiNode({
      method: "POST",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
      body: '{"user":"${{ params.name }}"}',
    });
    await executor.execute(node, ctx);

    expect(capturedInit?.body).toBe('{"user":"test-user"}');
  });
});

// ========== 超时测试 ==========

describe("ApiExecutor 超时", () => {
  let executor: ApiExecutor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    executor = new ApiExecutor();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // 请求超时
  test("请求超时后节点失败", async () => {
    // mock fetch 永远不 resolve，但监听 signal abort
    globalThis.fetch = async (_url, init) => {
      await new Promise<void>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (sig) {
          sig.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }
      });
      throw new Error("unreachable");
    };
    const ctx = makeCtx();
    const node = apiNode({ timeout: 1 }); // 1 秒超时
    const start = Date.now();

    try {
      await executor.execute(node, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe(WorkflowErrorCode.NODE_TIMEOUT);
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  // 外部取消
  test("外部 AbortSignal 取消后节点失败", async () => {
    globalThis.fetch = async (_url, init) => {
      // 等待信号中止
      await new Promise<void>((resolve) => {
        (init?.signal as AbortSignal).addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const controller = new AbortController();
    const ctx = makeCtx({ signal: controller.signal });
    const node = apiNode({ timeout: 10 });

    // 50ms 后取消
    setTimeout(() => controller.abort(), 50);

    try {
      await executor.execute(node, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe(WorkflowErrorCode.DAG_CANCELLED);
    }
  });
});

// ========== 重试测试 ==========

describe("ApiExecutor 重试", () => {
  let executor: ApiExecutor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    executor = new ApiExecutor();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // 第一次失败，第二次成功
  test("重试机制：第一次失败、第二次成功", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 500,
          text: async () => "error",
          headers: new Headers(),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => '{"ok":true}',
        headers: new Headers(),
      } as Response;
    };

    const ctx = makeCtx();
    const node = apiNode({ retry: { count: 1, delay: 50, backoff: "fixed" } });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.json).toEqual({ ok: true });
    expect(callCount).toBe(2);

    // 验证 node.retrying 事件
    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "api-node" });
    const retryEvents = events.filter((e) => e.type === "node.retrying");
    expect(retryEvents.length).toBe(1);
    expect(retryEvents[0].metadata?.attempt).toBe(2);
  });

  // 重试耗尽仍失败
  test("重试耗尽后仍然失败", async () => {
    globalThis.fetch = mockFetch({ status: 500, body: "error" });
    const ctx = makeCtx();
    const node = apiNode({ retry: { count: 2, delay: 50, backoff: "fixed" } });

    try {
      await executor.execute(node, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
    }

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "api-node" });
    const retryEvents = events.filter((e) => e.type === "node.retrying");
    expect(retryEvents.length).toBe(2);
  });
});

// ========== RemoteExecutorBase 测试 ==========

describe("RemoteExecutorBase", () => {
  // 验证 RemoteExecutorBase 可被继承
  test("子类继承后可正常执行 executeWithRetry", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = originalFetch;

    let callCount = 0;
    const node = apiNode({ retry: { count: 1, delay: 10, backoff: "fixed" } });
    const ctx = makeCtx();

    class TestExecutor extends RemoteExecutorBase {
      async execute() {
        return this.executeWithRetry(node, ctx, async () => {
          callCount++;
          if (callCount === 1) {
            throw new WorkflowError("fail", WorkflowErrorCode.NODE_FAILED);
          }
          return { stdout: "ok", exit_code: 0 };
        });
      }
    }

    const executor = new TestExecutor();
    const output = await executor.execute();

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe("ok");
    expect(callCount).toBe(2);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "api-node" });
    const retryEvents = events.filter((e) => e.type === "node.retrying");
    expect(retryEvents.length).toBe(1);
  });

  // 超时和取消不重试
  test("超时错误不触发重试", async () => {
    const node = apiNode({ retry: { count: 2, delay: 10, backoff: "fixed" } });
    const ctx = makeCtx();

    class TimeoutExecutor extends RemoteExecutorBase {
      async execute() {
        return this.executeWithRetry(node, ctx, async () => {
          throw new WorkflowError("timeout", WorkflowErrorCode.NODE_TIMEOUT);
        });
      }
    }

    const executor = new TimeoutExecutor();

    try {
      await executor.execute();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe(WorkflowErrorCode.NODE_TIMEOUT);
    }

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "api-node" });
    const retryEvents = events.filter((e) => e.type === "node.retrying");
    expect(retryEvents.length).toBe(0);
  });
});

// ========== Content-Type 测试 ==========

describe("ApiExecutor Content-Type", () => {
  let executor: ApiExecutor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    executor = new ApiExecutor();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // 带 body 时自动设置 Content-Type
  test("POST 带 body 时自动设置 Content-Type: application/json", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => "ok",
        headers: new Headers(),
      } as Response;
    };
    const ctx = makeCtx();
    const node = apiNode({ method: "POST", body: '{"key":"val"}' });
    await executor.execute(node, ctx);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.["Content-Type"]).toBe("application/json");
  });

  // 已设置 Content-Type 时不覆盖
  test("已设置 Content-Type 时不覆盖", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () => "ok",
        headers: new Headers(),
      } as Response;
    };
    const ctx = makeCtx();
    const node = apiNode({
      method: "POST",
      body: "text data",
      headers: { "Content-Type": "text/plain" },
    });
    await executor.execute(node, ctx);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.["Content-Type"]).toBe("text/plain");
  });
});
