import type * as acp from "@agentclientprotocol/sdk";
import type { AgentCapabilities, PromptCapabilities, SessionModelState } from "./types.js";

// Pending permission request
interface PendingPermission {
  resolve: (outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Mutable SDK connection and negotiated ACP session state shared by dispatch handlers. */
export interface AcpSessionState {
  connection: acp.ClientSideConnection | null;
  sessionId: string | null;
  pendingPermissions: Map<string, PendingPermission>;
  agentCapabilities: AgentCapabilities | null;
  promptCapabilities: PromptCapabilities | null;
  modelState: SessionModelState | null;
  modeState: {
    availableModes: Array<{ id: string; name: string; description?: string | null }>;
    currentModeId: string;
  } | null;
}

/** Construct a disconnected dispatcher state without any pending permissions. */
export function createAcpSessionState(): AcpSessionState {
  return {
    connection: null,
    sessionId: null,
    pendingPermissions: new Map(),
    agentCapabilities: null,
    promptCapabilities: null,
    modelState: null,
    modeState: null,
  };
}

/** Disconnect and cancellation must unblock permission waiters without approving them. */
export function cancelPendingPermissions(state: AcpSessionState): void {
  for (const [, pending] of state.pendingPermissions) {
    clearTimeout(pending.timeout);
    pending.resolve({ outcome: "cancelled" });
  }
  state.pendingPermissions.clear();
}
