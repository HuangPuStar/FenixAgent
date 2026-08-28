// packages/chat-channel/src/state/question.ts
// AskUserQuestion 交互问题的 CAS 与收敛（与 permission.ts 平行）：
// pending → resolved/expired 的原子迁移。
//
// 为什么独立成文件：CAS 迁移同时被聚合层（question_resolved 事件）与控制面
// （respond_question Action、60s 超时定时器）调用，迁移语义必须单一来源，
// 否则两处实现漂移会破坏"迁移成功后才发 control_response"的原子语义。
//
// 迁移失败（已 resolved/expired/不存在）返回 false，调用方必须视为
// "未发生副作用"：不得向 Agent 发送 control_response，防止重复应答导致
// Agent 收到两份答案。
//
// 与 permission 的差异：question 不关联工具调用/turn 状态收敛（AskUserQuestion
// 是工具执行中的询问，agent 收到答案后自行继续；turn 状态机不进入等待态，
// 见 aggregator.ts applyQuestionRequested 注释）。

import { getPendingQuestions } from "./chat-writer";
import type { DocPair } from "./permission";

export type { DocPair };

/**
 * 应答问题（CAS）：仅 pending → resolved 迁移一次，成功返回 true。
 * optionIds 为用户选择的选项 label 数组（按问题顺序对应 requestedSchema
 * properties；空数组表示用户取消/跳过，acp-link 侧同样以空答案处理）。
 * answer 以 JSON 字符串落盘（Yjs Map 值不能是普通数组），仅作记录，前端不消费。
 * 重复应答（已 resolved/expired/不存在）返回 false，调用方不得发送 control_response。
 */
export function respondQuestion(pair: DocPair, questionId: string, optionIds: string[]): boolean {
  let migrated = false;
  pair.session.transact(() => {
    const question = getPendingQuestions(pair.session).get(questionId);
    const status = question?.get("status");
    // 双重条件：CAS 要求存在且仍为 pending（question 收窄供后续 set 使用）
    if (status !== "pending" || question === undefined) return;
    question.set("status", "resolved");
    question.set("answer", JSON.stringify(optionIds));
    migrated = true;
  });
  return migrated;
}

/**
 * 过期问题（CAS）：仅 pending → expired 迁移一次，成功返回 true。
 * 60s 超时定时器与 question_expired 语义共用此入口；expired 不写 answer
 * （保持 null）。重复过期（已 resolved/expired/不存在）返回 false。
 */
export function expireQuestion(pair: DocPair, questionId: string): boolean {
  let migrated = false;
  pair.session.transact(() => {
    const question = getPendingQuestions(pair.session).get(questionId);
    const status = question?.get("status");
    if (status !== "pending" || question === undefined) return;
    question.set("status", "expired");
    migrated = true;
  });
  return migrated;
}
