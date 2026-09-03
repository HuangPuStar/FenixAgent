import type { Window } from "happy-dom";

const ERROR_CONSTRUCTORS = [
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
] as const;

/**
 * happy-dom does not populate every standard error constructor on Window.
 * Its internal validation/parsing paths instantiate them through the Window,
 * so each test-owned Window must receive the host constructors explicitly.
 */
export function initializeHappyDomWindow<T extends Window>(window: T): T {
  const record = window as unknown as Record<string, unknown>;
  for (const key of ERROR_CONSTRUCTORS) {
    record[key] = globalThis[key];
  }
  return window;
}
