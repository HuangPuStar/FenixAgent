import { describe, expect, test } from "bun:test";
import { createWorkflowEngine } from "../../engine/workflow-engine";
import { CustomNodeRegistry } from "../../plugins/registry";
import type { CustomNode, ExecuteContext } from "../../plugins/types";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";
import type { NodeOutput } from "../../types/execution";

const HMAC_SECRET = "round47-memory-seam-secret";

function createEngine(tools: CustomNode[]) {
  const registry = new CustomNodeRegistry();
  for (const tool of tools) registry.register(tool);
  return createWorkflowEngine({ storage: createInMemoryStorage(), hmacSecret: HMAC_SECRET, customRegistry: registry });
}

function tool(
  name: string,
  execute: (ctx: ExecuteContext) => Promise<NodeOutput>,
  onCleanup?: CustomNode["onCleanup"],
): CustomNode {
  return { name, description: name, inputs: {}, produces: [], execute, onCleanup };
}

function yaml(nodes: string, params = ""): string {
  return `
name: round47
schema_version: "1"
${params}${nodes ? `nodes:\n${nodes.replace(/(\n {4}tool:[^\n]+)/g, "$1\n    outputs: {}")}` : "nodes: []"}
`;
}

describe("工作流引擎 round47 内存行为", () => {
  test("合法空工作流会生成成功快照和成对 DAG 事件", async () => {
    // 验证无节点执行仍完整经历启动、完成与快照生命周期。
    const engine = createEngine([]);
    const result = await engine.run(yaml(""));
    const events = await engine.getEvents(result.runId);

    expect(result.status).toBe("SUCCESS");
    expect((await engine.getRunStatus(result.runId))?.dag_status).toBe("SUCCESS");
    expect(events.map((event) => event.type)).toEqual(["dag.started", "dag.completed"]);
  });

  test("dryRun 对环形依赖不生成执行计划", () => {
    // 验证门面不会为校验失败的环形 DAG 提供误导性的计划。
    const engine = createEngine([]);
    expect(() =>
      engine.dryRun(
        yaml(`  - id: first
    type: audit
    display_data: { message: first }
    depends_on: [second]
  - id: second
    type: audit
    display_data: { message: second }
    depends_on: [first]`),
      ),
    ).toThrow(WorkflowError);
  });

  test("runAsync 在校验失败时同步抛出验证错误", () => {
    // 验证异步入口在返回 runId 前即拒绝不存在的依赖。
    const engine = createEngine([]);
    const invalid = yaml(`  - id: child
    type: audit
    display_data: { message: child }
    depends_on: [missing]`);

    expect(() => engine.runAsync(invalid)).toThrow(WorkflowError);
  });

  test("默认参数会注入 custom 节点上下文", async () => {
    // 验证 prepareRun 将 YAML 默认值解析后传给执行器。
    const observed: unknown[] = [];
    const engine = createEngine([
      tool("observe", async (ctx) => {
        observed.push(ctx.params.greeting);
        return { stdout: String(ctx.params.greeting), exit_code: 0 };
      }),
    ]);
    const result = await engine.run(
      yaml(
        `  - id: observe
    type: custom
    tool: observe`,
        `params:
  greeting:
    type: string
    default: 默认问候
`,
      ),
    );

    expect(result.status).toBe("SUCCESS");
    expect(observed).toEqual(["默认问候"]);
  });

  test("调用参数会覆盖 YAML 默认参数", async () => {
    // 验证显式传入的参数优先于工作流声明的默认值。
    const observed: unknown[] = [];
    const engine = createEngine([
      tool("observe", async (ctx) => {
        observed.push(ctx.params.greeting);
        return { stdout: String(ctx.params.greeting), exit_code: 0 };
      }),
    ]);
    await engine.run(
      yaml(
        `  - id: observe
    type: custom
    tool: observe`,
        `params:
  greeting:
    type: string
    default: 默认问候
`,
      ),
      { greeting: "调用方问候" },
    );

    expect(observed).toEqual(["调用方问候"]);
  });

  test("并发运行的参数和输出彼此隔离", async () => {
    // 验证每个 run 拥有独立上下文，不会串用同时启动的参数或输出。
    const engine = createEngine([
      tool("identity", async (ctx) => ({ stdout: String(ctx.params.value), exit_code: 0 })),
    ]);
    const workflow = yaml(`  - id: identity
    type: custom
    tool: identity`);
    const [left, right] = await Promise.all([
      engine.run(workflow, { value: "left" }),
      engine.run(workflow, { value: "right" }),
    ]);

    expect(left.runId).not.toBe(right.runId);
    expect((await engine.getOutput(left.runId, "identity"))?.stdout).toBe("left");
    expect((await engine.getOutput(right.runId, "identity"))?.stdout).toBe("right");
  });

  test("运行中状态快照显示 RUNNING", async () => {
    // 验证 runAsync 返回后可查询尚未完成的运行状态。
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const engine = createEngine([
      tool("wait", async () => {
        started.resolve();
        await release.promise;
        return { stdout: "done", exit_code: 0 };
      }),
    ]);
    const run = engine.runAsync(
      yaml(`  - id: wait
    type: custom
    tool: wait`),
    );
    await started.promise;

    expect((await engine.getRunStatus(run.runId))?.dag_status).toBe("RUNNING");
    release.resolve();
    expect((await run.result).status).toBe("SUCCESS");
  });

  test("成功 custom 节点会将输出写入结果和存储", async () => {
    // 验证结果 outputs 与 getOutput 都保留执行器的结构化输出。
    const engine = createEngine([tool("produce", async () => ({ stdout: "value", json: { count: 2 }, exit_code: 0 }))]);
    const result = await engine.run(
      yaml(`  - id: produce
    type: custom
    tool: produce`),
    );

    expect(result.outputs.produce).toEqual({ stdout: "value", json: { count: 2 }, exit_code: 0 });
    expect(await engine.getOutput(result.runId, "produce")).toEqual(result.outputs.produce);
  });

  test("执行器异常会使节点和 DAG 进入失败状态", async () => {
    // 验证业务异常被调度器转化为 FAILED 结果而不是逸出 run 调用。
    const engine = createEngine([tool("fail", async () => Promise.reject(new Error("预期失败")))]);
    const result = await engine.run(
      yaml(`  - id: fail
    type: custom
    tool: fail`),
    );
    const events = await engine.getEvents(result.runId, { nodeId: "fail" });

    expect(result.status).toBe("FAILED");
    expect((await engine.getRunStatus(result.runId))?.node_states.fail.status).toBe("FAILED");
    expect(events.some((event) => event.type === "node.failed")).toBe(true);
  });

  test("失败 custom 节点的 cleanup 接收错误且不接收结果", async () => {
    // 验证失败路径也保证插件资源清理，并正确传递结果与错误。
    const cleanup = Promise.withResolvers<{ result: NodeOutput | null; error: Error | null }>();
    const engine = createEngine([
      tool(
        "fail_with_cleanup",
        async () => Promise.reject(new Error("清理前失败")),
        async (_ctx, result, error) => cleanup.resolve({ result, error }),
      ),
    ]);
    await engine.run(
      yaml(`  - id: fail
    type: custom
    tool: fail_with_cleanup`),
    );

    expect(await cleanup.promise).toMatchObject({ result: null, error: { message: "清理前失败" } });
  });

  test("成功 custom 节点的 cleanup 接收结果且不接收错误", async () => {
    // 验证成功路径同样执行 cleanup，并传递原始节点输出。
    const cleanup = Promise.withResolvers<{ result: NodeOutput | null; error: Error | null }>();
    const engine = createEngine([
      tool(
        "succeed_with_cleanup",
        async () => ({ stdout: "clean", exit_code: 0 }),
        async (_ctx, result, error) => cleanup.resolve({ result, error }),
      ),
    ]);
    await engine.run(
      yaml(`  - id: succeed
    type: custom
    tool: succeed_with_cleanup`),
    );

    expect(await cleanup.promise).toEqual({ result: { stdout: "clean", exit_code: 0 }, error: null });
  });

  test("取消已完成运行会返回 RUN_NOT_FOUND", async () => {
    // 验证终态运行已从 activeRuns 清理，不能被再次取消。
    const engine = createEngine([tool("done", async () => ({ stdout: "done", exit_code: 0 }))]);
    const result = await engine.run(
      yaml(`  - id: done
    type: custom
    tool: done`),
    );

    await expect(engine.cancel(result.runId)).rejects.toMatchObject({ code: WorkflowErrorCode.RUN_NOT_FOUND });
  });

  test("审批字符串数据会作为审批节点输出保存", async () => {
    // 验证 approveNode 对字符串数据保留 stdout，并驱动下游节点完成。
    const engine = createEngine([tool("after", async () => ({ stdout: "after", exit_code: 0 }))]);
    const suspended = await engine.run(
      yaml(`  - id: approval
    type: audit
    display_data: { message: 请审批 }
  - id: after
    type: custom
    tool: after
    depends_on: [approval]`),
    );
    const [pending] = await engine.getPendingApprovals(suspended.runId);
    const resumed = await engine.approveNode(suspended.runId, pending.nodeId, pending.approvalToken, "已批准");

    expect(resumed.status).toBe("SUCCESS");
    expect(resumed.outputs.approval).toEqual({
      stdout: "已批准",
      json: { approved: "已批准" },
      exit_code: 0,
    });
    expect((await engine.getOutput(suspended.runId, "after"))?.stdout).toBe("after");
  });

  test("审批后事件查询只返回指定审批节点的事件", async () => {
    // 验证事件 nodeId 过滤包含审批请求与审批完成，但不混入 DAG 事件。
    const engine = createEngine([]);
    const suspended = await engine.run(
      yaml(`  - id: approval
    type: audit
    display_data: { message: 请审批 }`),
    );
    const [pending] = await engine.getPendingApprovals(suspended.runId);
    await engine.approveNode(suspended.runId, pending.nodeId, pending.approvalToken);
    const events = await engine.getEvents(suspended.runId, { nodeId: "approval" });

    expect(events.map((event) => event.type)).toEqual(["audit.requested", "audit.approved"]);
  });

  test("recover 已成功运行不会重新执行完成节点", async () => {
    // 验证终态恢复直接复用快照和输出，保证恢复操作幂等。
    let executions = 0;
    const engine = createEngine([
      tool("once", async () => {
        executions += 1;
        return { stdout: String(executions), exit_code: 0 };
      }),
    ]);
    const workflow = yaml(`  - id: once
    type: custom
    tool: once`);
    const original = await engine.run(workflow);
    const recovered = await engine.recover(original.runId, workflow);

    expect(recovered.status).toBe("SUCCESS");
    expect((await engine.getOutput(original.runId, "once"))?.stdout).toBe("1");
    expect(executions).toBe(1);
  });

  test("rerunFrom 缺失历史快照返回恢复错误", async () => {
    // 验证重跑入口在读取不存在的前序运行时提供明确的恢复错误码。
    const engine = createEngine([]);

    await expect(engine.rerunFrom("run_missing", yaml(""), "missing")).rejects.toMatchObject({
      code: WorkflowErrorCode.RECOVERY_ERROR,
    });
  });
});
