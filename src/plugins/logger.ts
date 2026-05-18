import Elysia from "elysia";
import { error, log } from "../logger";

let _requestCounter = 0;

function nextRequestId(): string {
  _requestCounter = (_requestCounter + 1) % 1_000_000;
  const ts = Date.now().toString(36);
  const seq = _requestCounter.toString(36).padStart(4, "0");
  return `req-${ts}-${seq}`;
}

export const loggerPlugin = new Elysia({ name: "logger" })
  .derive(({ request }) => {
    const requestId = nextRequestId();
    (request as any).__requestId = requestId;
    (request as any).__startTime = performance.now();
    return { requestId };
  })
  .onBeforeHandle(({ request }) => {
    const id = (request as any).__requestId as string;
    const url = new URL(request.url);
    if (url.pathname !== "/health") {
      log(`--> ${request.method} ${url.pathname} [${id}]`);
    }
  })
  .onAfterHandle(({ request }) => {
    const start = (request as any).__startTime as number | undefined;
    const id = (request as any).__requestId as string;
    const duration = start != null ? (performance.now() - start).toFixed(2) : "-";
    const url = new URL(request.url);
    if (url.pathname !== "/health") {
      log(`<-- ${request.method} ${url.pathname} ${duration}ms [${id}]`);
    }
  })
  .onError(({ request, error: err }) => {
    const start = (request as any).__startTime as number | undefined;
    const id = (request as any).__requestId as string;
    const duration = start != null ? (performance.now() - start).toFixed(2) : "-";
    const url = new URL(request.url);
    error(
      `<-- ${request.method} ${url.pathname} ${duration}ms (error: ${err instanceof Error ? err.message : String(err)}) [${id}]`,
    );
  });
