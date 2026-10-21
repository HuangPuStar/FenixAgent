import { createSharedRelay } from "./connection-test-helpers";
import type { SharedRelay } from "./connection-types";

/** 构造挂在 rcs-1 上的共享 relay（handle 可覆写） */
export function relayOn(rcsSessionId: string, handleOverrides: Partial<SharedRelay["handle"]> = {}): SharedRelay {
  return createSharedRelay({ rcsSessionId, handle: { state: "open", send() {}, close() {}, ...handleOverrides } });
}
