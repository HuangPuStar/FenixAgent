import { createRequire } from "node:module";
import { DiagLogLevel, diag } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOffSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { buildInfo } from "../services/build-info";
import { parseTelemetryConfig, type TelemetryConfig } from "./config";
import { SafeSpanProcessor } from "./safe-span-processor";

let sdk: NodeSDK | undefined;
let initialized = false;
let shutdownPromise: Promise<void> | undefined;
let enabled = false;
let lastDiagnostic = 0;

/** SDK 诊断不走 Pino；关闭路径可绕过限频，避免最后一条原因被节流吞掉。 */
export function telemetryDiagnostic(message: string, force = false): void {
  if (!force && Date.now() - lastDiagnostic < 30_000) return;
  lastDiagnostic = Date.now();
  process.stderr.write(`[telemetry] ${message}\n`);
}

/** 总预算覆盖所有 Provider，重复信号共享同一关闭结果。 */
export async function boundedShutdown(shutdown: () => Promise<void>, budgetMs = 5000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(shutdown)
        .catch(() => telemetryDiagnostic("SDK 关闭失败，继续退出", true)),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          telemetryDiagnostic("SDK 关闭超时，继续退出", true);
          resolve();
        }, budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 只由轻量进程入口调用；在任何被采集的业务依赖首次加载前安装。 */
export function initializeTelemetry(config: TelemetryConfig = parseTelemetryConfig()): void {
  if (initialized) return;
  initialized = true;
  if (!config.enabled) {
    telemetryDiagnostic("SDK 已关闭：显式禁用或未配置 OTLP endpoint");
    return;
  }
  diag.setLogger(
    {
      error: () => telemetryDiagnostic("遥测导出失败，业务继续运行"),
      warn: () => telemetryDiagnostic("遥测数据受限或插件不可用"),
      info() {},
      debug() {},
      verbose() {},
    },
    DiagLogLevel.WARN,
  );
  const { env, urls, headers } = config;
  const exporterOptions = { headers, timeoutMillis: env.OTEL_EXPORTER_OTLP_TIMEOUT, concurrencyLimit: 1 };
  const pg = new PgInstrumentation({
    enabled: config.instrumentations.includes("pg"),
    enhancedDatabaseReporting: false,
    requireParentSpan: false,
  });
  const redis = new IORedisInstrumentation({
    enabled: config.instrumentations.includes("ioredis"),
    requireParentSpan: false,
    dbStatementSerializer: (command) => command.toUpperCase(),
  });
  const pino = new PinoInstrumentation({ enabled: config.instrumentations.includes("pino") });
  sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({
      ...config.attributes,
      "service.name": env.OTEL_SERVICE_NAME,
      "service.version": buildInfo.commitId,
      "service.instance.id": crypto.randomUUID(),
      "fenix.telemetry.source": "server",
    }),
    contextManager: new AsyncLocalStorageContextManager(),
    textMapPropagator: new W3CTraceContextPropagator(),
    sampler:
      env.OTEL_TRACES_EXPORTER === "none"
        ? new AlwaysOffSampler()
        : new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(env.OTEL_TRACES_SAMPLER_ARG) }),
    spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 2048, eventCountLimit: 16, linkCountLimit: 8 },
    spanProcessors:
      env.OTEL_TRACES_EXPORTER === "none"
        ? [{ onStart() {}, onEnd() {}, async forceFlush() {}, async shutdown() {} }]
        : [
            new SafeSpanProcessor(
              new BatchSpanProcessor(new OTLPTraceExporter({ ...exporterOptions, url: urls.traces }), {
                maxQueueSize: 1024,
                maxExportBatchSize: 128,
                scheduledDelayMillis: 1000,
                exportTimeoutMillis: 3000,
              }),
            ),
          ],
    logRecordProcessors:
      env.OTEL_LOGS_EXPORTER === "none"
        ? []
        : [
            new BatchLogRecordProcessor(new OTLPLogExporter({ ...exporterOptions, url: urls.logs }), {
              maxQueueSize: 1024,
              maxExportBatchSize: 128,
              scheduledDelayMillis: 1000,
              exportTimeoutMillis: 3000,
            }),
          ],
    metricReaders:
      env.OTEL_METRICS_EXPORTER === "none"
        ? []
        : [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({
                ...exporterOptions,
                url: urls.metrics,
                temporalityPreference: AggregationTemporality.CUMULATIVE,
              }),
              exportIntervalMillis: env.OTEL_METRIC_EXPORT_INTERVAL,
              exportTimeoutMillis: Math.min(env.OTEL_EXPORTER_OTLP_TIMEOUT, env.OTEL_METRIC_EXPORT_INTERVAL),
            }),
          ],
    views: [{ instrumentName: "*", aggregationCardinalityLimit: 2048 }],
    instrumentations: [pg, redis, pino],
  });
  sdk.start();
  // Bun 的 ESM import 不消费 require hook 返回值；写回同一缓存让业务 import 使用社区补丁。
  const require = createRequire(import.meta.url);
  const loggerRequire = createRequire(require.resolve("@fenix/logger"));
  const pgRequire = createRequire(require.resolve("pg"));
  for (const [name, loader] of [
    ["pino", loggerRequire],
    ["pg-pool", pgRequire],
    ["pg", require],
    ["ioredis", require],
  ] as const) {
    if (!(name === "pg-pool" ? config.instrumentations.includes("pg") : config.instrumentations.includes(name)))
      continue;
    const id = loader.resolve(name);
    const patched = loader(id);
    const cached = loader.cache[id];
    if (cached) cached.exports = patched;
  }
  enabled = true;
}

/** 官方 HTTP 插件仅在宿主 Provider 已安装时注册，关闭路径不触发插件自建 SDK。 */
export function isTelemetryEnabled(): boolean {
  return enabled;
}

/** 宿主在最后一条业务退出日志后调用。 */
export function shutdownTelemetry(): Promise<void> {
  shutdownPromise ??= boundedShutdown(async () => {
    await sdk?.shutdown();
  });
  return shutdownPromise;
}
