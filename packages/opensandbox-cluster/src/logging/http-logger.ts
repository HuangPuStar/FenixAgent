import { createLogger, requestAls } from "@fenix/logger";
import { ElysiaCustomStatusResponse, StatusMap, ValidationError } from "elysia";
import { type BodyPreview, previewBody, previewValue } from "./body-preview";
import { redactLogValue } from "./redact";

/** Minimal logging port for deterministic HTTP behavior tests. */
export interface HttpLogSink {
  info(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}
interface RequestState {
  id: string;
  startedAt: number;
  request: Record<string, unknown>;
  pending: Promise<void>;
  response?: Promise<BodyPreview>;
}
interface ResponseContext {
  request: Request;
  responseValue?: unknown;
  set: { status?: number | string };
  error?: unknown;
}
const failures = new WeakMap<Request, unknown>();

/** Preserve failures that protocol adapters turn into normal Response objects. */
export function recordRequestError(request: Request, error: unknown): void {
  if (!failures.has(request)) failures.set(request, error);
}
function responseValue(value: unknown): unknown {
  return value instanceof ElysiaCustomStatusResponse ? value.response : value;
}
function describeError(error: unknown, secrets: readonly string[]): unknown {
  if (error instanceof ValidationError)
    return {
      type: error.name,
      message: "request validation failed",
      validationType: error.type,
      field: error.all[0]?.path,
    };
  if (error instanceof Error && error.cause !== undefined)
    return {
      ...(redactLogValue(error, secrets) as Record<string, unknown>),
      cause: redactLogValue(error.cause, secrets),
    };
  return error;
}

/** Elysia lifecycle hooks log completed exchanges without wrapping or buffering live HTTP responses. */
export function createRequestLogging(secrets: readonly string[], sink: HttpLogSink = createLogger("cluster.http")) {
  const states = new WeakMap<Request, RequestState>();
  const clean = (value: unknown) => redactLogValue(value, secrets) as Record<string, unknown>;
  return {
    start({ request, set }: { request: Request; set: { headers: Record<string, string | number> } }): void {
      const id = crypto.randomUUID();
      requestAls.enterWith({ requestId: id });
      set.headers["X-Request-Id"] = id;
      const url = new URL(request.url);
      const summary = {
        method: request.method,
        path: url.pathname.replace(/(\/internal\/frp\/plugin\/)[^/]+/, "$1[REDACTED]"),
        search: Object.fromEntries(url.searchParams),
        mime: request.headers.get("content-type"),
      };
      const state: RequestState = { id, startedAt: performance.now(), request: summary, pending: Promise.resolve() };
      states.set(request, state);
      state.pending = previewBody(request).then((preview) => {
        sink.info("HTTP request", clean({ requestId: id, request: { ...summary, ...preview } }));
      });
    },
    captureResponse({ request, responseValue: value }: ResponseContext): void {
      const state = states.get(request);
      if (!state) return;
      const result = responseValue(value);
      state.response = result instanceof Response ? previewBody(result) : Promise.resolve(previewValue(result));
    },
    async finish({ request, responseValue: value, set, error }: ResponseContext): Promise<void> {
      const state = states.get(request);
      if (!state) return;
      const elapsed = Math.round((performance.now() - state.startedAt) * 100) / 100;
      const result = responseValue(value);
      const setStatus = typeof set.status === "string" ? StatusMap[set.status as keyof typeof StatusMap] : set.status;
      const status =
        setStatus && setStatus !== 200
          ? setStatus
          : value instanceof ElysiaCustomStatusResponse
            ? value.code
            : result instanceof Response
              ? result.status
              : (setStatus ?? 200);
      await state.pending;
      const preview = await (state.response ??
        (result instanceof Response ? previewBody(result) : previewValue(result)));
      const failure = failures.get(request) ?? error;
      const fields = clean({
        requestId: state.id,
        request: state.request,
        response: { status, durationMs: elapsed, ...preview },
        ...(failure ? { error: describeError(failure, secrets) } : {}),
      });
      if (status >= 400 || failure) sink.error("HTTP response", fields);
      else sink.info("HTTP response", fields);
      states.delete(request);
      failures.delete(request);
    },
  };
}
