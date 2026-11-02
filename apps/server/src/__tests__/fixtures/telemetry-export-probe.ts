import { initializeTelemetry, shutdownTelemetry } from "../../telemetry";
import { parseTelemetryConfig } from "../../telemetry/config";

const requests: { path: string; bytes: Uint8Array }[] = [];
const collector = Bun.serve({
  port: 0,
  async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, bytes: new Uint8Array(await request.arrayBuffer()) });
    return new Response(new Uint8Array(), { headers: { "content-type": "application/x-protobuf" } });
  },
});

initializeTelemetry(
  parseTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
    OTEL_TRACES_SAMPLER_ARG: 1,
  }),
);
try {
  const { createLogger } = await import("@fenix/logger");
  const { trace, metrics } = await import("@opentelemetry/api");
  let traceId = "";
  trace.getTracer("probe").startActiveSpan("probe.request", (span) => {
    traceId = span.spanContext().traceId;
    span.setAttribute("db.query.text", "prohibited-query-content");
    createLogger("probe").info("unique-probe-message", {
      attempt: 2,
      diagnostic: { state: "ready" },
      token: process.env.TELEMETRY_PROBE_SECRET,
    });
    createLogger("probe").error("error-probe-message", new TypeError("controlled failure"));
    span.end();
  });
  metrics.getMeter("probe").createCounter("fenix.probe.requests").add(1);
  const { Pool } = await import("pg");
  const pool = new Pool({ host: "127.0.0.1", port: 1, connectionTimeoutMillis: 100, max: 1 });
  try {
    await pool.query("SELECT 1");
  } catch {
    /* 探针只校验失败调用也有标准链路，不接触业务数据库。 */
  }
  await pool.end();
  const { default: Redis } = await import("ioredis");
  const redis = new Redis({
    host: "127.0.0.1",
    port: 1,
    lazyConnect: true,
    retryStrategy: () => null,
    connectTimeout: 100,
  });
  redis.on("error", () => {});
  try {
    await redis.get("probe");
  } catch {
    /* 不可达依赖只影响本次探针调用。 */
  }
  redis.disconnect();
  await shutdownTelemetry();
  const logRequests = requests.filter((request) => request.path === "/v1/logs");
  const decoded = logRequests.map((request) => new TextDecoder().decode(request.bytes)).join("");
  const result = {
    signals: [...new Set(requests.map((request) => request.path))].sort(),
    uniqueLogs: decoded.split("unique-probe-message").length - 1,
    hasFields: decoded.includes("attempt") && decoded.includes("diagnostic"),
    hasTraceCorrelation: logRequests.some((request) =>
      Buffer.from(request.bytes).includes(Buffer.from(traceId, "hex")),
    ),
    hasError: decoded.includes("TypeError") && decoded.includes("controlled failure"),
    hasPg: requests.some(
      (request) =>
        request.path === "/v1/traces" &&
        new TextDecoder().decode(request.bytes).includes("@opentelemetry/instrumentation-pg"),
    ),
    hasRedis: requests.some(
      (request) =>
        request.path === "/v1/traces" &&
        new TextDecoder().decode(request.bytes).includes("@opentelemetry/instrumentation-ioredis"),
    ),
    leakedSecret: decoded.includes(process.env.TELEMETRY_PROBE_SECRET ?? "never-provided"),
    leakedSql: requests.some((request) => new TextDecoder().decode(request.bytes).includes("prohibited-query-content")),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await collector.stop(true);
}
