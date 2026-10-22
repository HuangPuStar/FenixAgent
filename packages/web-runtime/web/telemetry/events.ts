import { metrics } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { browserSecondsAdvice } from "./buckets";

let enabled = false;
let errorWindow = 0;
let errorCount = 0;
const recentErrors = new WeakSet<object>();

/** 由浏览器 SDK 装配调用，领域事件不反向加载 SDK/exporter。 */
export function activateBrowserTelemetry(): void {
  enabled = true;
}

/** 页面只按固定类别聚合，不使用 URL 或用户身份作标签。 */
export function pageType(path = typeof location === "undefined" ? "" : location.pathname): string {
  if (path.includes("/agent/chat/")) return "chat";
  if (path.includes("/login")) return "login";
  return "console";
}

/** 业务事件直接调用标准 API；关闭状态不保存事件或访客状态。 */
export function recordBrowserEvent(
  event: "disconnect" | "reconnect" | "history_ready" | "history_failure",
  durationMs?: number,
): void {
  if (!enabled) return;
  const meter = metrics.getMeter("@fenix/web-runtime");
  meter.createCounter("fenix.web.events").add(1, { event, page: pageType() });
  logs
    .getLogger("@fenix/web-runtime")
    .emit({ severityNumber: SeverityNumber.INFO, body: event, attributes: { event, page: pageType() } });
  if (durationMs !== undefined && Number.isFinite(durationMs))
    meter
      .createHistogram("fenix.web.history.duration", { unit: "s", advice: browserSecondsAdvice })
      .record(Math.max(0, durationMs) / 1000, {
        page: pageType(),
        result: event === "history_ready" ? "success" : "failure",
      });
}

/** 错误只记录有限类型；原始 message/stack 可能包含用户正文。 */
export function reportBrowserError(error: unknown): void {
  if (!enabled) return;
  if (typeof error === "object" && error !== null) {
    if (recentErrors.has(error)) return;
    recentErrors.add(error);
  }
  if (Date.now() - errorWindow >= 60_000) {
    errorWindow = Date.now();
    errorCount = 0;
  }
  if (++errorCount > 10) return;
  const type = error instanceof TypeError ? "TypeError" : error instanceof SyntaxError ? "SyntaxError" : "Error";
  metrics
    .getMeter("@fenix/web-runtime")
    .createCounter("fenix.web.events")
    .add(1, { event: "error", page: pageType(), "error.type": type });
  logs.getLogger("@fenix/web-runtime").emit({
    severityNumber: SeverityNumber.ERROR,
    body: "browser.error",
    attributes: { "error.type": type, page: pageType() },
  });
}
