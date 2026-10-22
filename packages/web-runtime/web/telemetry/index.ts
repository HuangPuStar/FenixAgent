import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { XMLHttpRequestInstrumentation } from "@opentelemetry/instrumentation-xml-http-request";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { onCLS, onINP, onLCP } from "web-vitals";
import { createWebPerformanceInstruments } from "./buckets";

import { activateBrowserTelemetry, pageType, reportBrowserError } from "./events";

export { pageType, recordBrowserEvent, reportBrowserError } from "./events";

let installed = false;
let flush: (() => Promise<unknown>) | undefined;

class BrowserPrivacyProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}
  onStart(span: Span, parent: Parameters<SpanProcessor["onStart"]>[1]): void {
    this.delegate.onStart(span, parent);
  }
  onEnd(span: ReadableSpan): void {
    for (const key of Object.keys(span.attributes)) {
      if (
        !["http.method", "http.status_code", "http.request.method", "http.response.status_code", "error.type"].includes(
          key,
        )
      )
        delete span.attributes[key];
    }
    // 插件默认 Span 名称可能包含 URL；页面类别足够支撑初版请求排障。
    const safe = {
      ...span,
      name: "browser.request",
      events: [],
      resource: span.resource,
      instrumentationScope: span.instrumentationScope,
      spanContext: () => span.spanContext(),
    };
    this.delegate.onEnd(safe);
  }
  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

/** 一个页面只安装一套 Provider；默认关闭，不向浏览器下发长期采集凭据。 */
export function initializeBrowserTelemetry(options: { enabled: boolean; version: string; environment?: string }): void {
  if (installed || !options.enabled || typeof window === "undefined") return;
  installed = true;
  const resource = resourceFromAttributes({
    "service.name": "fenix-web",
    "service.namespace": "fenix",
    "service.version": options.version,
    "deployment.environment.name": options.environment ?? "production",
    "fenix.telemetry.source": "browser",
  });
  const base = `${window.location.origin}/otel/v1`;
  const batch = { maxQueueSize: 64, maxExportBatchSize: 16, scheduledDelayMillis: 5000, exportTimeoutMillis: 3000 };
  const tracer = new WebTracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.1) }),
    spanLimits: { attributeCountLimit: 16, attributeValueLengthLimit: 256, eventCountLimit: 0 },
    spanProcessors: [
      new BrowserPrivacyProcessor(
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${base}/traces`, timeoutMillis: 3000, concurrencyLimit: 1 }),
          batch,
        ),
      ),
    ],
  });
  tracer.register({ contextManager: new ZoneContextManager(), propagator: new W3CTraceContextPropagator() });
  const logger = new LoggerProvider({
    resource,
    logRecordLimits: { attributeCountLimit: 8, attributeValueLengthLimit: 256 },
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${base}/logs`, timeoutMillis: 3000, concurrencyLimit: 1 }),
        batch,
      ),
    ],
  });
  logs.setGlobalLoggerProvider(logger);
  const metricProvider = new MeterProvider({
    resource,
    views: [{ instrumentName: "*", aggregationCardinalityLimit: 64 }],
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${base}/metrics`,
          timeoutMillis: 3000,
          concurrencyLimit: 1,
          temporalityPreference: AggregationTemporality.CUMULATIVE,
        }),
        exportIntervalMillis: 15_000,
        exportTimeoutMillis: 3000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(metricProvider);
  activateBrowserTelemetry();
  const origin = window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allowed = new RegExp(`^${origin}/(?:web|api|acp)/`);
  const ignored = [new RegExp(`^(?!${origin}/(?:web|api|acp)/)`), /\/otel\//];
  registerInstrumentations({
    tracerProvider: tracer,
    meterProvider: metricProvider,
    instrumentations: [
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: [allowed],
        ignoreUrls: ignored,
        clearTimingResources: true,
      }),
      new XMLHttpRequestInstrumentation({
        propagateTraceHeaderCorsUrls: [allowed],
        ignoreUrls: ignored,
        clearTimingResources: true,
      }),
    ],
  });
  const { lcp, inp, cls } = createWebPerformanceInstruments(metrics.getMeter("@fenix/web-runtime"));
  onLCP((value) => lcp.record(value.value, { page: pageType() }));
  onINP((value) => inp.record(value.value, { page: pageType() }));
  onCLS((value) => cls.record(value.value, { page: pageType() }));
  window.addEventListener("error", (event) => reportBrowserError(event.error));
  window.addEventListener("unhandledrejection", (event) => reportBrowserError(event.reason));
  flush = () => Promise.all([tracer.forceFlush(), logger.forceFlush(), metricProvider.forceFlush()]);
  window.addEventListener("pagehide", () => {
    void flush?.().catch(() => {});
  });
}
