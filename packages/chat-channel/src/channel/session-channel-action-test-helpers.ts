import type * as Y from "yjs";
import { getEntriesMap, getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { SessionChannel, type SessionChannelDependencies, type SessionConnection } from "./index";
import type { ActionAck, ActionError } from "./types";

export interface TestHarness {
  channel: SessionChannel;
  docManager: DocManager;
  refreshCalls: string[];
  syncCalls: string[];
  errors: Array<{ message: string; error: unknown }>;
  acks: ActionAck[];
  errorFrames: ActionError[];
}

export function createHarness(overrides: Partial<SessionChannelDependencies> = {}): TestHarness {
  const state = {
    refreshCalls: [] as string[],
    syncCalls: [] as string[],
    errors: [] as Array<{ message: string; error: unknown }>,
    acks: [] as ActionAck[],
    errorFrames: [] as ActionError[],
  };
  const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
  const channel = new SessionChannel({
    docManager,
    refreshInstanceEnvironment: async (connection) => {
      state.refreshCalls.push(connection.instanceId);
    },
    replaceProjection: () => {},
    syncSessionId: (_connection, newSessionId) => {
      state.syncCalls.push(newSessionId);
    },
    reportError: (message, error) => {
      state.errors.push({ message, error });
    },
    ...overrides,
  });
  return {
    channel,
    docManager,
    refreshCalls: state.refreshCalls,
    syncCalls: state.syncCalls,
    errors: state.errors,
    acks: state.acks,
    errorFrames: state.errorFrames,
  };
}

export interface RelayRecord {
  jsonrpc: string;
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export function createConnection(overrides: Partial<SessionConnection> = {}): {
  connection: SessionConnection;
  relayMessages: RelayRecord[];
} {
  const relayMessages: RelayRecord[] = [];
  let nextRpcId = 0;
  const connection: SessionConnection = {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "ses-1",
    agentStatusReceived: true,
    sessionLoaded: true,
    workspacePath: "/workspace/org-1/user-1/env-1",
    lastClientKeepalive: 0,
    sendToRelay: (message) => {
      const record = message as unknown as RelayRecord;
      relayMessages.push(record);
    },
    getNextRpcId: () => ++nextRpcId,
    awaitSessionMutation: () => ({ completed: Promise.resolve(true), cancel: () => {} }),
    ...overrides,
  };
  return { connection, relayMessages };
}

export function createSinks(harness: TestHarness): {
  sendAck: (ack: ActionAck) => void;
  sendError: (err: ActionError) => void;
} {
  return {
    sendAck: (ack) => harness.acks.push(ack),
    sendError: (err) => harness.errorFrames.push(err),
  };
}

/** 断言用户消息已投影为 user entry（时间线在 Chat Doc） */
export function readEntryIds(ydoc: Y.Doc): string[] {
  return Array.from(getEntriesMap(ydoc).keys()).sort();
}

/**
 * 轮询等待 activeTurnStatus 变为期望值（替代固定 setTimeout 等待：
 * CI 高负载下固定时长可能不足导致 flaky，轮询以状态变化为收敛条件）。
 */
export async function waitForTurnStatus(
  sessionDoc: Y.Doc | null | undefined,
  expected: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`activeTurnStatus did not become "${expected}" within ${timeoutMs}ms`);
}
