import { describe, expect, test } from "bun:test";
import { type ForwardYjsActionDependencies, flushPendingYjsActions, forwardYjsAction } from "../channel/action-forward";
import { createTestRpcReservationFactory } from "../channel/connection-test-helpers";
import type { SessionChannel, SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";

type Invocation = { entry: SessionConnection; action: Record<string, unknown> };

function createEntry(rcsSessionId = "rcs-test"): SessionConnection {
  return {
    userId: "user-test",
    agentId: "agent-test",
    instanceId: "instance-test",
    rcsSessionId,
    acpSessionId: null,
    agentStatusReceived: false,
    sessionLoaded: false,
    workspacePath: null,
    sendToRelay: () => undefined,
    reserveRpc: createTestRpcReservationFactory(),
  };
}

function createDependencies(
  handleAction: (entry: SessionConnection, action: Record<string, unknown>) => Promise<void>,
): {
  dependencies: ForwardYjsActionDependencies;
  invocations: Invocation[];
  acknowledgements: ActionAck[];
  errors: ActionError[];
  reports: Array<[string, unknown]>;
  logs: string[];
} {
  const invocations: Invocation[] = [];
  const acknowledgements: ActionAck[] = [];
  const errors: ActionError[] = [];
  const reports: Array<[string, unknown]> = [];
  const logs: string[] = [];
  const sessionChannel = {
    async handleAction(
      entry: SessionConnection,
      action: Record<string, unknown>,
      sinks: { sendAck: (ack: ActionAck) => void; sendError: (error: ActionError) => void },
    ) {
      invocations.push({ entry, action });
      await handleAction(entry, action);
      sinks.sendAck({
        type: "action_ack",
        commandId: typeof action.commandId === "string" ? action.commandId : "",
        status: "committed",
      });
    },
  } as SessionChannel;

  return {
    dependencies: {
      sessionChannel,
      sendAck: (ack) => acknowledgements.push(ack),
      sendError: (error) => errors.push(error),
      reportError: (message, error) => reports.push([message, error]),
      reportLog: (message) => logs.push(message),
    },
    invocations,
    acknowledgements,
    errors,
    reports,
    logs,
  };
}

describe("action-forward 协议、错误隔离与缓冲清理", () => {
  // 各种已知业务动作都必须保持原始字段并转发给会话通道。
  test.each([
    "send_prompt",
    "cancel",
    "create_session",
    "load_session",
    "resume_session",
    "list_sessions",
    "rename_session",
    "delete_session",
    "respond_permission",
    "respond_question",
    "set_session_mode",
    "future_action",
  ])("转发 %s 动作且保留协议字段", async (actionName) => {
    const fixture = createDependencies(async () => undefined);
    const entry = createEntry();
    const action = { action: actionName, commandId: `cmd-${actionName}`, payload: { value: actionName } };

    await forwardYjsAction(entry, action, fixture.dependencies);

    expect(fixture.invocations).toEqual([{ entry, action }]);
    expect(fixture.acknowledgements).toEqual([
      { type: "action_ack", commandId: `cmd-${actionName}`, status: "committed" },
    ]);
    expect(fixture.errors).toEqual([]);
  });

  // commandId 的不同合法形态不得被转发层修改或丢失。
  test.each([
    ["空字符串", ""],
    ["短标识", "a"],
    ["UUID", "e4c2fa7a-0fa7-4b1a-b47f-ecf4b7fbd4b0"],
    ["Unicode 标识", "命令-一"],
    ["带句点标识", "cmd.v1"],
    ["带斜杠标识", "cmd/child"],
    ["长标识", "command-000000000000000000000000000000000000000000000000000000000000"],
  ])("转发 %s commandId", async (_name, commandId) => {
    const fixture = createDependencies(async () => undefined);
    const action = { action: "send_prompt", commandId, text: "hello" };

    await forwardYjsAction(createEntry(), action, fixture.dependencies);

    expect(fixture.invocations[0]?.action).toBe(action);
    expect(fixture.acknowledgements[0]?.commandId).toBe(commandId);
  });

  // 非字符串 commandId 的异常必须归一为安全空标识，不能泄漏任意对象内容。
  test.each([
    ["缺失 commandId", {}],
    ["数字 commandId", { commandId: 7 }],
    ["空值 commandId", { commandId: null }],
    ["布尔 commandId", { commandId: true }],
    ["数组 commandId", { commandId: ["secret"] }],
    ["对象 commandId", { commandId: { internal: "secret" } }],
  ])("失败时将%s归一为安全错误", async (_name, extra) => {
    const failure = new Error("internal transport detail");
    const fixture = createDependencies(async () => Promise.reject(failure));
    const action = { action: "send_prompt", ...extra };

    await forwardYjsAction(createEntry("rcs-isolated"), action, fixture.dependencies);

    expect(fixture.errors).toMatchObject([
      { type: "action_error", commandId: "", error: { type: "INTERNAL.UNCLASSIFIED" } },
    ]);
    expect(fixture.reports).toEqual([["[YJS-FE] failed to process action before relay forward", "Error"]]);
    expect(JSON.parse(fixture.logs[0] ?? "{}")).toMatchObject({
      event: "chat.error",
      errorId: fixture.errors[0]?.error.id,
      errorType: "INTERNAL.UNCLASSIFIED",
      stage: "action.forward",
    });
  });

  // 失败报告仅保留 Error 名称，避免将内部错误消息回传或写入诊断上下文。
  test.each([
    ["字符串", "unavailable", "string"],
    ["数字", 503, "number"],
    ["空值", null, "object"],
    ["对象", { token: "private" }, "object"],
    ["布尔值", false, "boolean"],
  ])("隔离%s形式的非 Error 抛出值", async (_name, thrown, expectedKind) => {
    const fixture = createDependencies(async () => Promise.reject(thrown));

    await forwardYjsAction(createEntry(), { action: "cancel", commandId: "cmd-cancel" }, fixture.dependencies);

    expect(fixture.errors[0]).toMatchObject({ commandId: "cmd-cancel", error: { type: "INTERNAL.UNCLASSIFIED" } });
    expect(fixture.reports[0]?.[1]).toBe(expectedKind);
  });

  // 缓冲重放必须按输入顺序转发所有可执行动作。
  test.each([
    ["单条 prompt", ['{"action":"send_prompt","commandId":"one"}'], ["send_prompt"]],
    [
      "两条不同动作",
      ['{"action":"create_session","commandId":"one"}', '{"action":"load_session","commandId":"two"}'],
      ["create_session", "load_session"],
    ],
    [
      "三条不同动作",
      [
        '{"action":"send_prompt","commandId":"one"}',
        '{"action":"cancel","commandId":"two"}',
        '{"action":"resume_session","commandId":"three"}',
      ],
      ["send_prompt", "cancel", "resume_session"],
    ],
    ["未知动作", ['{"action":"future_action","commandId":"one"}'], ["future_action"]],
    ["含额外字段", ['{"action":"rename_session","commandId":"one","name":"新名称"}'], ["rename_session"]],
    ["空动作名称", ['{"action":"","commandId":"one"}'], []],
    ["缺失动作名称", ['{"commandId":"one"}'], []],
    ["布尔动作名称", ['{"action":true,"commandId":"one"}'], [true]],
    ["数字动作名称", ['{"action":1,"commandId":"one"}'], [1]],
    ["list_sessions", ['{"action":"list_sessions","commandId":"one"}'], []],
    [
      "list_sessions 与业务动作",
      ['{"action":"list_sessions","commandId":"one"}', '{"action":"send_prompt","commandId":"two"}'],
      ["send_prompt"],
    ],
    [
      "业务动作与 list_sessions",
      ['{"action":"cancel","commandId":"one"}', '{"action":"list_sessions","commandId":"two"}'],
      ["cancel"],
    ],
    ["损坏 JSON", ["{bad-json"], []],
    ["损坏后恢复", ["{bad-json", '{"action":"send_prompt","commandId":"two"}'], ["send_prompt"]],
    ["对象动作", ['{"action":{"name":"x"},"commandId":"one"}'], [{ name: "x" }]],
    ["数组动作", ['{"action":["x"],"commandId":"one"}'], [["x"]]],
    ["null 动作", ['{"action":null,"commandId":"one"}'], []],
    ["零值动作", ['{"action":0,"commandId":"one"}'], []],
    ["多个损坏帧", ["{", "[", '{"action":"delete_session","commandId":"three"}'], ["delete_session"]],
    ["保留 payload", ['{"action":"respond_question","commandId":"one","answer":{"option":"A"}}'], ["respond_question"]],
    ["空缓冲", [], []],
    ["空对象帧", ["{}"], []],
    ["空数组帧", ["[]"], []],
    ["纯 JSON 字符串帧", ['"not-an-action"'], []],
    ["纯 JSON 数字帧", ["12"], []],
    ["纯 JSON null 帧", ["null"], []],
    [
      "连续业务帧",
      [
        '{"action":"send_prompt","commandId":"1"}',
        '{"action":"send_prompt","commandId":"2"}',
        '{"action":"send_prompt","commandId":"3"}',
      ],
      ["send_prompt", "send_prompt", "send_prompt"],
    ],
    [
      "会话控制混合帧",
      [
        '{"action":"create_session","commandId":"1"}',
        '{"action":"list_sessions","commandId":"2"}',
        '{"action":"delete_session","commandId":"3"}',
      ],
      ["create_session", "delete_session"],
    ],
    [
      "权限回复帧",
      ['{"action":"respond_permission","commandId":"1"}', '{"action":"respond_question","commandId":"2"}'],
      ["respond_permission", "respond_question"],
    ],
    ["尾部恢复帧", ["invalid", "invalid", '{"action":"set_session_mode","commandId":"last"}'], ["set_session_mode"]],
  ])("重放缓冲：%s", async (_name, pending, expectedActions) => {
    const fixture = createDependencies(async () => undefined);

    await flushPendingYjsActions(createEntry(), pending, fixture.dependencies);

    expect(fixture.invocations.map(({ action }) => action.action)).toEqual(expectedActions);
    expect(fixture.errors).toEqual([]);
  });

  // 重放中单条动作失败时必须继续后续帧，防止一个故障阻塞整个待发送队列。
  test("重放失败动作后继续处理后续动作", async () => {
    const fixture = createDependencies(async (_entry, action) => {
      if (action.commandId === "bad") throw new Error("relay unavailable");
    });

    await flushPendingYjsActions(
      createEntry(),
      ['{"action":"send_prompt","commandId":"bad"}', '{"action":"cancel","commandId":"good"}'],
      fixture.dependencies,
    );

    expect(fixture.invocations.map(({ action }) => action.commandId)).toEqual(["bad", "good"]);
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.acknowledgements).toEqual([{ type: "action_ack", commandId: "good", status: "committed" }]);
  });
});
