import { describe, expect, test } from "bun:test";
import { EndExecutor } from "../../executor/end-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { EndNodeDef } from "../../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";

function createContext(inputs?: Record<string, unknown>): NodeExecutionContext {
  return {
    runId: "run-end-protocol",
    params: {},
    secrets: {},
    resolvedInputs: inputs === undefined ? {} : { inputs },
    signal: AbortSignal.timeout(30_000),
    storage: createInMemoryStorage(),
  };
}

function createNode(overrides?: Partial<EndNodeDef>): EndNodeDef {
  return { id: "end-result", type: "end", ...overrides };
}

async function execute(inputs?: Record<string, unknown>, node?: EndNodeDef) {
  const ctx = createContext(inputs);
  const output = await new EndExecutor().execute(node ?? createNode(), ctx);
  return { ctx, output };
}

describe("EndExecutor 协议状态", () => {
  // 空输入必须收敛为可序列化的空最终结果。
  test("空输入输出空对象并写入开始和完成事件", async () => {
    const { ctx, output } = await execute();

    expect(output).toEqual({ stdout: "{}", json: {}, exit_code: 0, size: 2 });
    expect((await ctx.storage.getEvents(ctx.runId)).map((event) => event.type)).toEqual([
      "node.started",
      "node.completed",
    ]);
  });

  // 包装值是调度器传给 end 节点的标准输入协议。
  test("解包单个 resolved input 的 value", async () => {
    const { output } = await execute({ result: { value: "done", rawExpression: "${{ nodes.task.output }}" } });

    expect(output.json).toEqual({ result: "done" });
    expect(output.stdout).toBe('{"result":"done"}');
  });

  // 调度器也允许原始值直通，最终输出不能丢失它。
  test("保留未包装的原始输入值", async () => {
    const { output } = await execute({ count: 3, enabled: false });

    expect(output.json).toEqual({ count: 3, enabled: false });
  });

  // null 不满足包装对象条件，应作为业务值原样保留。
  test("保留 null 输入", async () => {
    const { output } = await execute({ nullable: null });

    expect(output.json).toEqual({ nullable: null });
  });

  // 数组是合法上游输出，不能因 object 分支而被误解包。
  test("保留数组输入", async () => {
    const { output } = await execute({ items: ["first", "second"] });

    expect(output.json).toEqual({ items: ["first", "second"] });
  });

  // value 可承载嵌套 JSON，解包后必须保持完整结构。
  test("解包嵌套对象值", async () => {
    const { output } = await execute({
      payload: { value: { id: "job-1", tags: ["stable"] }, rawExpression: "upstream" },
    });

    expect(output.json).toEqual({ payload: { id: "job-1", tags: ["stable"] } });
  });

  // 仅含 value 的对象也属于兼容的包装格式。
  test("解包仅含 value 的兼容包装对象", async () => {
    const { output } = await execute({ answer: { value: 42 } });

    expect(output.json).toEqual({ answer: 42 });
  });

  // 不含 value 的普通对象属于业务数据，不得被转换。
  test("保留不含 value 字段的普通对象", async () => {
    const { output } = await execute({ metadata: { source: "manual" } });

    expect(output.json).toEqual({ metadata: { source: "manual" } });
  });

  // value 字段存在时以其值为权威，即使值为 undefined。
  test("保留包装对象中的 undefined 值", async () => {
    const { output } = await execute({ omitted: { value: undefined, rawExpression: "missing" } });

    expect(output.json).toEqual({ omitted: undefined });
    expect(output.stdout).toBe("{}");
  });

  // 输出字节数是协议元数据，必须按 UTF-8 而非字符数统计。
  test("按 UTF-8 字节数计算中文输出大小", async () => {
    const { output } = await execute({ message: "完成" });

    expect(output.size).toBe(Buffer.byteLength('{"message":"完成"}', "utf-8"));
  });

  // 开始事件应携带 end 节点身份，便于审计回放。
  test("开始事件记录运行和节点身份", async () => {
    const { ctx } = await execute({ result: "ok" }, createNode({ id: "final-node" }));
    const [started] = await ctx.storage.getEvents(ctx.runId, { types: ["node.started"] });

    expect(started).toMatchObject({ run_id: "run-end-protocol", node_id: "final-node", node_type: "end" });
  });

  // 完成事件的大小元数据必须和实际返回值一致。
  test("完成事件记录实际输出大小", async () => {
    const { ctx, output } = await execute({ result: "ok" });
    const [completed] = await ctx.storage.getEvents(ctx.runId, { types: ["node.completed"] });

    expect(completed?.metadata).toEqual({ exit_code: 0, output_size: output.size });
  });

  // 非 end 节点是调用方协议错误，不得写入半完成事件。
  test("拒绝非 end 节点且不产生事件", async () => {
    const ctx = createContext({ result: "ignored" });
    const invalidNode = { id: "transform-node", type: "transform", output: {} };

    await expect(new EndExecutor().execute(invalidNode, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
      message: "EndExecutor only handles 'end' nodes, got 'transform'",
    } satisfies Partial<WorkflowError>);
    expect(await ctx.storage.getEvents(ctx.runId)).toEqual([]);
  });

  // 多字段输入必须保持调度器提供的字段顺序以稳定 stdout 协议。
  test("按输入字段顺序生成稳定 JSON", async () => {
    const { output } = await execute({ first: 1, second: { value: 2, rawExpression: "two" }, third: 3 });

    expect(output.stdout).toBe('{"first":1,"second":2,"third":3}');
  });
});
