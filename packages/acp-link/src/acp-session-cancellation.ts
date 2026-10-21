import type { AcpSessionState } from "./acp-session-state.js";
import { cancelPendingPermissions } from "./acp-session-state.js";
import { createErrorResponse, createSuccessResponse } from "./json-rpc.js";

interface ActivePrompt {
  cancellation?: Promise<void>;
}

/** Cancellation delivery is idempotent within a prompt and never proves its terminal state. */
export class AcpSessionCancellation {
  private readonly prompts = new Map<string, ActivePrompt>();
  constructor(
    private readonly state: AcpSessionState,
    private readonly send: (message: unknown) => void,
  ) {}

  /** A new prompt replaces only its own delivery state; stale completions cannot clear its successor. */
  beginPrompt(sessionId: string): () => void {
    const prompt: ActivePrompt = {};
    this.prompts.set(sessionId, prompt);
    return () => {
      if (this.prompts.get(sessionId) === prompt) this.prompts.delete(sessionId);
    };
  }
  /** Disconnect drops delivery bookkeeping, without claiming the SDK execution stopped. */
  clear(): void {
    this.prompts.clear();
  }

  /** Standard notifications produce no response; request acknowledgements retain their distinct ID. */
  async cancel(id: number | string | undefined, params: { sessionId?: string } = {}): Promise<void> {
    const sessionId = params.sessionId ?? this.state.sessionId;
    const connection = this.state.connection;
    if (!connection || !sessionId) {
      if (id !== undefined) this.send(createSuccessResponse(id, { cancelled: false }));
      return;
    }
    cancelPendingPermissions(this.state);
    try {
      const prompt = this.prompts.get(sessionId);
      let cancellation = prompt?.cancellation;
      if (!cancellation) {
        cancellation = Promise.resolve().then(() => connection.cancel({ sessionId }));
        if (prompt) prompt.cancellation = cancellation;
      }
      await cancellation;
      if (id !== undefined) this.send(createSuccessResponse(id, { cancelled: true }));
    } catch (error) {
      console.error("[acp-dispatcher] cancellation delivery failed", { sessionId, error });
      if (id !== undefined) this.send(createErrorResponse(id, -32603, "Cancel failed"));
    }
  }
}
