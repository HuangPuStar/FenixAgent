export class InvalidSessionIdError extends Error {
  constructor(readonly sessionId: unknown) {
    super("load_session requires a valid sessionId");
    this.name = "InvalidSessionIdError";
  }
}

export interface SessionTransitionEntry {
  userId: string;
  agentId: string;
  rcsSessionId: string;
  acpSessionId: string | null;
  agentStatusReceived: boolean;
}

export interface SessionTransitionDependencies {
  openSession: (userId: string, agentId: string, rcsSessionId: string) => Promise<unknown>;
  clearSessionDocContent: (rcsSessionId: string) => void;
  prepareClearSessionSnapshot: (entry: SessionTransitionEntry) => Promise<void>;
  processACP: (rcsSessionId: string, event: { type: string; payload: Record<string, unknown> }) => void;
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
      this.dependencies.processACP(entry.rcsSessionId, { type: "agent_message_complete", payload: {} });
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

    await this.dependencies.prepareClearSessionSnapshot(entry);
    this.dependencies.clearSessionDocContent(entry.rcsSessionId);
    entry.acpSessionId = sessionId;
    return true;
  }

  private async prepareCreateSession(entry: SessionTransitionEntry): Promise<boolean> {
    await this.dependencies.openSession(entry.userId, entry.agentId, entry.rcsSessionId);
    await this.dependencies.prepareClearSessionSnapshot(entry);
    this.dependencies.clearSessionDocContent(entry.rcsSessionId);
    return true;
  }

  private async writePromptText(entry: SessionTransitionEntry, content: unknown): Promise<void> {
    const text = extractPromptText(content);
    if (!text) return;

    try {
      await this.dependencies.openSession(entry.userId, entry.agentId, entry.rcsSessionId);
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] Failed to ensure session doc for user message:", err);
    }

    this.dependencies.processACP(entry.rcsSessionId, {
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
