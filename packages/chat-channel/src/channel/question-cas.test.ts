// packages/chat-channel/src/channel/question-cas.test.ts
// AskUserQuestion（interactive_question）控制面集成测试：
// - respond_question CAS：仅 pending → resolved 迁移一次，迁移成功才向 Agent
//   发送 control_response 传输帧（非 JSON-RPC），重复响应不重发
// - 60s 超时（expiresAt 到达）→ pending → expired，之后响应不发帧
// - 会话切换 / 断链（dispose）时 question 定时器清理

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getPendingQuestions, getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { createTestRpcReservationFactory, type TestRpcReservation } from "./connection-test-helpers";
import { SessionChannel, type SessionChannelDependencies, type SessionConnection } from "./index";
import type { ActionAck, ActionError } from "./types";

// ── 控制面 harness（复用 permission-cas.test.ts 的测试 seam）──

interface TestHarness {
  channel: SessionChannel;
  docManager: DocManager;
  acks: ActionAck[];
  errorFrames: ActionError[];
  errors: Array<{ message: string; error: unknown }>;
}

function createHarness(overrides: Partial<SessionChannelDependencies> = {}): TestHarness {
  const state = {
    acks: [] as ActionAck[],
    errorFrames: [] as ActionError[],
    errors: [] as Array<{ message: string; error: unknown }>,
  };
  const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
  const channel = new SessionChannel({
    docManager,
    prepareClearSessionSnapshot: async () => {},
    replaceProjection: () => {},
    syncSessionId: () => {},
    reportError: (message, error) => {
      state.errors.push({ message, error });
    },
    ...overrides,
  });
  return {
    channel,
    docManager,
    get acks() {
      return state.acks;
    },
    get errorFrames() {
      return state.errorFrames;
    },
    errors: state.errors,
  };
}

/** control_response 传输帧记录（与 permission 的 JSON-RPC 响应形态不同，单独记录） */
interface ControlResponseRecord {
  type: "control_response";
  request_id: string;
  approved: boolean;
  extra: { answers: string[] } | { outcome: { optionId: string } };
}

function createConnection(overrides: Partial<SessionConnection> = {}): {
  connection: SessionConnection;
  relayMessages: ControlResponseRecord[];
  reservations: TestRpcReservation[];
} {
  const relayMessages: ControlResponseRecord[] = [];
  const reserveRpc = createTestRpcReservationFactory();
  const connection: SessionConnection = {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "ses_1",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/workspace/org-1/user-1/env-1",
    sendToRelay: (message) => {
      const record = message as unknown as ControlResponseRecord;
      if (record.type === "control_response") relayMessages.push(record);
    },
    reserveRpc,
    ...overrides,
  };
  return { connection, relayMessages, reservations: reserveRpc.reservations };
}

async function commitSessionSync(reservations: TestRpcReservation[], sessionId: string): Promise<void> {
  const reservation = reservations.at(-1);
  if (!reservation || reservation.owner.kind !== "session-sync") {
    throw new Error("expected a session-sync reservation");
  }
  const committed = await reservation.owner.lifecycle.commit({ sessionId }, () => !reservation.aborted);
  if (!committed) throw new Error(`expected session-sync commit for ${sessionId}`);
}

function createSinks(harness: TestHarness): {
  sendAck: (ack: ActionAck) => void;
  sendError: (err: ActionError) => void;
} {
  return {
    sendAck: (ack) => harness.acks.push(ack),
    sendError: (err) => harness.errorFrames.push(err),
  };
}

/** 建立 turn + AskUserQuestion 问题的完整上下文（用户消息 → 问题请求投影） */
async function setupTurnWithPendingQuestion(
  harness: TestHarness,
  questionId: string,
  expiresAt: string,
): Promise<void> {
  await harness.docManager.openChat("rcs-1");
  await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
  harness.docManager.processNormalizedEvent("rcs-1", {
    type: "user_message",
    update: { content: { type: "text", text: "hi" } },
    content: { type: "text", text: "hi" },
    turnId: "turn_1",
  });
  harness.docManager.processNormalizedEvent("rcs-1", {
    type: "question_requested",
    update: {
      questionId,
      toolId: "toolu_1",
      toolName: "AskUserQuestion",
      questions: [
        {
          question: "Deploy to prod?",
          header: "Deploy",
          options: [
            { label: "production", description: "Production" },
            { label: "staging", description: "Staging" },
          ],
        },
      ],
      expiresAt,
    },
    content: null,
  });
}

describe("question CAS (AskUserQuestion)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    harness.docManager.setPermissionRequestedHandler(null);
    harness.docManager.setQuestionRequestedHandler(null);
  });

  // 重复 respond_question（相同 questionId、不同 commandId）只有第一次 CAS 生效，
  // Agent 只收到一次 control_response，第二次幂等返回 committed 且不重发
  test("duplicate respond_question resolves once and agent receives a single control_response", async () => {
    const { connection, relayMessages } = createConnection();
    await setupTurnWithPendingQuestion(harness, "iqa_1", new Date(Date.now() + 60_000).toISOString());

    const sinks = createSinks(harness);
    await harness.channel.handleAction(
      connection,
      { action: "respond_question", commandId: "cmd-1", questionId: "iqa_1", optionIds: ["production"] },
      sinks,
    );
    await harness.channel.handleAction(
      connection,
      { action: "respond_question", commandId: "cmd-2", questionId: "iqa_1", optionIds: ["staging"] },
      sinks,
    );

    // 只有第一次迁移成功并发送 control_response（request_id = questionId）
    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.type).toBe("control_response");
    expect(relayMessages[0]?.request_id).toBe("iqa_1");
    expect(relayMessages[0]?.approved).toBe(true);
    // extra.answers 即用户选择的选项 label 数组（按问题顺序，acp-link adapter 组装为答案注入）
    const extra = relayMessages[0]?.extra;
    expect(extra && "answers" in extra ? extra.answers : undefined).toEqual(["production"]);
    // 两次响应都返回 committed（幂等成功，不报错）
    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed", "accepted", "committed"]);
    // Session Doc 投影为 resolved，answer 落盘为首选答案数组（JSON 序列化）
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    expect(getPendingQuestions(sessionDoc!).get("iqa_1")?.get("status")).toBe("resolved");
    expect(getPendingQuestions(sessionDoc!).get("iqa_1")?.get("answer")).toBe('["production"]');
    // question 不收敛 turn 状态机（与权限不同：AskUserQuestion 是工具执行中询问，
    // agent 收到答案后的下一条输出增量会自然推进 accepting → running）
    expect(getSessionInfo(sessionDoc!).get("activeTurnStatus")).toBe("accepting");
  });

  // 未知 questionId（不存在于 pendingQuestions）时 CAS 失败：不发帧、幂等成功
  test("unknown questionId does not send control_response", async () => {
    const { connection, relayMessages } = createConnection();
    await setupTurnWithPendingQuestion(harness, "iqa_1", new Date(Date.now() + 60_000).toISOString());

    await harness.channel.handleAction(
      connection,
      { action: "respond_question", commandId: "cmd-1", questionId: "iqa-unknown", optionId: "production" },
      createSinks(harness),
    );

    expect(relayMessages).toHaveLength(0);
    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
  });

  // 问题超时：expiresAt 已过 → 定时器立即触发 pending → expired，之后响应不发帧
  test("expired question migrates to expired and cannot be responded afterwards", async () => {
    const { connection, relayMessages } = createConnection();
    // expiresAt 设为过去时间，定时器立即触发
    await setupTurnWithPendingQuestion(harness, "iqa_1", new Date(Date.now() - 1000).toISOString());
    // 确保 timer 在事件循环中执行
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1")!;
    expect(getPendingQuestions(sessionDoc).get("iqa_1")?.get("status")).toBe("expired");
    // expired 路径不写 answer（保持 upsert 时的 null）
    expect(getPendingQuestions(sessionDoc).get("iqa_1")?.get("answer")).toBeNull();

    // 过期后响应 → CAS 失败，不再发 control_response（即使命令重发也不重发帧）
    await harness.channel.handleAction(
      connection,
      { action: "respond_question", commandId: "cmd-1", questionId: "iqa_1", optionId: "production" },
      createSinks(harness),
    );
    expect(relayMessages).toHaveLength(0);
  });

  // 会话切换（load_session 到新会话）→ pendingQuestions 整体清空，不残留可应答项
  test("session switch clears pending questions", async () => {
    const { connection, reservations } = createConnection({ sessionLoaded: true });
    await setupTurnWithPendingQuestion(harness, "iqa_1", new Date(Date.now() + 60_000).toISOString());

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-load", sessionId: "ses_new" },
      createSinks(harness),
    );
    await commitSessionSync(reservations, "ses_new");

    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1")!;
    expect(getPendingQuestions(sessionDoc).size).toBe(0);
  });

  // 断链（前端最后连接关闭 → disposeRcsSession）：question 过期定时器被清除，
  // 之后即使超过 expiresAt 也不再迁移（Y.Doc 状态保留，重连后可见）
  test("disposeRcsSession clears question timers so late expiry is not applied", async () => {
    await setupTurnWithPendingQuestion(harness, "iqa_1", new Date(Date.now() + 60).toISOString());
    harness.channel.disposeRcsSession("rcs-1");

    await new Promise((resolve) => setTimeout(resolve, 120));

    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1")!;
    expect(getPendingQuestions(sessionDoc).get("iqa_1")?.get("status")).toBe("pending");
  });
});
