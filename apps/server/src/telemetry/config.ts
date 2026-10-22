import { z } from "zod/v4";

const positiveMs = (fallback: number) => z.coerce.number().int().min(100).max(60_000).default(fallback);
const endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "OTLP endpoint 必须是无凭据、query 和 fragment 的 HTTP(S) URL");
/** 所有 OTEL_* 字符串统一按空白=未配置处理，避免空串改变默认或触发部署错误。 */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema);
const optionalEndpoint = blankAsUnset(endpoint.optional());

/** SDK 入口与宿主环境生成器共享声明，避免初始化前后出现不同默认值。 */
export const telemetryEnvSchema = z.object({
  OTEL_SDK_DISABLED: blankAsUnset(z.enum(["true", "false"]).default("false")),
  OTEL_SERVICE_NAME: blankAsUnset(z.string().min(1).max(128).default("fenix-server")),
  OTEL_RESOURCE_ATTRIBUTES: blankAsUnset(
    z.string().max(4096).default("service.namespace=fenix,deployment.environment.name=development"),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalEndpoint,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: optionalEndpoint,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: optionalEndpoint,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: optionalEndpoint,
  OTEL_EXPORTER_OTLP_PROTOCOL: blankAsUnset(z.literal("http/protobuf").default("http/protobuf")),
  OTEL_EXPORTER_OTLP_HEADERS: blankAsUnset(z.string().max(4096).optional()),
  OTEL_EXPORTER_OTLP_TIMEOUT: blankAsUnset(positiveMs(3000)),
  OTEL_TRACES_EXPORTER: blankAsUnset(z.enum(["otlp", "none"]).default("otlp")),
  OTEL_METRICS_EXPORTER: blankAsUnset(z.enum(["otlp", "none"]).default("otlp")),
  OTEL_LOGS_EXPORTER: blankAsUnset(z.enum(["otlp", "none"]).default("otlp")),
  OTEL_METRIC_EXPORT_INTERVAL: blankAsUnset(z.coerce.number().int().min(1000).max(300_000).default(15_000)),
  OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: blankAsUnset(z.literal("cumulative").default("cumulative")),
  OTEL_TRACES_SAMPLER: blankAsUnset(z.literal("parentbased_traceidratio").default("parentbased_traceidratio")),
  OTEL_TRACES_SAMPLER_ARG: blankAsUnset(z.coerce.number().min(0).max(1).default(0.1)),
  OTEL_NODE_ENABLED_INSTRUMENTATIONS: blankAsUnset(z.string().default("pg,ioredis,pino")),
  OTEL_BROWSER_COLLECTOR_ENDPOINT: optionalEndpoint,
});

/** 已校验且不包含业务连接信息的 SDK 配置。 */
export type TelemetryConfig = ReturnType<typeof parseTelemetryConfig>;

/** 明确启用的语法错误是部署错误；未配置地址时绝不回退 localhost。 */
export function parseTelemetryConfig(input: unknown = process.env) {
  const env = telemetryEnvSchema.parse(input);
  const instrumentations = env.OTEL_NODE_ENABLED_INSTRUMENTATIONS.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (instrumentations.some((name) => !["pg", "ioredis", "pino"].includes(name))) {
    throw new Error("OTEL_NODE_ENABLED_INSTRUMENTATIONS 只允许 pg,ioredis,pino");
  }
  const attributes: Record<string, string> = {};
  for (const pair of env.OTEL_RESOURCE_ATTRIBUTES.split(",").filter(Boolean)) {
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator).trim();
    if (separator <= 0 || !["service.namespace", "deployment.environment.name", "host.id", "host.name"].includes(key)) {
      throw new Error("OTEL_RESOURCE_ATTRIBUTES 包含非法或受保护的资源字段");
    }
    const value = pair.slice(separator + 1).trim();
    if (!value || value.length > 128) throw new Error("OTEL_RESOURCE_ATTRIBUTES 字段长度无效");
    attributes[key] = value;
  }
  const headers: Record<string, string> = {};
  for (const pair of env.OTEL_EXPORTER_OTLP_HEADERS?.split(",").filter(Boolean) ?? []) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error("OTEL_EXPORTER_OTLP_HEADERS 格式无效");
    headers[pair.slice(0, separator).trim()] = decodeURIComponent(pair.slice(separator + 1).trim());
  }
  const urls = {
    traces:
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      (env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces` : undefined),
    metrics:
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
      (env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/metrics`
        : undefined),
    logs:
      env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
      (env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/logs` : undefined),
  };
  const enabled = env.OTEL_SDK_DISABLED !== "true" && Object.values(urls).some(Boolean);
  for (const signal of ["traces", "metrics", "logs"] as const) {
    const exporter = {
      traces: env.OTEL_TRACES_EXPORTER,
      metrics: env.OTEL_METRICS_EXPORTER,
      logs: env.OTEL_LOGS_EXPORTER,
    }[signal];
    if (enabled && exporter !== "none" && !urls[signal]) throw new Error(`OTLP ${signal} 缺少 endpoint`);
  }
  return { env, enabled, urls, attributes, headers, instrumentations };
}
