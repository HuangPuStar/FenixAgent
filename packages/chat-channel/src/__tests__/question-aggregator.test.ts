// packages/chat-channel/src/__tests__/question-aggregator.test.ts
// AskUserQuestion 交互问题链路测试（切片 1：relay 入站映射 + 聚合层投影）：
// - acp-channel 把 interactive_question 私有帧翻译为 question_requested 规范化事件
// - 聚合层投影 Session Doc root.pendingQuestions（幂等 upsert、60s expiresAt）
// - question_resolved CAS：重复 resolve 只生效一次
// - 60s 超时 CAS（expireQuestion）：pending → expired 一次

import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { normalizeAcpMessage } from "../protocol/acp-channel";
import { DEFAULT_QUESTION_TIMEOUT_MS, type NormalizedEvent } from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import { clearSessionDocContent, getPendingQuestions, getSessionRoot } from "../state/chat-writer";
import { createChatDoc, createSessionDoc } from "../state/factory";
import { expireQuestion, respondQuestion } from "../state/question";

let pair: DocPair;

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_q", null).ydoc,
    session: createSessionDoc("rcs_q", null).ydoc,
  };
});

function event(type: NormalizedEvent["type"], update: Record<string, unknown> = {}, turnId?: string): NormalizedEvent {
  return { type, update, content: null, turnId };
}

/** 构造 acp-link 真实形状的 interactive_question 帧（claude-acp-adapter.ts:475-483） */
function interactiveQuestionFrame(questionId = "iqa_1") {
  return {
    type: "interactive_question",
    payload: {
      sessionId: "ses_1",
      questionId,
      toolId: "toolu_1",
      toolName: "AskUserQuestion",
      questions: [
        {
          question: "Which deployment target should I use?",
          header: "Deployment Target",
          options: [
            { label: "production", description: "Production environment" },
            { label: "staging", description: "Staging environment" },
          ],
        },
      ],
      description: "Please answer the following questions",
    },
  };
}

// relay 入站映射：interactive_question 私有帧 → question_requested 规范化事件
test("interactive_question frame normalizes to question_requested", () => {
  const normalized = normalizeAcpMessage(interactiveQuestionFrame(), "interactive_question");
  expect(normalized?.type).toBe("question_requested");
  expect(normalized?.update.questionId).toBe("iqa_1");
  expect(normalized?.update.toolId).toBe("toolu_1");
  // questions[] 透传原样（聚合层负责结构校验）
  expect(Array.isArray(normalized?.update.questions)).toBe(true);
  expect(normalized?.content).toBeNull();
});

// 聚合投影：question_requested 写入 Session Doc root.pendingQuestions（含 60s expiresAt）
test("question_requested projects pendingQuestions with 60s expiresAt", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(
    pair,
    event("question_requested", {
      questionId: "iqa_1",
      questions: [
        {
          question: "Deploy to prod?",
          header: "Deploy",
          options: [
            { label: "yes", description: "Deploy now" },
            { label: "no", description: "Abort" },
          ],
        },
      ],
      description: "Please answer",
    }),
  );

  const pending = getPendingQuestions(pair.session);
  expect(pending.size).toBe(1);
  const question = pending.get("iqa_1")!;
  expect(question.get("status")).toBe("pending");
  expect(question.get("answer")).toBeNull();
  const expiresAt = new Date(question.get("expiresAt") as string).getTime();
  // 超时对齐 acp-link 60s：expiresAt 落在 (now, now + DEFAULT_QUESTION_TIMEOUT_MS] 区间
  expect(expiresAt).toBeGreaterThan(Date.now());
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_QUESTION_TIMEOUT_MS);
  // questions[] 结构校验后投影（header 非字符串 → null 的边界由聚合层提取函数处理）
  const items = question.get("questions") as Array<Record<string, unknown>>;
  expect(items).toHaveLength(1);
  expect(items[0]?.question).toBe("Deploy to prod?");
  expect(items[0]?.options).toEqual([
    { label: "yes", description: "Deploy now" },
    { label: "no", description: "Abort" },
  ]);
});

// 幂等：重放同一 question_requested 帧（同 questionId）不重复创建投影
test("replayed question request with same questionId does not duplicate", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  const qEvent = event("question_requested", {
    questionId: "iqa_1",
    questions: [{ question: "Q?", header: null, options: [{ label: "a", description: null }] }],
  });
  applyNormalizedEvent(pair, qEvent);
  applyNormalizedEvent(pair, qEvent);

  expect(getPendingQuestions(pair.session).size).toBe(1);
});

// 外部输入校验：非法 questions[] 结构（非字符串 question / 无 label 选项）被过滤
test("invalid question items are filtered by the aggregator", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(
    pair,
    event("question_requested", {
      questionId: "iqa_1",
      questions: [
        { question: "Valid?", header: 42, options: [{ label: "ok", description: "" }] },
        { question: "", header: "bad", options: [] },
        { question: "No options", header: "h", options: [{ label: 7, description: "bad label" }] },
      ],
    }),
  );

  const items = getPendingQuestions(pair.session).get("iqa_1")!.get("questions") as Array<Record<string, unknown>>;
  // 非法元素被丢弃：空 question 被过滤；非法 header（42）→ null；
  // 无合法 label 的选项被过滤但问题本身保留（options 为空数组）
  expect(items).toHaveLength(2);
  expect(items[0]?.question).toBe("Valid?");
  expect(items[0]?.header).toBeNull();
  expect(items[0]?.options).toEqual([{ label: "ok", description: "" }]);
  expect(items[1]?.question).toBe("No options");
  expect(items[1]?.options).toEqual([]);
});

// question_resolved CAS：重复 resolve 只有第一次生效（answer 落盘为答案数组 JSON 序列化，
// 多问题按问题顺序合并；兼容单值 optionId 历史形态回退）
test("question resolve is CAS — only first resolution applies", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("question_requested", { questionId: "iqa_1", questions: [] }));

  const first = applyNormalizedEvent(
    pair,
    event("question_resolved", { questionId: "iqa_1", optionIds: ["production", "all"] }),
  );
  const second = applyNormalizedEvent(
    pair,
    event("question_resolved", { questionId: "iqa_1", optionIds: ["staging"] }),
  );
  expect(first.applied).toBe(true);
  expect(second.applied).toBe(false);

  const question = getPendingQuestions(pair.session).get("iqa_1")!;
  expect(question.get("status")).toBe("resolved");
  // Yjs Map value 不能是数组，answers 以 JSON.stringify 落盘
  expect(question.get("answer")).toBe('["production","all"]');
});

// 单值 optionId 历史形态（旧前端/回放）：aggregator 回退包装为单元素数组
test("question resolve falls back to legacy single optionId", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("question_requested", { questionId: "iqa_1", questions: [] }));

  const result = applyNormalizedEvent(
    pair,
    event("question_resolved", { questionId: "iqa_1", optionId: "production" }),
  );
  expect(result.applied).toBe(true);
  const question = getPendingQuestions(pair.session).get("iqa_1")!;
  expect(question.get("answer")).toBe('["production"]');
});

// 60s 超时 CAS：expireQuestion 仅 pending → expired 一次，重复过期无副作用
test("expired question migrates to expired once and cannot be responded afterwards", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("question_requested", { questionId: "iqa_1", questions: [] }));

  expect(expireQuestion(pair, "iqa_1")).toBe(true);
  // 重复过期幂等
  expect(expireQuestion(pair, "iqa_1")).toBe(false);
  expect(getPendingQuestions(pair.session).get("iqa_1")?.get("status")).toBe("expired");
  // expired 后 respond 拒绝（CAS：不得再发 control_response）
  expect(respondQuestion(pair, "iqa_1", ["production"])).toBe(false);
  expect(getPendingQuestions(pair.session).get("iqa_1")?.get("answer")).toBeNull();
});

// 乱序容错：工具已发起询问但 prompt_complete 先到时，completed 仅代表展示态终结；
// Agent 仍在等待 control_response，问题必须投影，否则会出现工具卡片已渲染但无弹窗。
test("question request remains visible when prompt completion arrives first", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("turn_completed", {}, "turn_1"));

  const result = applyNormalizedEvent(
    pair,
    event("question_requested", {
      questionId: "iqa_1",
      questions: [{ question: "Deploy?", header: "Deploy", options: [{ label: "production" }] }],
    }),
  );

  expect(result.applied).toBe(true);
  expect(getPendingQuestions(pair.session).get("iqa_1")?.get("status")).toBe("pending");
});

// 已取消、失败或无活动 turn 时的问题没有可消费答案的 Agent，必须拒绝以避免旧帧污染当前会话。
test("question request without an answerable turn is rejected", () => {
  expect(
    applyNormalizedEvent(pair, event("question_requested", { questionId: "missing", questions: [] })).applied,
  ).toBe(false);

  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("turn_cancelled", {}, "turn_1"));
  expect(
    applyNormalizedEvent(pair, event("question_requested", { questionId: "cancelled", questions: [] })).applied,
  ).toBe(false);
  expect(getPendingQuestions(pair.session).size).toBe(0);
});

// 会话切换清理：clearSessionDocContent 清空 pendingQuestions（与 pendingPermissions 同批）
test("clearSessionDocContent clears pendingQuestions", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("question_requested", { questionId: "iqa_1", questions: [] }));
  expect(getPendingQuestions(pair.session).size).toBe(1);

  clearSessionDocContent(pair.session);
  expect(getPendingQuestions(pair.session).size).toBe(0);
  // schema 骨架保留（下次投影可直接写入）
  expect(getSessionRoot(pair.session).get("pendingQuestions") instanceof Y.Map).toBe(true);
});
