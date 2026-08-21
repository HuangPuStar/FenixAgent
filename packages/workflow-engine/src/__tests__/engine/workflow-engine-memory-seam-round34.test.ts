import { describe, expect, test } from "bun:test";
import { createWorkflowEngine } from "../../engine/workflow-engine";
import { CustomNodeRegistry } from "../../plugins/registry";
import type { CustomNode, ExecuteContext } from "../../plugins/types";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { NodeOutput } from "../../types/execution";

const HMAC_SECRET = "round34-memory-seam-secret";

function createEngine(tools: CustomNode[]) {
  const registry = new CustomNodeRegistry();
  for (const tool of tools) registry.register(tool);
  const storage = createInMemoryStorage();
  return {
    engine: createWorkflowEngine({ storage, hmacSecret: HMAC_SECRET, customRegistry: registry }),
    storage,
  };
}

function customTool(
  name: string,
  execute: (ctx: ExecuteContext) => Promise<NodeOutput>,
  onCleanup?: CustomNode["onCleanup"],
): CustomNode {
  return {
    name,
    description: `${name} 测试工具`,
    inputs: {},
    produces: [],
    execute,
    onCleanup,
  };
}

function customYaml(nodes: string): string {
  return `
name: memory-seam-workflow
schema_version: "1"
nodes:
${nodes.replace(/(\n {4}tool:[^\n]+)/g, "$1\n    outputs: {}")}
`;
}

describe("工作流引擎内存 seam", () => {
  test("扇入 DAG 仅在全部依赖完成后并发执行并保留事件顺序", async () => {
    const calls: string[] = [];
    let releaseLeft: (() => void) | undefined;
    let releaseRight: (() => void) | undefined;
    const leftReady = Promise.withResolvers<void>();
    const rightReady = Promise.withResolvers<void>();

    const { engine } = createEngine([
      customTool("record", async (ctx) => {
        calls.push(ctx.inputs.node as string);
        if (ctx.inputs.node === "left") {
          leftReady.resolve();
          await new Promise<void>((resolve) => {
            releaseLeft = resolve;
          });
        }
        if (ctx.inputs.node === "right") {
          rightReady.resolve();
          await new Promise<void>((resolve) => {
            releaseRight = resolve;
          });
        }
        return { stdout: ctx.inputs.node as string, exit_code: 0 };
      }),
    ]);
    const yaml = customYaml(`  - id: root
    type: custom
    tool: record
    inputs:
      node: params.root
  - id: left
    type: custom
    tool: record
    depends_on: [root]
    inputs:
      node: params.left
  - id: right
    type: custom
    tool: record
    depends_on: [root]
    inputs:
      node: params.right
  - id: join
    type: custom
    tool: record
    depends_on: [left, right]
    inputs:
      node: params.join`);

    const run = engine.runAsync(yaml, { root: "root", left: "left", right: "right", join: "join" });
    await Promise.all([leftReady.promise, rightReady.promise]);
    expect(calls).toEqual(["root", "left", "right"]);

    releaseLeft?.();
    releaseRight?.();
    const result = await run.result;

    expect(result.status).toBe("SUCCESS");
    expect(calls).toEqual(["root", "left", "right", "join"]);
    const events = await engine.getEvents(result.runId);
    expect(events.filter((event) => event.type === "node.completed").map((event) => event.node_id)).toEqual([
      "root",
      "left",
      "right",
      "join",
    ]);
  });

  test("失败分支跳过下游但不阻塞独立分支", async () => {
    const calls: string[] = [];
    const { engine } = createEngine([
      customTool("may_fail", async (ctx) => {
        calls.push(ctx.inputs.node as string);
        if (ctx.inputs.node === "broken") throw new Error("预期失败");
        return { stdout: ctx.inputs.node as string, exit_code: 0 };
      }),
    ]);
    const yaml = customYaml(`  - id: broken
    type: custom
    tool: may_fail
    inputs:
      node: params.broken
  - id: blocked
    type: custom
    tool: may_fail
    depends_on: [broken]
    inputs:
      node: params.blocked
  - id: independent
    type: custom
    tool: may_fail
    inputs:
      node: params.independent`);

    const result = await engine.run(yaml, { broken: "broken", blocked: "blocked", independent: "independent" });

    expect(result.status).toBe("FAILED");
    expect(calls).toEqual(["broken", "independent"]);
    const events = await engine.getEvents(result.runId);
    expect(events.some((event) => event.type === "node.failed" && event.node_id === "broken")).toBe(true);
    expect(events.some((event) => event.type === "node.skipped" && event.node_id === "blocked")).toBe(true);
  });

  test("取消运行会中断内存节点并释放其资源", async () => {
    const started = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<{ result: NodeOutput | null; error: Error | null }>();
    const { engine } = createEngine([
      customTool(
        "wait_for_cancel",
        async (ctx) => {
          started.resolve();
          await new Promise<void>((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          });
          return { stdout: "不应完成", exit_code: 0 };
        },
        async (_ctx, result, error) => cleanup.resolve({ result, error }),
      ),
    ]);
    const run = engine.runAsync(
      customYaml(`  - id: waiting
    type: custom
    tool: wait_for_cancel`),
    );

    await started.promise;
    await engine.cancel(run.runId);
    const result = await run.result;
    const released = await cleanup.promise;

    expect(result.status).toBe("CANCELLED");
    expect(released.result).toBeNull();
    expect(released.error?.name).toBe("AbortError");
    expect((await engine.getRunStatus(run.runId))?.dag_status).toBe("CANCELLED");
  });

  test("审批数据作为节点输出传递给恢复后的下游节点", async () => {
    const observed: unknown[] = [];
    const { engine } = createEngine([
      customTool("capture_approval", async (ctx) => {
        observed.push(ctx.inputs.approval);
        return { stdout: "captured", exit_code: 0 };
      }),
    ]);
    const yaml = customYaml(`  - id: approval
    type: audit
    display_data:
      message: 请审批
  - id: after_approval
    type: custom
    tool: capture_approval
    depends_on: [approval]
    inputs:
      approval: nodes.approval.output`);

    const suspended = await engine.run(yaml);
    const [pending] = await engine.getPendingApprovals(suspended.runId);
    const approval = { accepted: true, reviewer: "测试用户" };
    const resumed = await engine.approveNode(suspended.runId, pending.nodeId, pending.approvalToken, approval);

    expect(suspended.status).toBe("SUSPENDED");
    expect(resumed.status).toBe("SUCCESS");
    expect(observed).toEqual([{ ...approval, stdout: JSON.stringify(approval) }]);
    const events = await engine.getEvents(suspended.runId);
    expect(events.some((event) => event.type === "audit.approved" && event.metadata?.data === approval)).toBe(true);
    expect(await engine.getPendingApprovals(suspended.runId)).toEqual([]);
  });

  test("rerunFrom 保留上游输出并只重新执行目标节点及下游", async () => {
    const executions: string[] = [];
    const middleSources: unknown[] = [];
    const { engine } = createEngine([
      customTool("counter", async (ctx) => {
        const id = ctx.inputs.id as string;
        if (ctx.nodeId === "middle") middleSources.push(ctx.inputs.source);
        executions.push(id);
        return { stdout: `${id}-${executions.filter((value) => value === id).length}`, exit_code: 0 };
      }),
    ]);
    const yaml = customYaml(`  - id: source
    type: custom
    tool: counter
    inputs:
      id: params.source
  - id: middle
    type: custom
    tool: counter
    depends_on: [source]
    inputs:
      id: params.middle
      source: nodes.source.output.stdout
  - id: sink
    type: custom
    tool: counter
    depends_on: [middle]
    inputs:
      id: params.sink`);

    const original = await engine.run(yaml, { source: "source", middle: "middle", sink: "sink" });
    const rerun = await engine.rerunFrom(original.runId, yaml, "middle");

    expect(original.status).toBe("SUCCESS");
    expect(rerun.status).toBe("SUCCESS");
    expect(rerun.runId).not.toBe(original.runId);
    expect(executions).toEqual(["source", "middle", "sink", "middle", "sink"]);
    expect(middleSources).toEqual(["source-1", "source-1"]);
    expect((await engine.getOutput(original.runId, "source"))?.stdout).toBe("source-1");
    expect((await engine.getOutput(rerun.runId, "middle"))?.stdout).toBe("middle-2");
  });
});
