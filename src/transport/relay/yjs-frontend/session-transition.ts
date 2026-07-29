import type { DocManager } from "@fenix/acp-server";

export class InvalidSessionIdError extends Error {
  constructor(readonly sessionId: unknown) {
    super("load_session requires a valid sessionId");
    this.name = "InvalidSessionIdError";
  }
}

export interface SessionTransitionEntry {
  userId: string;
  agentId: string;
  instanceId: string;
  rcsSessionId: string;
  acpSessionId: string | null;
  agentStatusReceived: boolean;
  /** 是否已执行过至少一次 load_session（用于区分重连首次加载 vs 后续正常切换） */
  sessionLoaded: boolean;
}

export interface SessionTransitionDependencies {
  docManager: DocManager;
  prepareClearSessionSnapshot: (entry: SessionTransitionEntry) => Promise<void>;
  /** 会话切换（load/create）后同步 acpSessionId 到同一 instance+user 的所有客户端 */
  syncSessionId: (entry: SessionTransitionEntry, newSessionId: string) => void;
  reportError: (message: string, error: unknown) => void;
}

/**
 * 编排前端 action 在 relay 转发前后的 Session Doc 状态变化。
 * relay 生命周期与 action → ACP RPC 翻译仍由调用方管理。
 */
export class SessionTransition {
  constructor(private readonly dependencies: SessionTransitionDependencies) {}

  async beforeForward(entry: SessionTransitionEntry, action: Record<string, unknown>): Promise<boolean> {
    const actionName = action.action;

    if (actionName === "list_sessions" && !entry.agentStatusReceived) {
      return false;
    }

    if (actionName === "load_session") {
      const shouldForward = await this.prepareLoadSession(entry, action.sessionId);
      if (!shouldForward) return false;
    }

    if (actionName === "create_session") {
      const prepared = await this.prepareCreateSession(entry);
      if (!prepared) return false;
    }

    if (actionName === "send_prompt") {
      await this.writePromptText(entry, action.content);
    }

    return true;
  }

  afterForward(entry: SessionTransitionEntry, action: Record<string, unknown>): void {
    if (action.action !== "cancel" || !entry.acpSessionId) return;

    try {
      this.dependencies.docManager.processACP(entry.rcsSessionId, { type: "agent_message_complete", payload: {} });
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] cancel: failed to clear session loading:", err);
    }
  }

  private async prepareLoadSession(entry: SessionTransitionEntry, sessionId: unknown): Promise<boolean> {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new InvalidSessionIdError(sessionId);
    }

    if (entry.acpSessionId === sessionId) {
      entry.acpSessionId = sessionId;
      return false;
    }

    // 防御：首次 load_session 且 Session Doc 已有内容时，
    // 说明是重连场景下 acpSessionId 恢复失败，不应清空已有消息。
    if (!entry.sessionLoaded && this.dependencies.docManager.hasSessionDocContent(entry.rcsSessionId)) {
      entry.acpSessionId = sessionId;
      entry.sessionLoaded = true;
      this.dependencies.syncSessionId(entry, sessionId);
      // P1: 此处 return true 会向 agent 发送 session/load RPC，可能触发全量回放。
      // 如果 Session Doc 已有内容（来自之前的回放），其他客户端会收到重复消息。
      // 若未来观察到多客户端重复消息，改为 return false 即可（快照已在内存中）。
      return true;
    }

    await this.dependencies.prepareClearSessionSnapshot(entry);
    this.dependencies.docManager.clearSessionDocContent(entry.rcsSessionId);
    entry.acpSessionId = sessionId;
    entry.sessionLoaded = true;
    this.dependencies.syncSessionId(entry, sessionId);
    return true;
  }

  private async prepareCreateSession(entry: SessionTransitionEntry): Promise<boolean> {
    await this.dependencies.docManager.openSession(entry.userId, entry.agentId, entry.rcsSessionId);
    await this.dependencies.prepareClearSessionSnapshot(entry);
    this.dependencies.docManager.clearSessionDocContent(entry.rcsSessionId);
    return true;
  }

  private async writePromptText(entry: SessionTransitionEntry, content: unknown): Promise<void> {
    const text = extractPromptText(content);
    if (!text) return;

    try {
      await this.dependencies.docManager.openSession(entry.userId, entry.agentId, entry.rcsSessionId);
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] Failed to ensure session doc for user message:", err);
    }

    this.dependencies.docManager.processACP(entry.rcsSessionId, {
      type: "user_message_chunk",
      payload: { content: { type: "text", text } },
    });
  }
}

function extractPromptText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}
