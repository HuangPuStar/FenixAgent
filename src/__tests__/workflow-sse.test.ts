import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { publishWorkflowEvent } from "../services/workflow/workflow-events";
import { resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";
import { getAllEventBuses, removeEventBus } from "../transport/event-bus";

// workflow-sse 路由模块 — 生产 SSE 事件流端点（原 transport/sse-writer 的 SSE 行为测试迁移至此）
const route = (await import("../routes/web/workflow-sse")).default;

/**
 * 读取 Response 流直到包含目标文本或读满 maxChunks 个数据块。
 * workflow-sse 的帧顺序是 keepalive 先、回放事件后，断言回放内容时必须跨多个 chunk 读取；
 * 流在无新数据时 read() 会挂起（keepalive 间隔 15s），因此每个 chunk 带超时，超时视为流结束。
 */
async function readUntil(res: Response, needle: string, maxChunks = 10): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  let acc = "";
  try {
    for (let i = 0; i < maxChunks; i++) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 500)),
      ]);
      if (result.done) break;
      acc += new TextDecoder().decode(result.value);
      if (acc.includes(needle)) break;
    }
  } finally {
    reader.cancel();
  }
  return acc;
}

/** getWorkflowDef 走 db.select().from().where().limit() 链式查询，按 workflow 是否存在返回行 */
function stubWorkflowDb(workflow: { id: string; organizationId: string } | null) {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (workflow ? [workflow] : []),
        }),
      }),
    }),
  });
}

/** 清空全部 EventBus，防止用例间事件泄漏 */
function resetEventBuses() {
  for (const [key] of getAllEventBuses()) {
    removeEventBus(key);
  }
}

describe("GET /web/workflow/:workflowId/events (SSE)", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    stubWorkflowDb({ id: "wf-1", organizationId: "org-1" });
    resetEventBuses();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
    resetEventBuses();
  });

  // 正常订阅：返回 SSE 专用响应头
  test("返回 text/event-stream 响应头", async () => {
    const res = await route.handle(new Request("http://localhost/workflow/wf-1/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    res.body?.cancel();
  });

  // 订阅建立后先收到 keepalive 心跳
  test("连接建立后先收到 keepalive 心跳", async () => {
    const res = await route.handle(new Request("http://localhost/workflow/wf-1/events"));
    const text = await readUntil(res, ": keepalive", 1);
    expect(text).toContain(": keepalive");
  });

  // 断线重连：fromSeqNum 之后的历史事件被回放（按帧 id 递增、载荷为工作流事件对象）
  test("fromSeqNum 回放历史事件", async () => {
    publishWorkflowEvent("wf-1", "workflow.run_started", { runId: "run-1" });
    publishWorkflowEvent("wf-1", "workflow.run_status_changed", { runId: "run-1" });

    const res = await route.handle(new Request("http://localhost/workflow/wf-1/events?fromSeqNum=1"));
    const text = await readUntil(res, "id: 2");
    expect(text).toContain("id: 2");
    expect(text).toContain("workflow.run_status_changed");
    expect(text).toContain('"runId":"run-1"');
  });

  // 断线重连：fromSeqNum=0 时不回放历史事件，仅收到 keepalive
  test("fromSeqNum=0 不回放历史事件", async () => {
    publishWorkflowEvent("wf-1", "workflow.run_started", { runId: "run-1" });

    const res = await route.handle(new Request("http://localhost/workflow/wf-1/events"));
    const text = await readUntil(res, "__never__", 3);
    expect(text).toContain(": keepalive");
    expect(text).not.toContain("workflow.run_started");
  });

  // 断线重连：Last-Event-ID header 与 fromSeqNum 等效，按事件序号断点续传
  test("Last-Event-ID 断点续传", async () => {
    publishWorkflowEvent("wf-1", "workflow.run_started", { runId: "run-1" });
    publishWorkflowEvent("wf-1", "workflow.run_status_changed", { runId: "run-1" });

    const res = await route.handle(
      new Request("http://localhost/workflow/wf-1/events", { headers: { "Last-Event-ID": "1" } }),
    );
    const text = await readUntil(res, "id: 2");
    expect(text).toContain("id: 2");
    expect(text).toContain("workflow.run_status_changed");
  });

  // 实时订阅：keepalive 之后发布的事件被立即推送
  test("订阅期间实时推送新事件", async () => {
    const res = await route.handle(new Request("http://localhost/workflow/wf-1/events"));
    const reader = res.body!.getReader();

    const { value: firstChunk } = await reader.read();
    expect(new TextDecoder().decode(firstChunk!)).toContain(": keepalive");

    publishWorkflowEvent("wf-1", "workflow.run_started", { runId: "run-2" });
    const { value: secondChunk } = await reader.read();
    const eventText = new TextDecoder().decode(secondChunk!);
    expect(eventText).toContain("workflow.run_started");
    expect(eventText).toContain('"runId":"run-2"');
    reader.cancel();
  });

  // 认证边界：未登录请求被拒绝
  test("未认证请求返回 401", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    // sessionAuth macro 在 _testAuth 为 null 时走真实认证链路，
    // getSession 返回 null 触发 API key fallback，无 key 时最终返回 401
    stubAuthApi({ getSession: async () => null });
    const res = await route.handle(new Request("http://localhost/workflow/wf-1/events"));
    expect(res.status).toBe(401);
  });

  // 多租户隔离：workflow 不属于当前组织时拒绝订阅
  test("跨组织访问返回 404", async () => {
    stubWorkflowDb(null);
    const res = await route.handle(new Request("http://localhost/workflow/wf-1/events"));
    expect(res.status).toBe(404);
  });
});
