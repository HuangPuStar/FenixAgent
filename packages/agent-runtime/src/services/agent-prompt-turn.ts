import { extractJsonRpc } from "@fenix/chat-channel";
import { error as logError } from "@fenix/logger";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { type AgentSessionTurnLease, acquireAgentSessionTurn } from "./agent-session-admission";
import { classifyAgentTurnEvent, waitWithSignal } from "./agent-turn-events";

let rpcIdSeq = Math.floor(Math.random() * 1_000_000) * 1_000;
function nextRpcId(): number {
  return ++rpcIdSeq;
}

/** A request holds a consumer lease; dispose never stops the persistent runtime. */
export interface AgentSession {
  relayHandle: EngineRelayHandle;
  instanceId: string;
  dispose(): Promise<void>;
}
/** Session handshake options. */
export interface PromptTurnStartOptions {
  session: AgentSession;
  sessionId?: string;
  prepareNewSession?: () => Promise<void>;
  signal?: AbortSignal;
  /** Bounded handshake timeout; configurable for deterministic regression coverage. */
  handshakeTimeoutMs?: number;
  /** Release execution admission only after a confirmed terminal or before any prompt. */
  onExecutionFinished?: () => void;
}
/** One confirmed ACP session prompt, with its own cancellation and consumption lifetime. */
export interface PromptTurn {
  prompt(content: Array<{ type: string; text: string; resource?: unknown }>): void;
  events(): AsyncIterable<EngineRelayMessage>;
  /** Send session/cancel for this turn and wake its pending event consumer. */
  cancel(): Promise<void>;
  /** Unsubscribe and release this turn's relay lease. */
  release(): void;
  dispose(): Promise<void>;
}

/** Wrap the runtime's consumer lease in a request session. */
export function createAgentSession(config: { relayHandle: EngineRelayHandle; instanceId: string }): AgentSession {
  let disposed = false;
  return {
    relayHandle: config.relayHandle,
    instanceId: config.instanceId,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await config.relayHandle.close(1000, "request complete");
    },
  };
}

function isTurnMessage(message: EngineRelayMessage, sessionId: string, turnId: number): boolean {
  if (message.type === "error" || message.type === "relay_closed") return true;
  const rpc = extractJsonRpc(message);
  if (!rpc) return false;
  if (rpc.method === "session/update") {
    return (rpc.params as Record<string, unknown> | undefined)?.sessionId === sessionId;
  }
  return rpc.id === turnId;
}

/** Register an isolated event consumer for a confirmed session. */
export function createPromptTurn(
  session: AgentSession,
  sessionId: string,
  signal?: AbortSignal,
  onExecutionFinished?: () => void,
): PromptTurn {
  return createPromptTurnWithLease(
    session,
    sessionId,
    signal,
    onExecutionFinished,
    acquireAgentSessionTurn(session.instanceId, sessionId),
  );
}

function createPromptTurnWithLease(
  session: AgentSession,
  sessionId: string,
  signal: AbortSignal | undefined,
  onExecutionFinished: (() => void) | undefined,
  sessionLease: AgentSessionTurnLease,
): PromptTurn {
  const turnId = nextRpcId();
  const queue: EngineRelayMessage[] = [];
  let resolveNext: ((value: IteratorResult<EngineRelayMessage>) => void) | undefined;
  let done = false;
  let prompted = false;
  let terminal = false;
  let disconnected = false;
  let released = false;
  let cancelRequested = false;
  let cancellationId: number | undefined;
  let unsubscribe: (() => void) | undefined;
  const finish = (): void => {
    done = true;
    resolveNext?.({ value: undefined, done: true });
    resolveNext = undefined;
  };
  const push = (message: EngineRelayMessage): void => {
    if (done) return;
    if (queue.length >= 5000) {
      queue.length = 0;
      message = { type: "error", payload: { code: "turn_event_overflow" } };
    }
    queue.push(message);
    if (classifyAgentTurnEvent(message)) done = true;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = undefined;
      resolve({ value: queue.shift()!, done: false });
    }
  };
  const closeSession = (): void => {
    unsubscribe?.();
    void session.dispose().catch((error) => logError("[agent-turn] Session release failed", error));
  };
  unsubscribe = session.relayHandle.onMessage?.((message) => {
    const rpc = extractJsonRpc(message);
    if (cancellationId !== undefined && rpc?.id === cancellationId) {
      if (rpc.error) logError("[agent-turn] Agent cancellation rejected", rpc.error);
      return;
    }
    if (!isTurnMessage(message, sessionId, turnId)) return;
    const outcome = classifyAgentTurnEvent(message);
    if (outcome && outcome.outcome !== "unknown") {
      if (extractJsonRpc(message)) {
        terminal = true;
        sessionLease.release();
        onExecutionFinished?.();
      }
      if (outcome.outcome === "disconnected") disconnected = true;
      if (released && (terminal || disconnected)) {
        closeSession();
        return;
      }
    }
    push(message);
  });
  const release = (): void => {
    if (released) return;
    released = true;
    finish();
    signal?.removeEventListener("abort", onAbort);
    // An unacknowledged cancellation remains active; retain only its filtered terminal observer.
    if (!prompted || terminal || disconnected) {
      if (!prompted) {
        sessionLease.release();
        onExecutionFinished?.();
      }
      closeSession();
    }
  };
  const cancel = async (): Promise<void> => {
    if (cancelRequested || (released && !prompted)) return;
    cancelRequested = true;
    try {
      if (prompted && !terminal && !disconnected) {
        cancellationId = nextRpcId();
        const sent = session.relayHandle.send({
          jsonrpc: "2.0",
          id: cancellationId,
          method: "session/cancel",
          params: { sessionId },
        } as unknown as EngineRelayMessage);
        if (sent) void sent.catch((error) => logError("[agent-turn] Cancellation delivery failed", error));
      }
    } finally {
      release();
    }
  };
  const onAbort = (): void => {
    void cancel().catch((error) => logError("[agent-turn] Cancellation delivery failed", error));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    prompt(content) {
      signal?.throwIfAborted();
      if (done || released) throw new Error("Prompt turn is closed");
      prompted = true;
      const message = { jsonrpc: "2.0", id: turnId, method: "session/prompt", params: { sessionId, content } };
      try {
        const sent = session.relayHandle.send(message as unknown as EngineRelayMessage);
        if (sent)
          void sent.catch((error) => {
            logError("[agent-turn] Prompt send failed", error);
            push({ type: "error" });
          });
      } catch (error) {
        release();
        throw error;
      }
    },
    events() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineRelayMessage>> {
              if (queue.length) return { value: queue.shift()!, done: false };
              if (done) return { value: undefined, done: true };
              return new Promise((resolve) => {
                resolveNext = resolve;
              });
            },
            async return() {
              release();
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
    cancel,
    release,
    async dispose() {
      await cancel();
    },
  };
}

/** Only an explicit matching session/new or session/load acknowledgement permits a prompt. */
export async function startPromptTurn(
  options: PromptTurnStartOptions,
): Promise<{ turn: PromptTurn; session: AgentSession }> {
  const { session, signal } = options;
  signal?.throwIfAborted();
  if (!options.sessionId && options.prepareNewSession) {
    await waitWithSignal(options.prepareNewSession(), signal);
    signal?.throwIfAborted();
  }
  if (!session.relayHandle.onMessage) throw new Error("Relay does not support session acknowledgements");
  let sessionLease = options.sessionId ? acquireAgentSessionTurn(session.instanceId, options.sessionId) : undefined;
  let sent = false;
  let acknowledged = false;
  let sessionId: string;
  try {
    const rpcId = nextRpcId();
    sessionId = await new Promise<string>((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: unknown, id?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(id!);
      };
      const onAbort = (): void => settle(signal?.reason ?? new DOMException("Request aborted", "AbortError"));
      timer = setTimeout(
        () => settle(new Error("ACP session handshake timed out; session state is unconfirmed")),
        options.handshakeTimeoutMs ?? 30_000,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      unsubscribe = session.relayHandle.onMessage!((message) => {
        if (message.type === "error" || message.type === "relay_closed") {
          settle(new Error("Relay failed during session handshake"));
          return;
        }
        const rpc = extractJsonRpc(message);
        if (rpc?.id !== rpcId) return;
        acknowledged = true;
        if (rpc.error) {
          const message =
            typeof rpc.error === "object" && rpc.error && "message" in rpc.error ? rpc.error.message : undefined;
          settle(new Error(typeof message === "string" ? message : "ACP session handshake rejected"));
          return;
        }
        if (!("result" in rpc)) {
          settle(new Error("ACP session acknowledgement missing result"));
          return;
        }
        const result = rpc.result as { id?: unknown; sessionId?: unknown } | null;
        const id = result?.sessionId ?? result?.id ?? options.sessionId;
        if (typeof id !== "string" || id.length === 0) {
          settle(new Error("ACP session acknowledgement missing sessionId"));
          return;
        }
        if (options.sessionId && id !== options.sessionId) {
          settle(new Error("ACP session acknowledgement does not match requested sessionId"));
          return;
        }
        settle(undefined, id);
      });
      if (settled) {
        unsubscribe();
        return;
      }
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        sent = true;
        const sending = session.relayHandle.send({
          jsonrpc: "2.0",
          id: rpcId,
          method: options.sessionId ? "session/load" : "session/new",
          params: options.sessionId ? { sessionId: options.sessionId } : {},
        } as unknown as EngineRelayMessage);
        if (sending) void sending.catch((error) => settle(error));
      } catch (error) {
        settle(error);
      }
    });
    signal?.throwIfAborted();
    sessionLease ??= acquireAgentSessionTurn(session.instanceId, sessionId);
    return {
      turn: createPromptTurnWithLease(session, sessionId, signal, options.onExecutionFinished, sessionLease),
      session,
    };
  } catch (error) {
    // An unacknowledged load may still be executing; its session remains fenced until runtime stop.
    if (!sent || acknowledged) sessionLease?.release();
    throw error;
  }
}
