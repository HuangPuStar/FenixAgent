// packages/acp-link/src/__tests__/user-input-queue-forwarding.test.ts
// Peri steer（用户输入队列）在 client mode（AcpDispatcher）的透传契约：
// - 四个 session/input/* 扩展方法经 SDK extMethod 原样发往 agent：params 不做字段
//   过滤、ID 换算或形状转换（enqueue 的 content 是 peri 内部 MessageContent，
//   图片为 {type:'image', source:{type:'base64', media_type, data}}，漏转换会静默丢图）；
// - 成功响应原样回传（含 UserInputQueueSnapshot / UserInputQueueReceipt 字段）；
// - agent 侧错误（-32601 未协商、-32602 generation 不符 + data.rejected）逐字段回传，
//   不换码、不改 message、不吞 data、不降级成空成功；
// - 连接未就绪或 extMethod 抛非结构化异常时回明确错误，绝不静默成功。

import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpDispatcher, createAcpSessionState } from "../acp-dispatcher";
import { ACP_METHOD } from "../json-rpc";
import { buildPeriCapabilityMeta, PERI_USER_INPUT_QUEUE_CAPABILITY } from "../peri-task-capability";

/** 记录 extMethod 调用并返回预设结果/抛出预设错误的 fake ClientSideConnection */
function createFakeConnection(behavior: { result?: unknown; error?: unknown }): {
  conn: acp.ClientSideConnection;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const conn = {
    async extMethod(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (behavior.error !== undefined) throw behavior.error;
      return (behavior.result ?? {}) as Record<string, unknown>;
    },
  } as unknown as acp.ClientSideConnection;
  return { conn, calls };
}

function createDispatcher(
  conn: acp.ClientSideConnection | null,
  sessionId: string | null = "ses-current",
): { dispatcher: AcpDispatcher; responses: Array<Record<string, unknown>> } {
  const state = createAcpSessionState();
  state.connection = conn;
  state.sessionId = sessionId;
  const responses: Array<Record<string, unknown>> = [];
  const dispatcher = new AcpDispatcher(state, {
    send: (message) => responses.push(message as Record<string, unknown>),
  });
  return { dispatcher, responses };
}

const SNAPSHOT = {
  sessionId: "ses_abc",
  generation: 3,
  revision: 7,
  activeRequestId: "req_1",
  items: [{ inputId: "in_1", content: "先看 README", originalDraft: "draft", state: "queued" }],
};

describe("Peri userInputQueue 能力协商", () => {
  // initialize 的 clientCapabilities._meta 必须声明用户输入队列能力，否则 peri 对四个
  // 方法回 -32601 且不发射 user_input_* 事件
  test("capability meta 含 peri.userInputQueue", () => {
    expect(buildPeriCapabilityMeta()).toMatchObject({ [PERI_USER_INPUT_QUEUE_CAPABILITY]: true });
  });

  // 方法名是 peri 侧协议常量，逐字对照，避免透传时改名导致 -32601
  test("四个扩展方法名逐字一致", () => {
    expect(ACP_METHOD.SESSION_INPUT_SNAPSHOT).toBe("session/input/snapshot");
    expect(ACP_METHOD.SESSION_INPUT_ENQUEUE).toBe("session/input/enqueue");
    expect(ACP_METHOD.SESSION_INPUT_DISPATCH).toBe("session/input/dispatch");
    expect(ACP_METHOD.SESSION_INPUT_TAKEBACK).toBe("session/input/takeback");
  });
});

describe("AcpDispatcher session/input/* 透传", () => {
  // snapshot 只读查询：params 整包透传（不依赖连接级 state.sessionId），响应原样回传
  test("snapshot 透传 params 并原样回传 snapshot", async () => {
    const { conn, calls } = createFakeConnection({ result: SNAPSHOT });
    const { dispatcher, responses } = createDispatcher(conn, null);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: ACP_METHOD.SESSION_INPUT_SNAPSHOT,
      params: { sessionId: "ses_abc", generation: 3 },
    });

    expect(calls).toEqual([{ method: "session/input/snapshot", params: { sessionId: "ses_abc", generation: 3 } }]);
    expect(responses[0]).toEqual({ jsonrpc: "2.0", id: 1, result: SNAPSHOT });
  });

  // enqueue 的 content 是 peri 内部 MessageContent（untagged union）：纯字符串与
  // 图片块（snake_case source/media_type）都必须原样送到 agent，acp-link 不做形状转换
  test("enqueue 原样透传 content 形状（含图片 source/media_type）", async () => {
    const receipt = {
      snapshot: { ...SNAPSHOT, revision: 8 },
      results: [{ inputId: "in_2", state: "queued" }],
    };
    const { conn, calls } = createFakeConnection({ result: receipt });
    const { dispatcher, responses } = createDispatcher(conn);

    const enqueueParams = {
      sessionId: "ses_abc",
      generation: 3,
      commandId: "cmd_1",
      inputId: "in_2",
      content: [
        { type: "text", text: "看看这两张图" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      ],
      originalDraft: "看看这两张图",
    };
    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: ACP_METHOD.SESSION_INPUT_ENQUEUE,
      params: enqueueParams,
    });

    expect(calls[0]?.method).toBe("session/input/enqueue");
    expect(calls[0]?.params).toEqual(enqueueParams);
    expect(responses[0]).toEqual({ jsonrpc: "2.0", id: 2, result: receipt });
  });

  // enqueue 纯文本 content 是字符串（不是 ContentBlock[]），不得被包装成块数组
  test("enqueue 纯文本 content 保持字符串形态", async () => {
    const { conn, calls } = createFakeConnection({ result: { snapshot: SNAPSHOT, results: [] } });
    const { dispatcher } = createDispatcher(conn);
    const params = {
      sessionId: "ses_abc",
      generation: 1,
      commandId: "cmd_2",
      inputId: "in_3",
      content: "补充一句",
      originalDraft: "补充",
    };

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: ACP_METHOD.SESSION_INPUT_ENQUEUE,
      params,
    });

    expect(calls[0]?.params).toEqual(params);
  });

  // dispatch 的 inputIds 数组与 generation/commandId 必须逐个字段送达（打断并注入由 peri 决定）
  test("dispatch 透传 inputIds 数组", async () => {
    const { conn, calls } = createFakeConnection({
      result: { snapshot: SNAPSHOT, results: [{ inputId: "in_1", state: "dispatching" }] },
    });
    const { dispatcher, responses } = createDispatcher(conn);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: ACP_METHOD.SESSION_INPUT_DISPATCH,
      params: { sessionId: "ses_abc", generation: 3, commandId: "cmd_1", inputIds: ["in_1", "in_2"] },
    });

    expect(calls[0]).toEqual({
      method: "session/input/dispatch",
      params: { sessionId: "ses_abc", generation: 3, commandId: "cmd_1", inputIds: ["in_1", "in_2"] },
    });
    expect(responses[0]).toMatchObject({ id: 4, result: { results: [{ inputId: "in_1", state: "dispatching" }] } });
  });

  // takeback 撤回 queued 项：takenBack 语义字段由 peri 返回，acp-link 只能原样回传
  test("takeback 透传 inputId 并回传 takenBack", async () => {
    const receipt = { snapshot: SNAPSHOT, results: [{ inputId: "in_1", state: "withdrawn" }], takenBack: true };
    const { conn, calls } = createFakeConnection({ result: receipt });
    const { dispatcher, responses } = createDispatcher(conn);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: ACP_METHOD.SESSION_INPUT_TAKEBACK,
      params: { sessionId: "ses_abc", generation: 3, commandId: "cmd_1", inputId: "in_1" },
    });

    expect(calls[0]).toEqual({
      method: "session/input/takeback",
      params: { sessionId: "ses_abc", generation: 3, commandId: "cmd_1", inputId: "in_1" },
    });
    expect(responses[0]).toEqual({ jsonrpc: "2.0", id: 5, result: receipt });
  });
});

describe("AcpDispatcher session/input/* 错误路径", () => {
  // peri 未协商能力时回 -32601；acp-link 必须逐字回传，不得替换成自己的 -32603
  test("-32601 未协商错误原样回传", async () => {
    const { conn } = createFakeConnection({
      error: new RequestError(-32601, "user input queue capability not negotiated"),
    });
    const { dispatcher, responses } = createDispatcher(conn);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: ACP_METHOD.SESSION_INPUT_ENQUEUE,
      params: { sessionId: "ses_abc", generation: 1, commandId: "c", inputId: "i", content: "x", originalDraft: "" },
    });

    expect(responses[0]).toEqual({
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32601, message: "user input queue capability not negotiated" },
    });
  });

  // generation 不符回 -32602，data={rejected:true, snapshot}：data 是前端重新对齐代际的
  // 唯一依据，必须整包保留，不能被丢弃或替换成字符串
  test("-32602 generation 不符带 data.rejected 原样回传", async () => {
    const { conn } = createFakeConnection({
      error: new RequestError(-32602, "generation mismatch", { rejected: true, snapshot: SNAPSHOT }),
    });
    const { dispatcher, responses } = createDispatcher(conn);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: ACP_METHOD.SESSION_INPUT_DISPATCH,
      params: { sessionId: "ses_abc", generation: 1, commandId: "cmd_1", inputIds: ["in_1"] },
    });

    expect(responses[0]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "generation mismatch", data: { rejected: true, snapshot: SNAPSHOT } },
    });
  });

  // 只读 observer 调写方法同样得 -32602：不得因为「看起来是权限问题」而自行改写错误
  test("observer 拒绝错误原样回传", async () => {
    const { conn } = createFakeConnection({ error: new RequestError(-32602, "read-only observer") });
    const { dispatcher, responses } = createDispatcher(conn);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 8,
      method: ACP_METHOD.SESSION_INPUT_TAKEBACK,
      params: { sessionId: "ses_abc", generation: 1, commandId: "cmd_1", inputId: "in_1" },
    });

    expect(responses[0]).toMatchObject({ id: 8, error: { code: -32602, message: "read-only observer" } });
    expect((responses[0]?.error as { data?: unknown }).data).toBeUndefined();
  });

  // 连接未就绪（agent 未启动/已断开）必须回明确错误，不能让调用方等到超时或误判成功
  test("连接未就绪回 -32000 且不抛错", async () => {
    const { dispatcher, responses } = createDispatcher(null, null);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 9,
      method: ACP_METHOD.SESSION_INPUT_SNAPSHOT,
      params: { sessionId: "ses_abc" },
    });

    expect(responses).toEqual([{ jsonrpc: "2.0", id: 9, error: { code: -32000, message: "Not connected to agent" } }]);
  });

  // extMethod 抛非结构化异常（如 stdio 断开）时回 -32603 并保留原因，不降级成空成功
  test("extMethod 抛裸异常回 -32603 且保留错误原因", async () => {
    const { conn } = createFakeConnection({ error: new Error("socket closed") });
    const { dispatcher, responses } = createDispatcher(conn);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: ACP_METHOD.SESSION_INPUT_SNAPSHOT,
      params: { sessionId: "ses_abc" },
    });

    expect(responses[0]).toMatchObject({ id: 10, error: { code: -32603 } });
    expect((responses[0]?.error as { message: string }).message).toContain("socket closed");
    expect(responses[0]).not.toHaveProperty("result");
  });

  // 新增四个分支不得影响未知方法的既有兜底行为
  test("未知方法仍回 -32601 Method not found", async () => {
    const { conn } = createFakeConnection({ result: {} });
    const { dispatcher, responses } = createDispatcher(conn);

    await dispatcher.handleMessage({ jsonrpc: "2.0", id: 11, method: "session/input/unknown", params: {} });

    expect(responses[0]).toEqual({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32601, message: "Method not found: session/input/unknown" },
    });
  });
});
