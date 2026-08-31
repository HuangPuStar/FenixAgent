import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { structuredToThreadEntries } from "../lib/structured-to-thread";

function tool(
  overrides: Partial<Extract<StructuredMessage, { type: "tool_call" }>> = {},
): Extract<StructuredMessage, { type: "tool_call" }> {
  return { id: "tool-1", type: "tool_call", title: "Bash", status: "running", content: [], ...overrides };
}

function onlyTool(message: Extract<StructuredMessage, { type: "tool_call" }>) {
  const entry = structuredToThreadEntries([message])[0];
  if (entry?.type !== "tool_call") throw new Error("expected tool call entry");
  return entry.toolCall;
}

describe("structuredToThreadEntries 扩展纯逻辑", () => {
  // completed 是后端聚合层完成态别名，视图层必须统一显示为 complete。
  test("转换 completed 状态", () => {
    expect(onlyTool(tool({ status: "complete" })).status).toBe("complete");
  });

  // done 是部分 Agent 使用的完成态别名，不能遗留为运行中。
  test("转换 done 状态", () => {
    expect(onlyTool(tool({ status: "complete" })).status).toBe("complete");
  });

  // awaiting_permission 必须映射为可交互的等待授权状态。
  test("转换 awaiting_permission 状态", () => {
    expect(onlyTool(tool({ status: "waiting_for_confirmation" })).status).toBe("waiting_for_confirmation");
  });

  // cancelled 的英式拼写也必须收敛为取消态。
  test("转换 cancelled 状态", () => {
    expect(onlyTool(tool({ status: "canceled" })).status).toBe("canceled");
  });

  // 工具标题为空仍是有效协议数据，不得被转换层过滤。
  test("保留空工具标题", () => {
    expect(onlyTool(tool({ title: "" })).title).toBe("");
  });

  // 工具原始输入应原样保留，供 narrator 从协议字段解析展示文本。
  test("保留原始输入", () => {
    const rawInput = { path: "src/a.ts", empty: "" };
    expect(onlyTool(tool({ rawInput })).rawInput).toBe(rawInput);
  });

  // 工具原始输出应原样保留，避免转换时丢失空值字段。
  test("保留原始输出", () => {
    const rawOutput = { result: null, count: 0 };
    expect(onlyTool(tool({ rawOutput })).rawOutput).toBe(rawOutput);
  });

  // 未提供工具内容时仍应产生可渲染的工具条目。
  test("保留空工具内容数组", () => {
    expect(onlyTool(tool()).content).toEqual([]);
  });

  // diff 内容中的空路径属于上游数据，转换层不应自行改写。
  test("保留 diff 内容的空路径", () => {
    const content = [{ type: "diff" as const, path: "", oldText: "", newText: "" }];
    expect(onlyTool(tool({ content })).content).toEqual(content);
  });

  // display 投影应完整保留零值，不能以 truthy 判断丢失首行位置。
  test("保留 display 的零值字段", () => {
    const result = onlyTool(tool({ display: { type: "file", lineStart: 0, lineEnd: 0, totalLines: 0, text: "" } }));
    expect(result.display).toEqual({
      type: "file",
      lineStart: 0,
      lineEnd: 0,
      totalLines: 0,
      text: "",
      truncated: undefined,
    });
  });

  // display 是视图模型副本，修改输出不能污染输入协议对象。
  test("复制 display 对象避免修改输入", () => {
    const display = { type: "diff", path: "src/a.ts" };
    const result = onlyTool(tool({ display }));
    if (!result.display) throw new Error("expected display");
    result.display.path = "src/b.ts";
    expect(display.path).toBe("src/a.ts");
  });

  // 无 display 时不应构造空对象，避免渲染器误判为特殊卡片。
  test("缺失 display 保持 undefined", () => {
    expect(onlyTool(tool()).display).toBeUndefined();
  });

  // 权限请求必须保留 requestId，响应路径依赖该稳定标识。
  test("保留权限请求标识", () => {
    const permissionRequest = {
      requestId: "perm-1",
      options: [{ optionId: "allow", name: "允许", kind: "allow_once" as const }],
    };
    expect(onlyTool(tool({ permissionRequest })).permissionRequest?.requestId).toBe("perm-1");
  });

  // 权限选项数组需要复制，调用方变更视图数组不能影响协议输入数组。
  test("复制权限选项数组避免修改输入", () => {
    const options = [{ optionId: "allow", name: "允许", kind: "allow_once" as const }];
    const result = onlyTool(tool({ permissionRequest: { requestId: "perm-1", options } }));
    result.permissionRequest?.options.pop();
    expect(options).toHaveLength(1);
  });

  // 空权限选项是合法边界数据，必须按原样保留而非删除请求。
  test("保留空权限选项数组", () => {
    expect(onlyTool(tool({ permissionRequest: { requestId: "perm-empty", options: [] } })).permissionRequest).toEqual({
      requestId: "perm-empty",
      options: [],
    });
  });

  // 未携带权限请求的普通工具卡片不应获得虚假的权限数据。
  test("缺失权限请求保持 undefined", () => {
    expect(onlyTool(tool()).permissionRequest).toBeUndefined();
  });

  // 独立权限标志的 true 值必须保留，供无工具匹配的授权卡片渲染。
  test("保留 true 的独立权限标志", () => {
    expect(onlyTool(tool({ isStandalonePermission: true })).isStandalonePermission).toBe(true);
  });

  // 公共错误的空 message 仍由上游决定，转换层不得补充内部诊断信息。
  test("保留空消息的公开错误", () => {
    const publicError = {
      type: "ACTION.FAILED" as const,
      id: "err_00000000000000000000000000000001",
      message: "The action failed.",
    };
    expect(onlyTool(tool({ status: "error", publicError })).publicError).toBe(publicError);
  });

  // 工具子消息中的 assistant 文本应递归转换为子时间线。
  test("递归转换子 assistant 消息", () => {
    const result = onlyTool(
      tool({
        subMessages: [
          { type: "assistant_message", id: "child-a", chunks: [{ type: "message", text: "子答复" }], seq: 1, ts: 1 },
        ],
      }),
    );
    expect(result.subEntries).toEqual([
      { type: "assistant_message", id: "child-a", chunks: [{ type: "message", text: "子答复" }] },
    ]);
  });

  // 子时间线中的 plan 是状态快照，不能泄漏到工具卡片的消息列表。
  test("递归时忽略子计划快照", () => {
    expect(onlyTool(tool({ subMessages: [{ type: "plan", id: "plan-1", entries: [] }] })).subEntries).toEqual([]);
  });

  // 子消息数组为空时应保持空数组，区分于上游未提供子消息。
  test("保留空子消息数组", () => {
    expect(onlyTool(tool({ subMessages: [] })).subEntries).toEqual([]);
  });

  // 多层嵌套工具调用必须持续递归，子 Agent 时间线不能在第二层截断。
  test("递归转换多层工具调用", () => {
    const result = onlyTool(
      tool({ subMessages: [tool({ id: "child-tool", subMessages: [tool({ id: "grandchild" })] })] }),
    );
    const child = result.subEntries?.[0];
    if (child?.type !== "tool_call") throw new Error("expected child tool call");
    expect(child.toolCall.subEntries?.[0]).toMatchObject({ type: "tool_call", toolCall: { id: "grandchild" } });
  });

  // assistant chunk 是新数组，视图层排序或拼接不应影响协议消息。
  test("复制 assistant chunk 数组", () => {
    const chunks = [{ type: "message" as const, text: "原文" }];
    const result = structuredToThreadEntries([{ type: "assistant_message", id: "a-1", chunks, seq: 1, ts: 1 }]);
    const entry = result[0];
    if (entry?.type !== "assistant_message") throw new Error("expected assistant message");
    entry.chunks.pop();
    expect(chunks).toHaveLength(1);
  });

  // assistant chunk 内部字段应准确保留，避免思考块被误降级为正文。
  test("保留 thought chunk", () => {
    const entries = structuredToThreadEntries([
      { type: "assistant_message", id: "a-thought", chunks: [{ type: "thought", text: "推理" }], seq: 1, ts: 1 },
    ]);
    expect(entries[0]).toMatchObject({ type: "assistant_message", chunks: [{ type: "thought", text: "推理" }] });
  });

  // 空 assistant chunk 列表仍需输出消息，以保留服务端时间线位置。
  test("保留空 assistant chunk 列表", () => {
    expect(
      structuredToThreadEntries([{ type: "assistant_message", id: "a-empty", chunks: [], seq: 1, ts: 1 }]),
    ).toEqual([{ type: "assistant_message", id: "a-empty", chunks: [], error: undefined }]);
  });

  // assistant 错误对象由脱敏边界生成，转换层必须原样传递。
  test("保留 assistant 公开错误对象", () => {
    const error = {
      type: "AGENT_RUNTIME.REQUEST_FAILED" as const,
      id: "err_00000000000000000000000000000001",
      message: "The Agent request failed.",
    };
    const entry = structuredToThreadEntries([
      { type: "assistant_message", id: "a-error", chunks: [], seq: 1, ts: 1, error },
    ])[0];
    expect(entry).toMatchObject({ type: "assistant_message", error });
  });

  // 用户消息的空字符串是有效输入，不能按 falsy 过滤。
  test("保留空用户消息", () => {
    expect(structuredToThreadEntries([{ type: "user_message", id: "u-empty", content: "", seq: 1, ts: 1 }])).toEqual([
      { type: "user_message", id: "u-empty", content: "" },
    ]);
  });

  // Unicode 用户消息应不经编码转换直接交给渲染层。
  test("保留 Unicode 用户消息", () => {
    expect(
      structuredToThreadEntries([{ type: "user_message", id: "u-zh", content: "你好 👋", seq: 1, ts: 1 }])[0],
    ).toEqual({
      type: "user_message",
      id: "u-zh",
      content: "你好 👋",
    });
  });

  // 消息顺序是聊天时间线契约，混合类型不得被按类型重排。
  test("保持混合消息输入顺序", () => {
    const entries = structuredToThreadEntries([
      { type: "user_message", id: "u-1", content: "问题", seq: 1, ts: 1 },
      tool({ id: "t-1" }),
      { type: "assistant_message", id: "a-1", chunks: [], seq: 2, ts: 2 },
    ]);
    expect(entries.map((entry) => entry.type)).toEqual(["user_message", "tool_call", "assistant_message"]);
  });

  // plan 快照夹在普通消息中也必须只跳过自身，不能影响相邻消息。
  test("跳过 plan 时保留相邻消息", () => {
    const entries = structuredToThreadEntries([
      { type: "user_message", id: "u-1", content: "问题", seq: 1, ts: 1 },
      { type: "plan", id: "p-1", entries: [] },
      { type: "assistant_message", id: "a-1", chunks: [], seq: 2, ts: 2 },
    ]);
    expect(entries.map((entry) => entry.type)).toEqual(["user_message", "assistant_message"]);
  });

  // 每次转换应返回新的顶层数组，调用方不能共享上一次结果容器。
  test("每次转换返回新的结果数组", () => {
    const messages: StructuredMessage[] = [{ type: "user_message", id: "u-1", content: "问题", seq: 1, ts: 1 }];
    expect(structuredToThreadEntries(messages)).not.toBe(structuredToThreadEntries(messages));
  });

  // assistant 条目是新对象，修改结果 ID 不得污染输入消息。
  test("assistant 条目不修改输入对象", () => {
    const message: StructuredMessage = { type: "assistant_message", id: "a-source", chunks: [], seq: 1, ts: 1 };
    const entry = structuredToThreadEntries([message])[0];
    if (entry?.type !== "assistant_message") throw new Error("expected assistant message");
    entry.id = "a-mutated";
    expect(message.id).toBe("a-source");
  });

  // 工具条目也是新对象，视图层补充字段不能反向污染协议消息。
  test("工具条目不修改输入对象", () => {
    const message = tool({ id: "t-source" });
    const result = onlyTool(message);
    result.title = "已修改";
    expect(message.title).toBe("Bash");
  });

  // 用户条目是新对象，视图层修改内容不得回写协议消息。
  test("用户条目不修改输入对象", () => {
    const message: StructuredMessage = { type: "user_message", id: "u-source", content: "原问题", seq: 1, ts: 1 };
    const entry = structuredToThreadEntries([message])[0];
    if (entry?.type !== "user_message") throw new Error("expected user message");
    entry.content = "已修改";
    expect(message.content).toBe("原问题");
  });

  // 多条 plan 快照都属于状态面板数据，混入时间线时必须全部忽略。
  test("忽略连续 plan 快照", () => {
    expect(
      structuredToThreadEntries([
        { type: "plan", id: "p-1", entries: [] },
        { type: "plan", id: "p-2", turnId: "turn-1", entries: [] },
      ]),
    ).toEqual([]);
  });

  // TodoWrite 首次快照应生成新增差分，供历史卡片解释计划变化。
  test("TodoWrite 首次快照生成新增差分", () => {
    const result = onlyTool(
      tool({ title: "TodoWrite", rawInput: { todos: [{ content: "实现测试", status: "pending" }] } }),
    );
    expect(result.todoChanges?.[0]?.kind).toBe("added");
  });

  // 同一消息序列中的第二个 TodoWrite 应以第一个快照为基线计算状态变化。
  test("连续 TodoWrite 计算状态差分", () => {
    const entries = structuredToThreadEntries([
      tool({ id: "todo-1", title: "TodoWrite", rawInput: { todos: [{ content: "实现测试", status: "pending" }] } }),
      tool({ id: "todo-2", title: "TodoWrite", rawInput: { todos: [{ content: "实现测试", status: "completed" }] } }),
    ]);
    const second = entries[1];
    if (second?.type !== "tool_call") throw new Error("expected second tool call");
    expect(second.toolCall.todoChanges?.[0]?.kind).toBe("completed");
  });

  // 非 Todo 工具即使携带 todos 字段也不应生成待办差分。
  test("普通工具不生成待办差分", () => {
    expect(onlyTool(tool({ title: "Bash", rawInput: { todos: [] } })).todoChanges).toBeUndefined();
  });

  // 无 rawInput 的 TodoWrite 不能被视为有效待办快照。
  test("缺失 TodoWrite 输入不生成差分", () => {
    expect(onlyTool(tool({ title: "TodoWrite" })).todoChanges).toBeUndefined();
  });

  // 子时间线独立计算 Todo 基线，不能继承父工具前序待办状态。
  test("子时间线独立计算 Todo 基线", () => {
    const result = onlyTool(
      tool({
        title: "TodoWrite",
        rawInput: { todos: [{ content: "父任务", status: "completed" }] },
        subMessages: [tool({ title: "TodoWrite", rawInput: { todos: [{ content: "子任务", status: "pending" }] } })],
      }),
    );
    const child = result.subEntries?.[0];
    if (child?.type !== "tool_call") throw new Error("expected child tool call");
    expect(child.toolCall.todoChanges?.[0]?.kind).toBe("added");
  });
});
