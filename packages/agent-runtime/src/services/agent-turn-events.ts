import { extractJsonRpc } from "@fenix/chat-channel";
import { error as logError } from "@fenix/logger";

/** Confirmed ACP turn outcome; absence of a terminal event never proves success. */
export type AgentTurnOutcome = "succeeded" | "failed" | "cancelled" | "disconnected" | "unknown";
/** Protocol terminal classification shared by API, workflow and scheduler adapters. */
export interface AgentTurnTerminal {
  outcome: AgentTurnOutcome;
  stopReason?: string;
}

/** Classify raw and wrapped ACP frames without treating arbitrary RPC results as success. */
export function classifyAgentTurnEvent(event: unknown): AgentTurnTerminal | null {
  if (!event || typeof event !== "object") return null;
  const message = event as Record<string, unknown>;
  if (message.type === "relay_closed") return { outcome: "disconnected" };
  if (message.type === "error") return { outcome: "failed" };
  const rpc = extractJsonRpc(event);
  if (!rpc) return null;
  if (rpc.error) return { outcome: "failed" };
  const result = rpc.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") return null;
  if (result.error) return { outcome: "failed" };
  const stopReason = result.stopReason;
  if (typeof stopReason !== "string") return "id" in rpc ? { outcome: "unknown" } : null;
  if (["end_turn", "max_tokens", "max_turn_requests", "refusal"].includes(stopReason)) {
    return { outcome: "succeeded", stopReason };
  }
  if (["cancelled", "canceled"].includes(stopReason)) return { outcome: "cancelled", stopReason };
  return { outcome: stopReason === "error" ? "failed" : "unknown", stopReason };
}

/** Abort pending work immediately; optionally reclaim a resource that arrives after cancellation. */
export async function waitWithSignal<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (!signal) return work;
  let aborted = false;
  const reclaim = (value: T): void => {
    Promise.resolve()
      .then(() => onLateValue?.(value))
      .catch((error) => logError("[agent-turn] Late resource release failed", error));
  };
  if (signal.aborted) {
    work.then(reclaim, () => {});
    throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  }
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      aborted = true;
      reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  work.then(
    (value) => {
      if (aborted) reclaim(value);
    },
    () => {},
  );
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Cancel the wait for next(), including silent transports that never emit another frame. */
export async function* iterateWithSignal<T>(events: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  const iterator = events[Symbol.asyncIterator]();
  try {
    while (true) {
      signal?.throwIfAborted();
      const event = await waitWithSignal(iterator.next(), signal);
      if (event.done) return;
      yield event.value;
    }
  } finally {
    // Awaiting return() on a generator blocked in next() would recreate the cancelled wait.
    Promise.resolve()
      .then(() => iterator.return?.())
      .catch((error) => logError("[agent-turn] Iterator release failed", error));
  }
}
