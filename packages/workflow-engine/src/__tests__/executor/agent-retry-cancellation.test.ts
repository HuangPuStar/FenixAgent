import { expect, spyOn, test } from "bun:test";
import { AgentExecutor } from "../../executor/agent-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { Transport } from "../../transport/transport";
import type { AgentNodeDef } from "../../types/dag";
import { WorkflowErrorCode } from "../../types/errors";

async function abortDuringRetry(mode: "timeout" | "cancel") {
  const timers = spyOn(globalThis, "setTimeout");
  const dag = new AbortController();
  const storage = createInMemoryStorage();
  let entered!: () => void;
  const retrying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const append = storage.appendEvent.bind(storage);
  storage.appendEvent = async (event) => {
    await append(event);
    if (event.type === "node.retrying") entered();
  };
  let connections = 0;
  const transport: Transport = {
    async connect() {
      connections++;
      throw new Error("temporary connection failure");
    },
  };
  const context: NodeExecutionContext = {
    runId: "retry-cancellation",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: dag.signal,
    storage,
  };
  const node: AgentNodeDef = {
    id: "agent",
    type: "agent",
    agent: "environment",
    prompt: "run",
    timeout: 60,
    retry: { count: 2, delay: 10_000, backoff: "fixed" },
  };
  const running = new AgentExecutor(transport).execute(node, context);
  // 立即登记拒绝观察器，避免测试自身产生未处理的取消拒绝。
  const outcome = running.then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await retrying;
    await Bun.sleep(0);
    expect(timers.mock.calls.some(([, delay]) => typeof delay === "number" && delay >= 5000 && delay <= 10_000)).toBe(
      true,
    );
    if (mode === "cancel") dag.abort();
    else {
      const timeout = timers.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
      if (typeof timeout !== "function") throw new Error("node timeout was not scheduled");
      timeout();
    }
    expect(await outcome).toMatchObject({
      name: "WorkflowError",
      code: mode === "timeout" ? WorkflowErrorCode.NODE_TIMEOUT : WorkflowErrorCode.DAG_CANCELLED,
      details: { node_id: node.id },
    });
    expect(connections).toBe(1);
    const events = await storage.getEvents(context.runId);
    expect(events.filter((event) => event.type === "node.retrying")).toHaveLength(1);
  } finally {
    dag.abort();
    await outcome;
    timers.mockRestore();
  }
}

// 重试等待已开始后触发节点期限，必须报告节点超时且不能重新连接 Agent。
test("retry backoff preserves node timeout classification", () => abortDuringRetry("timeout"));

// DAG 在重试等待期间取消，必须返回取消领域错误而不是裸 AbortError。
test("retry backoff preserves DAG cancellation classification", () => abortDuringRetry("cancel"));
