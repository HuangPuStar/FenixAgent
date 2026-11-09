import type { PublicErrorInfo } from "@fenix/chat-channel";

interface DocumentGeneration {
  readonly docName: string;
  readonly generation: string;
}

/** 只供展示使用的当前连接基线证明，不参与同步与发送决策。 */
export interface LegacyBaselineProof {
  readonly scope: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly docs: readonly string[];
}

/** 完成通知与实际应用的两份文档必须同代，不能用实时更新推测完整性。 */
export function createLegacyBaselineProof(input: {
  readonly scope: string;
  readonly sessionId: string;
  readonly rcsSessionId: string;
  readonly docs: readonly string[];
  readonly generation?: string;
  readonly generations: readonly DocumentGeneration[];
}): LegacyBaselineProof | null {
  const docs = [`chat:${input.rcsSessionId}`, `session:${input.rcsSessionId}`];
  if (
    !input.generation ||
    !docs.every(
      (name) =>
        input.docs.includes(name) &&
        input.generations.some((doc) => doc.docName === name && doc.generation === input.generation),
    )
  )
    return null;
  return { scope: input.scope, sessionId: input.sessionId, generation: input.generation, docs };
}

/** 健康接管只消除同步故障的展示，不授权发送或改变底层错误。 */
export function isLegacyFallbackUsable(input: {
  readonly legacyFallback: boolean;
  readonly connected: boolean;
  readonly scope: string;
  readonly sessionId: string;
  readonly sessionReady: boolean;
  readonly scopeReady: boolean;
  readonly hydrating: boolean;
  readonly replaying: boolean;
  readonly historyIncomplete: boolean;
  readonly sendBlocked: boolean;
  readonly proof: LegacyBaselineProof | null;
  readonly generations: readonly DocumentGeneration[];
}): boolean {
  const proof = input.proof;
  return (
    input.legacyFallback &&
    input.connected &&
    input.sessionReady &&
    input.scopeReady &&
    !input.hydrating &&
    !input.replaying &&
    !input.historyIncomplete &&
    !input.sendBlocked &&
    input.sessionId.length > 0 &&
    proof !== null &&
    proof.scope === input.scope &&
    proof.sessionId === input.sessionId &&
    proof.docs.every((name) =>
      input.generations.some((doc) => doc.docName === name && doc.generation === proof.generation),
    )
  );
}

/** 同步来源明确的故障才能由健康接管或专用历史恢复提示承载。 */
export function isSyncError(error: PublicErrorInfo): boolean {
  return error.type.startsWith("SYNC_RELAY.");
}

/** 优先对象内反馈，以来源分配的 ID 去重；不改变历史消息或原始错误。 */
export function selectChatErrorNotices(input: {
  readonly classifiedError: PublicErrorInfo | null;
  readonly actionErrors: readonly PublicErrorInfo[];
  readonly agentError: PublicErrorInfo | null;
  readonly messageErrors: readonly PublicErrorInfo[];
  readonly legacyFallbackUsable: boolean;
  readonly historyIncomplete: boolean;
}): PublicErrorInfo[] {
  const seen = new Set(input.messageErrors.map((error) => error.id));
  const notices: PublicErrorInfo[] = [];
  const actions = new Set(input.actionErrors.map((error) => error.id));
  for (const error of [...input.actionErrors, input.agentError, input.classifiedError]) {
    if (!error || seen.has(error.id)) continue;
    // 操作和消息是独立事实，即便其错误类型来自同步领域也不能由连接健康推断成功。
    if (!actions.has(error.id) && isSyncError(error) && (input.legacyFallbackUsable || input.historyIncomplete))
      continue;
    seen.add(error.id);
    notices.push(error);
  }
  return notices;
}
