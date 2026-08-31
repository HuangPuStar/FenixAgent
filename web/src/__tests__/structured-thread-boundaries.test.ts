import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { structuredToThreadEntries } from "../lib/structured-to-thread";
import { getTodoChanges, getTodosFromRawInput, isTodoWriteToolCall, parseTodosFromRawInput } from "../lib/todo";
import type { TodoItem } from "../lib/types";

function tool(
  status: StructuredMessage extends never
    ? never
    : "running" | "complete" | "error" | "waiting_for_confirmation" | "canceled" | "rejected",
): Extract<StructuredMessage, { type: "tool_call" }> {
  return { id: `tool-${status}`, type: "tool_call", title: "Bash", status, content: [] };
}

function getToolStatus(
  status: "running" | "complete" | "error" | "waiting_for_confirmation" | "canceled" | "rejected",
) {
  const entry = structuredToThreadEntries([tool(status)])[0];
  if (entry?.type !== "tool_call") throw new Error("expected tool call entry");
  return entry.toolCall.status;
}

describe("structuredToThreadEntries 边界转换", () => {
  // 运行中的协议状态必须保持为前端运行态，避免工具卡片过早结束。
  test("保留 running 工具状态", () => {
    expect(getToolStatus("running")).toBe("running");
  });

  // 完成状态必须映射为完整终态，供工具卡片展示成功结果。
  test("保留 complete 工具状态", () => {
    expect(getToolStatus("complete")).toBe("complete");
  });

  // 失败状态必须映射为错误终态，不能误显示为仍在执行。
  test("保留 error 工具状态", () => {
    expect(getToolStatus("error")).toBe("error");
  });

  // 等待授权状态必须保留，权限交互才能显示在正确的工具卡片上。
  test("保留 waiting_for_confirmation 工具状态", () => {
    expect(getToolStatus("waiting_for_confirmation")).toBe("waiting_for_confirmation");
  });

  // 用户取消的协议状态必须映射为取消终态。
  test("保留 canceled 工具状态", () => {
    expect(getToolStatus("canceled")).toBe("canceled");
  });

  // 用户拒绝的协议状态必须映射为拒绝终态。
  test("保留 rejected 工具状态", () => {
    expect(getToolStatus("rejected")).toBe("rejected");
  });

  // assistant 消息必须保留消息 ID，保证 React 列表键稳定。
  test("保留 assistant 消息标识", () => {
    const entries = structuredToThreadEntries([
      { type: "assistant_message", id: "assistant-1", chunks: [], seq: 1, ts: 1 },
    ]);
    expect(entries[0]).toMatchObject({ type: "assistant_message", id: "assistant-1" });
  });

  // 思考与正文 chunk 必须按原顺序投影，不能合并而丢失渲染语义。
  test("保留 assistant chunk 的类型和顺序", () => {
    const entries = structuredToThreadEntries([
      {
        type: "assistant_message",
        id: "assistant-1",
        chunks: [
          { type: "thought", text: "思考" },
          { type: "message", text: "答复" },
        ],
        seq: 1,
        ts: 1,
      },
    ]);
    expect(entries[0]).toMatchObject({
      chunks: [
        { type: "thought", text: "思考" },
        { type: "message", text: "答复" },
      ],
    });
  });

  // assistant 脱敏错误应挂在对应消息上，供用户看到可安全展示的失败原因。
  test("保留 assistant 公开错误", () => {
    const error = {
      type: "AGENT_RUNTIME.REQUEST_FAILED" as const,
      id: "err_00000000000000000000000000000001",
      message: "The Agent request failed.",
    };
    const entries = structuredToThreadEntries([
      { type: "assistant_message", id: "assistant-1", chunks: [], seq: 1, ts: 1, error },
    ]);
    expect(entries[0]).toMatchObject({ error });
  });

  // 用户消息必须保留文本内容，不得因时间线转换丢失用户输入。
  test("保留用户消息内容", () => {
    const entries = structuredToThreadEntries([{ type: "user_message", id: "user-1", content: "你好", seq: 0, ts: 1 }]);
    expect(entries).toEqual([{ type: "user_message", id: "user-1", content: "你好" }]);
  });

  // 空用户文本仍是有效历史条目，转换层不能擅自删除。
  test("保留空用户消息", () => {
    const entries = structuredToThreadEntries([{ type: "user_message", id: "user-empty", content: "", seq: 0, ts: 1 }]);
    expect(entries).toEqual([{ type: "user_message", id: "user-empty", content: "" }]);
  });

  // 计划快照属于状态面板数据，不得混入聊天时间线。
  test("忽略单个计划快照", () => {
    const entries = structuredToThreadEntries([
      { type: "plan", id: "plan-1", entries: [{ content: "检查", priority: "low", status: "pending" }] },
    ]);
    expect(entries).toEqual([]);
  });

  // 工具内容块必须原样传给卡片渲染器，避免 diff 或终端结果丢失。
  test("保留工具内容块", () => {
    const content = [{ type: "content" as const, content: { type: "text", text: "输出" } }];
    const entries = structuredToThreadEntries([{ ...tool("complete"), content }]);
    const entry = entries[0];
    if (entry?.type !== "tool_call") throw new Error("expected tool call entry");
    expect(entry.toolCall.content).toEqual(content);
  });

  // 未提供 display 时应保持 undefined，避免卡片误进入特殊展示模式。
  test("缺失 display 时不生成展示元数据", () => {
    const entry = structuredToThreadEntries([tool("complete")])[0];
    if (entry?.type !== "tool_call") throw new Error("expected tool call entry");
    expect(entry.toolCall.display).toBeUndefined();
  });

  // display 的所有可选字段必须完整投影，供文件与差异卡片精确定位内容。
  test("保留完整 display 元数据", () => {
    const display = {
      type: "diff",
      path: "src/a.ts",
      lineStart: 1,
      lineEnd: 2,
      totalLines: 8,
      text: "x",
      truncated: true,
    };
    const entry = structuredToThreadEntries([{ ...tool("complete"), display }])[0];
    if (entry?.type !== "tool_call") throw new Error("expected tool call entry");
    expect(entry.toolCall.display).toEqual(display);
  });

  // 工具公开错误必须在卡片层保留，且不从其他字段推断内部错误。
  test("保留工具公开错误", () => {
    const publicError = {
      type: "ACTION.FAILED" as const,
      id: "err_00000000000000000000000000000001",
      message: "The action failed.",
    };
    const entry = structuredToThreadEntries([{ ...tool("error"), publicError }])[0];
    if (entry?.type !== "tool_call") throw new Error("expected tool call entry");
    expect(entry.toolCall.publicError).toEqual(publicError);
  });

  // 独立权限请求标志必须保持 false，而不是被 truthy 归一化为 undefined。
  test("保留 false 的独立权限标志", () => {
    const entry = structuredToThreadEntries([{ ...tool("complete"), isStandalonePermission: false }])[0];
    if (entry?.type !== "tool_call") throw new Error("expected tool call entry");
    expect(entry.toolCall.isStandalonePermission).toBe(false);
  });

  // 嵌套子消息必须递归投影，Task 工具才能展示子 Agent 的时间线。
  test("递归转换工具子消息", () => {
    const entry = structuredToThreadEntries([
      { ...tool("complete"), subMessages: [{ type: "user_message", id: "child", content: "子问题", seq: 0, ts: 1 }] },
    ])[0];
    if (entry?.type !== "tool_call") throw new Error("expected tool call entry");
    expect(entry.toolCall.subEntries).toEqual([{ type: "user_message", id: "child", content: "子问题" }]);
  });

  // 空消息序列应返回空时间线，不得制造占位条目。
  test("空消息列表转换为空时间线", () => {
    expect(structuredToThreadEntries([])).toEqual([]);
  });
});

describe("Todo 输入与差分边界", () => {
  // 无原始输入时不存在待办快照，调用方可据此跳过 Todo 差分。
  test("缺失原始输入返回 null", () => {
    expect(getTodosFromRawInput(undefined)).toBeNull();
  });

  // todos 字段不是数组时必须安全拒绝，不能把不可信对象当作待办列表。
  test("非数组 todos 返回 null", () => {
    expect(getTodosFromRawInput({ todos: "invalid" })).toBeNull();
  });

  // 兼容历史 tasks 字段，避免旧 Agent 的待办展示丢失。
  test("使用历史 tasks 字段", () => {
    expect(getTodosFromRawInput({ tasks: [{ content: "兼容", status: "completed" }] })).toEqual([
      { content: "兼容", status: "completed", activeForm: undefined },
    ]);
  });

  // todos 存在时必须优先于 tasks，保证新协议数据拥有确定性优先级。
  test("优先使用 todos 字段", () => {
    expect(getTodosFromRawInput({ todos: [], tasks: [{ content: "旧值", status: "pending" }] })).toEqual([]);
  });

  // 数组中的 null 和原始值必须被忽略，避免异常投影进入 UI。
  test("过滤非对象待办项", () => {
    expect(getTodosFromRawInput({ todos: [null, "text", 1] })).toEqual([]);
  });

  // 非字符串内容应显式字符串化，确保渲染层总能获得文本。
  test("字符串化数值内容", () => {
    expect(getTodosFromRawInput({ todos: [{ content: 42, status: "pending" }] })).toEqual([
      { content: "42", status: "pending", activeForm: undefined },
    ]);
  });

  // 缺失内容应降级为空字符串，而不是展示 undefined。
  test("缺失内容降级为空字符串", () => {
    expect(getTodosFromRawInput({ todos: [{ status: "pending" }] })).toEqual([
      { content: "", status: "pending", activeForm: undefined },
    ]);
  });

  // 未知状态必须回退 pending，防止非法协议状态破坏待办筛选。
  test("未知待办状态回退 pending", () => {
    expect(getTodosFromRawInput({ todos: [{ content: "x", status: "blocked" }] })).toEqual([
      { content: "x", status: "pending", activeForm: undefined },
    ]);
  });

  // 非字符串 activeForm 不能透传到视图模型。
  test("过滤非字符串 activeForm", () => {
    expect(getTodosFromRawInput({ todos: [{ content: "x", status: "pending", activeForm: 1 }] })).toEqual([
      { content: "x", status: "pending", activeForm: undefined },
    ]);
  });

  // 面板辅助函数应把不存在的待办安全转换为空数组。
  test("解析缺失待办为空数组", () => {
    expect(parseTodosFromRawInput({})).toEqual([]);
  });

  // TodoWrite 名称匹配必须大小写无关。
  test("大小写无关识别 TodoWrite", () => {
    expect(isTodoWriteToolCall("todoWRITE", {})).toBe(true);
  });

  // 下划线形式是协议支持的 Todo 工具别名。
  test("识别 todo_write 别名", () => {
    expect(isTodoWriteToolCall("todo_write", {})).toBe(true);
  });

  // 没有原始输入时即使名称匹配也不能生成 Todo 差分。
  test("缺失输入时不识别 TodoWrite 调用", () => {
    expect(isTodoWriteToolCall("TodoWrite")).toBe(false);
  });

  // 非 Todo 工具即使携带 todos 字段也不得被误判。
  test("普通工具不识别为 TodoWrite", () => {
    expect(isTodoWriteToolCall("Bash", { todos: [] })).toBe(false);
  });

  // 两份空快照之间没有变更，历史卡片不应显示空变更项。
  test("空快照比较不产生变更", () => {
    expect(getTodoChanges([], [])).toEqual([]);
  });

  // 首次收到待办快照时每项均应标记为新增。
  test("首次快照标记全部待办为新增", () => {
    const todo: TodoItem = { content: "实现", status: "pending" };
    expect(getTodoChanges([], [todo])).toEqual([{ id: "added:实现::0", kind: "added", todo }]);
  });

  // 原快照中消失的待办必须标记移除，以反映最新完整快照。
  test("消失的待办标记为移除", () => {
    const todo: TodoItem = { content: "旧项", status: "pending" };
    expect(getTodoChanges([todo], [])).toEqual([{ id: "removed:旧项::0", kind: "removed", todo }]);
  });

  // pending 到 in_progress 的迁移必须按当前状态标记。
  test("待办进入进行中状态", () => {
    expect(
      getTodoChanges([{ content: "x", status: "pending" }], [{ content: "x", status: "in_progress" }])[0]?.kind,
    ).toBe("in_progress");
  });

  // in_progress 到 completed 的迁移必须按当前状态标记。
  test("待办进入完成状态", () => {
    expect(
      getTodoChanges([{ content: "x", status: "in_progress" }], [{ content: "x", status: "completed" }])[0]?.kind,
    ).toBe("completed");
  });

  // activeForm 变化但状态不变时应标记更新，而不是误报状态变更。
  test("活动文案变化标记更新", () => {
    expect(
      getTodoChanges(
        [{ content: "x", status: "pending", activeForm: "旧文案" }],
        [{ content: "x", status: "pending", activeForm: "新文案" }],
      )[0]?.kind,
    ).toBe("updated");
  });

  // 完全相同的待办不应重复产生历史差分。
  test("相同待办不产生变更", () => {
    const todo: TodoItem = { content: "x", status: "pending", activeForm: "处理中" };
    expect(getTodoChanges([todo], [todo])).toEqual([]);
  });

  // 同名待办需按出现顺序一一配对，避免重复项被错误移除。
  test("重复内容按出现顺序配对", () => {
    expect(
      getTodoChanges(
        [
          { content: "x", status: "pending" },
          { content: "x", status: "completed" },
        ],
        [
          { content: "x", status: "in_progress" },
          { content: "x", status: "completed" },
        ],
      ),
    ).toMatchObject([{ kind: "in_progress", todo: { content: "x", status: "in_progress" } }]);
  });

  // 同一类重复新增项必须有不同 ID，避免 React key 冲突。
  test("重复新增项生成唯一变更标识", () => {
    expect(
      getTodoChanges(
        [],
        [
          { content: "x", status: "pending" },
          { content: "x", status: "pending" },
        ],
      ).map((change) => change.id),
    ).toEqual(["added:x::0", "added:x::1"]);
  });

  // 内容改名没有稳定 ID 可关联，必须显式表达为移除旧项与新增新项。
  test("内容改名表示为移除和新增", () => {
    expect(
      getTodoChanges([{ content: "旧名称", status: "pending" }], [{ content: "新名称", status: "pending" }]).map(
        (change) => change.kind,
      ),
    ).toEqual(["added", "removed"]);
  });

  // 差分计算不能修改调用方持有的原待办数组，保证历史快照可复用。
  test("差分计算不修改输入数组", () => {
    const previous: TodoItem[] = [{ content: "x", status: "pending" }];
    const current: TodoItem[] = [{ content: "x", status: "completed" }];
    getTodoChanges(previous, current);
    expect(previous).toEqual([{ content: "x", status: "pending" }]);
    expect(current).toEqual([{ content: "x", status: "completed" }]);
  });
});
