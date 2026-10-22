import { expect, test } from "bun:test";
import { opentelemetry } from "@elysia/opentelemetry";
import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { AlwaysOffSampler, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import Elysia from "elysia";

class Reader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

// 禁止采样的请求仍必须全量计入直方图，不能依赖 Span.isRecording。
test("官方 HTTP 指标不受 Trace 采样影响", async () => {
  const reader = new Reader();
  const meter = new MeterProvider({ readers: [reader] });
  const tracer = new BasicTracerProvider({ sampler: new AlwaysOffSampler() });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  metrics.setGlobalMeterProvider(meter);
  trace.setGlobalTracerProvider(tracer);
  try {
    const app = new Elysia()
      .use(opentelemetry())
      .get("/items/:id", () => "ok")
      .get("/failure", ({ set }) => {
        set.status = 500;
        return "failed";
      })
      .get("/bad", ({ status }) => status(400, "bad"))
      .get("/exception", () => {
        throw new Error("failed");
      })
      .get("/stream", async function* () {
        yield "data: ready\\n\\n";
        yield "data: done\\n\\n";
      })
      .all("/*", ({ status }) => status(404, "not found"));
    await app.handle(new Request("http://localhost/items/1"));
    await app.handle(new Request("http://localhost/items/2"));
    await app.handle(new Request("http://localhost/failure"));
    await app.handle(new Request("http://localhost/bad"));
    await app.handle(new Request("http://localhost/exception"));
    await app.handle(new Request("http://localhost/unmatched/private-id"));
    const stream = await app.handle(new Request("http://localhost/stream"));
    await stream.text();
    const abort = new AbortController();
    const cancelled = await app.handle(new Request("http://localhost/stream", { signal: abort.signal }));
    abort.abort();
    await cancelled.body?.cancel();
    await Bun.sleep(20);
    const data = await reader.collect();
    const histogram = data.resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "http.server.request.duration");
    expect(histogram).toBeDefined();
    expect(
      histogram?.dataPoints.reduce(
        (sum, point) => sum + (typeof point.value === "object" && "count" in point.value ? point.value.count : 0),
        0,
      ),
    ).toBe(8);
    expect(JSON.stringify(histogram?.dataPoints)).not.toContain("private-id");
    expect(histogram?.dataPoints.some((point) => point.attributes["http.route"] === "/items/:id")).toBe(true);
    expect(histogram?.dataPoints.some((point) => point.attributes["http.response.status_code"] === 500)).toBe(true);
  } finally {
    await meter.shutdown();
    await tracer.shutdown();
    metrics.disable();
    trace.disable();
    context.disable();
  }
});
