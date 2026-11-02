import { metrics, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const meter = metrics.getMeter("@fenix/agent-runtime");

/** 秒级 Agent 启动/运行耗时：保留亚秒启动与长任务两端分辨率。 */
export const AGENT_SECONDS_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 0.9, 2.5, 5, 10, 30, 60, 300, 600, 1800, 3600,
];
const seconds = { advice: { explicitBucketBoundaries: AGENT_SECONDS_HISTOGRAM_BUCKETS } };
const runs = meter.createCounter("fenix.agent.runs");
const duration = meter.createHistogram("fenix.agent.run.duration", { unit: "s", ...seconds });
const startupDuration = meter.createHistogram("fenix.agent.start.duration", { unit: "s", ...seconds });
const active = meter.createObservableGauge("fenix.agent.active", { unit: "{instance}" });
const running = new Map<
  string,
  { generation: number; engine: string; state: "starting" | "running" | "unknown"; started: number; span: Span | null }
>();

/** 仅保留活跃实例的测量起点，结束时删除；不以实例 ID 作为指标维度。 */
export function beginAgentRun(id: string, generation: number): void {
  finishAgentRun(id, "cancelled");
  running.set(id, {
    generation,
    engine: "unknown",
    state: "starting",
    started: performance.now(),
    span: trace
      .getTracer("@fenix/agent-runtime")
      .startSpan("agent.start", { attributes: { "fenix.agent.instance.id": id } }),
  });
}

/** 就绪信号沿用 runtime 已确认的引擎，未知扩展引擎归到固定分类。 */
export function agentRunReady(id: string, engine: string | undefined): void {
  const run = running.get(id);
  if (!run) return;
  run.engine = ["peri", "claude-code", "opencode", "ccb"].includes(engine ?? "") ? engine! : "other";
  run.state = "running";
  startupDuration.record((performance.now() - run.started) / 1000, { engine: run.engine, result: "success" });
  run.span?.setAttribute("engine", run.engine);
  run.span?.end();
  run.span = null;
}

/** 断连不等于退出；只变更有限状态，等待权威死亡或停止信号结算。 */
export function agentRunDisconnected(id: string): void {
  const run = running.get(id);
  if (run) run.state = "unknown";
}

/** 同一代次仅结束一次，迟到的死亡通知不得结束后继实例。 */
export function finishAgentRun(id: string, result: "success" | "failure" | "cancelled", generation?: number): void {
  const run = running.get(id);
  if (!run || (generation !== undefined && generation !== run.generation)) return;
  running.delete(id);
  const seconds = (performance.now() - run.started) / 1000;
  if (run.span) {
    startupDuration.record(seconds, { engine: run.engine, result });
    run.span.setStatus({ code: result === "failure" ? SpanStatusCode.ERROR : SpanStatusCode.UNSET });
    run.span.end();
  }
  runs.add(1, { engine: run.engine, result });
  duration.record(seconds, { engine: run.engine, result });
}

active.addCallback((result) => {
  const totals = new Map<string, number>();
  for (const run of running.values()) {
    const key = `${run.engine}:${run.state}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  for (const engine of ["peri", "claude-code", "opencode", "ccb", "other", "unknown"]) {
    for (const state of ["starting", "running", "unknown"])
      result.observe(totals.get(`${engine}:${state}`) ?? 0, { engine, state });
  }
});
