import { describe, expect, test } from "bun:test";
import {
  boundedShutdown,
  initializeTelemetry,
  isTelemetryEnabled,
  shutdownTelemetry,
  telemetryDiagnostic,
} from "../telemetry";
import { parseTelemetryConfig, type TelemetryConfig } from "../telemetry/config";

describe("SDK 生命周期", () => {
  // 未声明地址的业务进程不得意外连接 localhost Collector。
  test("未配置 endpoint 时使用 No-op 且关闭幂等", async () => {
    const config = parseTelemetryConfig({});
    expect(config.enabled).toBe(false);
    initializeTelemetry(config);
    expect(isTelemetryEnabled()).toBe(false);
    expect(shutdownTelemetry()).toBe(shutdownTelemetry());
    await shutdownTelemetry();
  });

  // 不可达的遥测服务不能延长进程退出预算。
  test("挂起的 Provider 关闭受总预算约束", async () => {
    const start = performance.now();
    await boundedShutdown(() => new Promise(() => {}), 20);
    expect(performance.now() - start).toBeLessThan(500);
  });

  // 无效采样和受保护身份覆盖必须作为部署错误暴露。
  test("配置拒绝错误协议、采样和资源身份", () => {
    expect(() => parseTelemetryConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })).toThrow();
    expect(() => parseTelemetryConfig({ OTEL_TRACES_SAMPLER_ARG: 2 })).toThrow();
    expect(() => parseTelemetryConfig({ OTEL_RESOURCE_ATTRIBUTES: "service.instance.id=fixed" })).toThrow();
    expect(() => parseTelemetryConfig({ OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http" })).toThrow();
  });

  // 空 endpoint 表示未配置，显式禁用时更不能因为空字符串阻塞启动。
  test("空 endpoint 视为未配置", () => {
    expect(parseTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }).enabled).toBe(false);
    expect(parseTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " }).enabled).toBe(false);
    expect(parseTelemetryConfig({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "" }).enabled).toBe(false);
    expect(parseTelemetryConfig({ OTEL_BROWSER_COLLECTOR_ENDPOINT: "" }).urls.logs).toBeUndefined();
  });

  // 所有 OTEL_* 空白字符串统一回退默认值，不能把采样率静默变成 0 或清空允许列表。
  test("空白 OTEL 变量统一回退默认值", () => {
    const cases: Array<[string, (config: TelemetryConfig) => unknown, unknown]> = [
      ["OTEL_SDK_DISABLED", (config) => config.env.OTEL_SDK_DISABLED, "false"],
      ["OTEL_SERVICE_NAME", (config) => config.env.OTEL_SERVICE_NAME, "fenix-server"],
      [
        "OTEL_RESOURCE_ATTRIBUTES",
        (config) => config.attributes,
        { "service.namespace": "fenix", "deployment.environment.name": "development" },
      ],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", (config) => config.urls.traces, undefined],
      ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", (config) => config.urls.traces, undefined],
      ["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", (config) => config.urls.metrics, undefined],
      ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", (config) => config.urls.logs, undefined],
      ["OTEL_EXPORTER_OTLP_PROTOCOL", (config) => config.env.OTEL_EXPORTER_OTLP_PROTOCOL, "http/protobuf"],
      ["OTEL_EXPORTER_OTLP_HEADERS", (config) => config.headers, {}],
      ["OTEL_EXPORTER_OTLP_TIMEOUT", (config) => config.env.OTEL_EXPORTER_OTLP_TIMEOUT, 3000],
      ["OTEL_TRACES_EXPORTER", (config) => config.env.OTEL_TRACES_EXPORTER, "otlp"],
      ["OTEL_METRICS_EXPORTER", (config) => config.env.OTEL_METRICS_EXPORTER, "otlp"],
      ["OTEL_LOGS_EXPORTER", (config) => config.env.OTEL_LOGS_EXPORTER, "otlp"],
      ["OTEL_METRIC_EXPORT_INTERVAL", (config) => config.env.OTEL_METRIC_EXPORT_INTERVAL, 15_000],
      [
        "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
        (config) => config.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE,
        "cumulative",
      ],
      ["OTEL_TRACES_SAMPLER", (config) => config.env.OTEL_TRACES_SAMPLER, "parentbased_traceidratio"],
      ["OTEL_TRACES_SAMPLER_ARG", (config) => config.env.OTEL_TRACES_SAMPLER_ARG, 0.1],
      ["OTEL_NODE_ENABLED_INSTRUMENTATIONS", (config) => config.instrumentations, ["pg", "ioredis", "pino"]],
      ["OTEL_BROWSER_COLLECTOR_ENDPOINT", (config) => config.urls.logs, undefined],
    ];
    for (const [key, read, expected] of cases) {
      for (const value of ["", "   "]) {
        expect({ key, value, actual: read(parseTelemetryConfig({ [key]: value })) }).toEqual({
          key,
          value,
          actual: expected,
        });
      }
    }
  });

  // 关闭诊断必须绕过 30 秒限频，保证最后一次失败原因可见。
  test("关闭路径诊断不被限频吞掉", () => {
    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      telemetryDiagnostic("first-diagnostic", true);
      telemetryDiagnostic("suppressed-diagnostic");
      telemetryDiagnostic("shutdown-diagnostic", true);
    } finally {
      process.stderr.write = original;
    }
    expect(writes.join("")).toContain("first-diagnostic");
    expect(writes.join("")).toContain("shutdown-diagnostic");
    expect(writes.join("")).not.toContain("suppressed-diagnostic");
  });
});
