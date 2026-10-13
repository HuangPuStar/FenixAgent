import { describe, expect, test } from "bun:test";
import { ProcessExecutor } from "../../executor/process-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { ShellNodeDef } from "../../types/dag";
import { WorkflowErrorCode } from "../../types/errors";
import type { DAGEvent } from "../../types/events";

function createContext(signal: AbortSignal): NodeExecutionContext {
  return {
    runId: "run-cancellation-regression",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal,
    storage: createInMemoryStorage(),
  };
}

function createNode(overrides: Partial<ShellNodeDef> = {}): ShellNodeDef {
  return { id: "wait", type: "shell", command: "sleep 3 & wait", ...overrides };
}

describe("shell 取消与重试的生命周期边界", () => {
  // 已取消的运行不得创建子进程或发射开始事件。
  test("启动前取消不启动节点", async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const context = createContext(cancellation.signal);

    await expect(new ProcessExecutor().execute(createNode(), context)).rejects.toMatchObject({
      code: WorkflowErrorCode.DAG_CANCELLED,
    });
    expect(await context.storage.getEvents(context.runId)).toHaveLength(0);
  });

  // 开始事件持久化期间收到取消，也必须关闭整棵进程树并及时释放输出管道。
  test("开始事件写入时取消不会丢失信号", async () => {
    if (process.platform === "win32") return;
    const cancellation = new AbortController();
    const context = createContext(cancellation.signal);
    const appendEvent = context.storage.appendEvent.bind(context.storage);
    context.storage.appendEvent = async (event: DAGEvent) => {
      await appendEvent(event);
      if (event.type === "node.started") cancellation.abort();
    };
    const startedAt = Date.now();

    await expect(new ProcessExecutor().execute(createNode(), context)).rejects.toMatchObject({
      code: WorkflowErrorCode.DAG_CANCELLED,
    });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    const events = await context.storage.getEvents(context.runId);
    expect(events.filter((event) => event.type === "node.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "node.completed")).toHaveLength(0);
  });

  // 节点超时与用户取消使用相同的资源释放路径，但必须保留不同的业务错误码。
  test("超时终止子进程树且不执行配置的重试", async () => {
    if (process.platform === "win32") return;
    const context = createContext(new AbortController().signal);
    const startedAt = Date.now();

    await expect(
      new ProcessExecutor().execute(createNode({ timeout: 0.1, retry: { count: 1, delay: 0 } }), context),
    ).rejects.toMatchObject({ code: WorkflowErrorCode.NODE_TIMEOUT });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    const events = await context.storage.getEvents(context.runId);
    expect(events.filter((event) => event.type === "node.retrying")).toHaveLength(0);
  });

  // 重试事件落盘期间取消不得漏过已触发的信号，也不能等待原退避时间或启动下一次进程。
  test("重试事件写入时取消跳过退避和下一次启动", async () => {
    const cancellation = new AbortController();
    const context = createContext(cancellation.signal);
    const appendEvent = context.storage.appendEvent.bind(context.storage);
    context.storage.appendEvent = async (event: DAGEvent) => {
      await appendEvent(event);
      if (event.type === "node.retrying") cancellation.abort();
    };
    const startedAt = Date.now();

    await expect(
      new ProcessExecutor().execute(createNode({ command: "exit 7", retry: { count: 1, delay: 3000 } }), context),
    ).rejects.toMatchObject({ code: WorkflowErrorCode.DAG_CANCELLED });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    const events = await context.storage.getEvents(context.runId);
    expect(events.filter((event) => event.type === "node.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "node.retrying")).toHaveLength(1);
  });
});
