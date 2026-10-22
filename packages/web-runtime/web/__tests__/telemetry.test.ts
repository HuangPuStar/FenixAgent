import { expect, test } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { activateBrowserTelemetry, pageType, recordBrowserEvent, reportBrowserError } from "../telemetry/events";

class Reader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

// 浏览器事件仅有限维度，错误去重限频且不采原始正文。
test("浏览器页面分类、恢复事件与异常去重", async () => {
  const reader = new Reader();
  const meter = new MeterProvider({ readers: [reader] });
  const output = new InMemoryLogRecordExporter();
  const logger = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(output)] });
  metrics.setGlobalMeterProvider(meter);
  logs.setGlobalLoggerProvider(logger);
  try {
    activateBrowserTelemetry();
    expect(pageType("/ctrl/agent/chat/private-instance")).toBe("chat");
    expect(pageType("/ctrl/login")).toBe("login");
    recordBrowserEvent("history_ready", 250);
    const failure = new TypeError("用户正文不应进入观测");
    reportBrowserError(failure);
    reportBrowserError(failure);
    await logger.forceFlush();
    expect(output.getFinishedLogRecords().length).toBe(2);
    expect(
      JSON.stringify(
        output.getFinishedLogRecords().map((record) => ({ body: record.body, attributes: record.attributes })),
      ),
    ).not.toContain(failure.message);
    const data = (await reader.collect()).resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    expect(
      data.find((metric) => metric.descriptor.name === "fenix.web.history.duration")?.dataPoints[0]?.value,
    ).toMatchObject({ count: 1, sum: 0.25 });
  } finally {
    await logger.shutdown();
    await meter.shutdown();
    logs.disable();
    metrics.disable();
  }
});
