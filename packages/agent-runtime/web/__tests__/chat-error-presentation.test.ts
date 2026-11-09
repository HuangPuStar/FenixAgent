import { expect, test } from "bun:test";
import {
  createLegacyBaselineProof,
  isLegacyFallbackUsable,
  selectChatErrorNotices,
} from "../agent-panel/chat-error-presentation";

const scope = "org:instance:projection";
const docs = ["chat:rcs", "session:rcs"];
const generations = docs.map((docName) => ({ docName, generation: "g1" }));
const proof = () =>
  createLegacyBaselineProof({ scope, sessionId: "ses_1", docs, generation: "g1", generations, rcsSessionId: "rcs" });
const healthy = () => ({
  legacyFallback: true,
  connected: true,
  scope,
  sessionId: "ses_1",
  sessionReady: true,
  scopeReady: true,
  hydrating: false,
  replaying: false,
  historyIncomplete: false,
  sendBlocked: false,
  proof: proof(),
  generations,
});

// 完整性只能由当前两份文档的同代完成通知证明，普通在线状态不能替代。
test("完整基线才能证明旧通道接管可用", () => {
  expect(isLegacyFallbackUsable(healthy())).toBe(true);
  for (const field of ["legacyFallback", "connected", "sessionReady", "scopeReady"] as const)
    expect(isLegacyFallbackUsable({ ...healthy(), [field]: false })).toBe(false);
  for (const field of ["hydrating", "replaying", "historyIncomplete", "sendBlocked"] as const)
    expect(isLegacyFallbackUsable({ ...healthy(), [field]: true })).toBe(false);
  expect(isLegacyFallbackUsable({ ...healthy(), proof: null })).toBe(false);
});

// 切组织、会话和投影代次后，旧证明不能再让同步故障静默。
test("异 scope、会话或文档世代使接管证明失效", () => {
  expect(isLegacyFallbackUsable({ ...healthy(), scope: "other" })).toBe(false);
  expect(isLegacyFallbackUsable({ ...healthy(), sessionId: "ses_other" })).toBe(false);
  expect(
    isLegacyFallbackUsable({ ...healthy(), generations: [{ docName: docs[0]!, generation: "g2" }, generations[1]!] }),
  ).toBe(false);
  expect(
    createLegacyBaselineProof({
      scope,
      sessionId: "ses_1",
      docs: [docs[0]!],
      generation: "g1",
      generations,
      rcsSessionId: "rcs",
    }),
  ).toBeNull();
  expect(
    createLegacyBaselineProof({ scope, sessionId: "ses_1", docs, generation: "", generations, rcsSessionId: "rcs" }),
  ).toBeNull();
});

// 对象上的错误优先于会话横幅；独立 ID 的故障不能被文本或类型合并。
test("同 ID 优先对象归属且保留独立故障", () => {
  const error = { type: "AGENT_RUNTIME.REQUEST_FAILED", id: "turn", message: "failed" } as const;
  const action = { type: "ACTION.FAILED", id: "action", message: "failed" } as const;
  expect(
    selectChatErrorNotices({
      classifiedError: error,
      actionErrors: [action],
      agentError: error,
      messageErrors: [error],
      legacyFallbackUsable: true,
      historyIncomplete: false,
    }),
  ).toEqual([action]);
  expect(
    selectChatErrorNotices({
      classifiedError: error,
      actionErrors: [action],
      agentError: { ...error, id: "other" },
      messageErrors: [],
      legacyFallbackUsable: true,
      historyIncomplete: false,
    }),
  ).toEqual([action, { ...error, id: "other" }, error]);
});

// 健康接管与历史恢复只影响同步提示，操作未知结果、Agent 错误和未知类型必须保留。
test("仅有健康接管的同步故障静默，历史缺失由恢复提示承载", () => {
  const sync = { type: "SYNC_RELAY.SYNC_FAILED", id: "sync", message: "sync failed" } as const;
  const unknown = { type: "INTERNAL.UNCLASSIFIED", id: "unknown", message: "unknown" } as const;
  const action = { type: "ACTION.OUTCOME_UNKNOWN", id: "command", message: "unknown" } as const;
  const input = {
    classifiedError: sync,
    actionErrors: [action],
    agentError: unknown,
    messageErrors: [],
    legacyFallbackUsable: false,
    historyIncomplete: false,
  };
  expect(selectChatErrorNotices(input)).toEqual([action, unknown, sync]);
  expect(selectChatErrorNotices({ ...input, legacyFallbackUsable: true })).toEqual([action, unknown]);
  expect(selectChatErrorNotices({ ...input, historyIncomplete: true })).toEqual([action, unknown]);
});
