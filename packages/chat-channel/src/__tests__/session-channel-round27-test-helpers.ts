import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";
import { DocManager } from "../state/doc-manager";

export interface Harness {
  channel: SessionChannel;
  manager: DocManager;
  connection: SessionConnection;
  sent: Record<string, unknown>[];
  acks: ActionAck[];
  errors: ActionError[];
  replacements: number[];
  synced: string[];
  reports: Array<{ message: string; error: unknown }>;
}

export async function createHarness(overrides: Partial<SessionConnection> = {}): Promise<Harness> {
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  await manager.openChat("rcs-1");
  await manager.openSession("user-1", "agent-1", "rcs-1");
  const sent: Record<string, unknown>[] = [];
  const acks: ActionAck[] = [];
  const errors: ActionError[] = [];
  const replacements: number[] = [];
  const synced: string[] = [];
  const reports: Array<{ message: string; error: unknown }> = [];
  let rpcId = 0;
  const connection: SessionConnection = {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "ses-1",
    agentStatusReceived: true,
    sessionLoaded: true,
    workspacePath: "/trusted-workspace",
    sendToRelay: (message) => sent.push(message),
    getNextRpcId: () => ++rpcId,
    awaitSessionMutation: () => ({ completed: Promise.resolve(true), cancel: () => {} }),
    ...overrides,
  };
  const channel = new SessionChannel({
    docManager: manager,
    replaceProjection: () => replacements.push(1),
    syncSessionId: (_connection, sessionId) => synced.push(sessionId),
    reportError: (message, error) => reports.push({ message, error }),
  });
  return { channel, manager, connection, sent, acks, errors, replacements, synced, reports };
}

export async function submit(harness: Harness, action: Record<string, unknown>): Promise<void> {
  const frame = action.action === "send_prompt" ? { sessionId: harness.connection.acpSessionId, ...action } : action;
  await harness.channel.handleAction(harness.connection, frame, {
    sendAck: (ack) => harness.acks.push(ack),
    sendError: (error) => harness.errors.push(error),
  });
}

export function committed(harness: Harness): ActionAck | undefined {
  return harness.acks.find((ack) => ack.status === "committed");
}
