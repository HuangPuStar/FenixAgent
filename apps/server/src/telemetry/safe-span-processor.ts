import { sanitizeLogText } from "@fenix/logger/sanitize";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

const FORBIDDEN =
  /(?:db\.(?:statement|query\.text|query\.parameter.*)|.*(?:password|token|authorization|cookie|body|prompt|completion|cmdArgs).*)/i;

/** 在批量导出前移除第三方插件默认附带的 SQL、正文与自由 URL，不改变业务 Span 生命周期。 */
export class SafeSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}
  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }
  onEnd(span: ReadableSpan): void {
    for (const key of Object.keys(span.attributes)) {
      if (FORBIDDEN.test(key) || key === "url.query" || key === "url.full" || key === "url.path")
        delete span.attributes[key];
      else if (typeof span.attributes[key] === "string") span.attributes[key] = sanitizeLogText(span.attributes[key]);
    }
    for (const event of span.events) {
      if (!event.attributes) continue;
      for (const key of Object.keys(event.attributes)) {
        if (FORBIDDEN.test(key) || key === "exception.message") delete event.attributes[key];
        else if (typeof event.attributes[key] === "string")
          event.attributes[key] = sanitizeLogText(
            key.endsWith("stacktrace") || key.endsWith("stack")
              ? event.attributes[key].split("\n").slice(1).join("\n")
              : event.attributes[key],
          );
      }
    }
    this.delegate.onEnd({
      ...span,
      status: { code: span.status.code },
      resource: span.resource,
      instrumentationScope: span.instrumentationScope,
      spanContext: () => span.spanContext(),
    });
  }
  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}
