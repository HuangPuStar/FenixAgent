import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod/v4";
import { BenchmarkBrowser } from "./browser";
import { CdpConnection, SocketByteCounter } from "./cdp";
import { type LoadSample, loadSampleLayoutSchema } from "./compare";
import { createHistoryFixture } from "./fixtures";
import { createBenchmarkCases, prepareColdHistory } from "./lifecycle";
import { createPageObserver } from "./page-observer";

const fixtureSchema = z.object({ entryCount: z.number().int(), fixtureDigest: z.string(), url: z.url() });
const observationSchema = z.object({
  firstVisibleMs: z.number().nullable(),
  interactiveMs: z.number().nullable(),
  earlierMs: z.number().nullable(),
  contentVerified: z.boolean(),
  visibleCount: z.number(),
  projectedCount: z.number(),
  browserErrors: z.number(),
});

interface Endpoint {
  version: string;
  baseUrl: string;
  controlUrl: string;
  browser: BenchmarkBrowser;
}

/** 测量能力丢失后停止采样，避免把空白页的连锁错误当作产品失败率。 */
export function assertMeasurementAvailable(sample: LoadSample): void {
  if (sample.failure === "measurement-error") throw new Error("Benchmark measurement unavailable; raw sample retained");
}

/** 累计指标取样本差值，驻留内存保持当前值；不混入其他业务的进程指标。 */
export function collectHistoryMetrics(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const counters = new Set([
    "fenix.chat.projection.cache.requests:hit",
    "fenix.chat.projection.cache.requests:miss",
    "fenix.chat.projection.cache.evictions",
    "fenix.chat.projection.source.scans",
    "fenix.history.restore.duration:success",
    "agentLoads",
  ]);
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    if (counters.has(key)) result[key] = value - (before[key] ?? 0);
    else if (key === "fenix.chat.projection.resident.bytes") result[key] = value;
  }
  return result;
}

async function attachPage(browser: BenchmarkBrowser, baseUrl: string) {
  const address = await browser.run(["get", "cdp-url"]);
  if (typeof address.cdpUrl !== "string") throw new Error("Missing browser debugging endpoint");
  const cdp = await CdpConnection.connect(address.cdpUrl);
  try {
    const targets = await cdp.command("Target.getTargets");
    const infos = z
      .array(z.object({ type: z.string(), url: z.string(), targetId: z.string() }))
      .parse(targets.targetInfos);
    const target = infos.find((info) => info.type === "page" && info.url.startsWith(baseUrl));
    if (!target) {
      throw new Error("Missing benchmark page");
    }
    const attached = await cdp.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    if (typeof attached.sessionId !== "string") {
      throw new Error("Missing page debugging session");
    }
    const sessionId = attached.sessionId;
    await cdp.command("Network.enable", {}, sessionId);
    await cdp.command("Page.enable", {}, sessionId);
    return { cdp, sessionId };
  } catch (error) {
    cdp.close();
    throw error;
  }
}

async function waitForInteractive(browser: BenchmarkBrowser) {
  const deadline = Date.now() + 90000;
  let observation: z.infer<typeof observationSchema> | undefined;
  while (Date.now() < deadline) {
    const parsed = observationSchema.safeParse(await browser.evaluate("window.__chatHistoryBench?.snapshot()"));
    if (parsed.success) observation = parsed.data;
    if (observation?.interactiveMs !== null && observation?.interactiveMs !== undefined) return observation;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return observation;
}

/** 测量单次完整加载及翻页，所有晚到错误都必须进入样本失败统计。 */
export async function measure(
  endpoint: Endpoint,
  fixture: z.infer<typeof fixtureSchema>,
  pair: number,
  scenario: LoadSample["scenario"],
  cacheState: LoadSample["cacheState"],
): Promise<LoadSample> {
  const sample: LoadSample = {
    version: endpoint.version,
    pair,
    scenario,
    cacheState,
    entryCount: fixture.entryCount,
    fixtureDigest: fixture.fixtureDigest,
    firstVisibleMs: null,
    interactiveMs: null,
    earlierMs: null,
    failure: null,
    contentVerified: false,
    layout: null,
    sockets: { state: { receivedBytes: 0 }, content: { receivedBytes: 0 } },
    stages: {
      authenticationMs: null,
      agentLoadMs: null,
      sourceRestoreMs: null,
      encodeSendMs: null,
      browserApplyMs: null,
    },
  };
  const counter = new SocketByteCounter();
  let handle: Awaited<ReturnType<typeof attachPage>> | undefined;
  let scriptId: string | undefined;
  const metrics = async () => {
    const response = await fetch(`${endpoint.controlUrl}/metrics`, { signal: AbortSignal.timeout(5000) });
    return z.record(z.string(), z.number()).parse(await response.json());
  };
  try {
    handle = await attachPage(endpoint.browser, endpoint.baseUrl);
    const { cdp, sessionId } = handle;
    let protocolError = false;
    cdp.onEvent((event) => {
      if (event.sessionId !== sessionId || !event.method || !event.params) return;
      try {
        counter.accept(event.method, event.params);
      } catch {
        protocolError = true;
      }
    });
    const source = createPageObserver(
      createHistoryFixture(fixture.entryCount).expectedTail,
      endpoint.version === "67e16f688",
    );
    const installed = await cdp.command("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
    scriptId = typeof installed.identifier === "string" ? installed.identifier : undefined;
    if (cacheState !== "hot") {
      if (cacheState !== "cold-generation") {
        await endpoint.browser.run(["open", fixture.url]);
        const warm = await waitForInteractive(endpoint.browser);
        if (!warm?.contentVerified || warm.interactiveMs === null) throw new Error("Cold preparation warmup failed");
      }
      await endpoint.browser.run(["open", "about:blank"]);
      await prepareColdHistory(endpoint.controlUrl, fixture.entryCount, cacheState);
      counter.reset();
    }
    let metricsBefore = await metrics();
    if (scenario === "reopen") {
      await endpoint.browser.run(["open", "about:blank"]);
    }
    if (scenario === "refresh" && (await endpoint.browser.evaluate("location.href")) === fixture.url)
      await endpoint.browser.run(["reload"]);
    else await endpoint.browser.run(["open", fixture.url]);
    let observation = await waitForInteractive(endpoint.browser);
    if (scenario === "switch") {
      if (!observation || observation.interactiveMs === null) {
        sample.failure = "timeout";
        return sample;
      }
      counter.reset();
      metricsBefore = await metrics();
      if (!(await endpoint.browser.evaluate("window.__chatHistoryBench.switchSession()")))
        throw new Error("Session switch unavailable");
      observation = await waitForInteractive(endpoint.browser);
    }
    if (!observation || observation.interactiveMs === null) {
      sample.firstVisibleMs = observation?.firstVisibleMs ?? null;
      sample.failure = "timeout";
      return sample;
    }
    sample.firstVisibleMs = observation.firstVisibleMs;
    sample.interactiveMs = observation.interactiveMs;
    sample.contentVerified = observation.contentVerified;
    sample.layout = loadSampleLayoutSchema.parse(
      await endpoint.browser.evaluate(`(() => {
      const content = document.querySelector('[data-slot="chat-conversation-content"]');
      if (!content) return null;
      return { viewportWidth: innerWidth, viewportHeight: innerHeight,
        contentWidth: content.getBoundingClientRect().width, contentDisplay: getComputedStyle(content).display };
    })()`),
    );
    sample.sockets = counter.snapshot();
    sample.counters = { projectedMessages: observation.projectedCount, visibleMessages: observation.visibleCount };
    const metricsAfter = await metrics();
    Object.assign(sample.counters, collectHistoryMetrics(metricsBefore, metricsAfter));
    sample.stages.sourceRestoreMs = (sample.counters["fenix.history.restore.duration:success"] ?? 0) * 1000;
    if (observation.browserErrors || protocolError) sample.failure = "browser-error";
    const beforeIdle = counter.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const afterIdle = counter.snapshot();
    sample.counters.noScrollExtraBytes =
      afterIdle.state.receivedBytes +
      afterIdle.content.receivedBytes -
      beforeIdle.state.receivedBytes -
      beforeIdle.content.receivedBytes;
    const earlier = await endpoint.browser.evaluate("window.__chatHistoryBench.earlier()");
    if (!earlier) {
      sample.failure = "measurement-error";
      return sample;
    }
    const earlierDeadline = Date.now() + 15000;
    let finalObservation = observation;
    while (Date.now() < earlierDeadline) {
      const current = observationSchema.parse(await endpoint.browser.evaluate("window.__chatHistoryBench.snapshot()"));
      finalObservation = current;
      if (current.earlierMs !== null) {
        sample.earlierMs = current.earlierMs;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    sample.counters.browserErrors = finalObservation.browserErrors;
    sample.counters.protocolErrors = Number(protocolError);
    if (finalObservation.browserErrors || protocolError) sample.failure = "browser-error";
    else if (sample.earlierMs === null) sample.failure ??= "timeout";
    return sample;
  } catch {
    sample.failure = "measurement-error";
    return sample;
  } finally {
    if (sample.failure && !sample.sockets.state.receivedBytes && !sample.sockets.content.receivedBytes)
      sample.sockets = counter.snapshot();
    try {
      if (handle && scriptId)
        await handle.cdp.command(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: scriptId },
          handle.sessionId,
        );
    } catch {
      sample.failure ??= "measurement-error";
    } finally {
      handle?.cdp.close();
    }
  }
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "base-url": { type: "string" },
      "baseline-base-url": { type: "string" },
      "candidate-base-url": { type: "string" },
      "control-url": { type: "string", default: "http://127.0.0.1:3138" },
      "candidate-control-url": { type: "string", default: "http://127.0.0.1:3140" },
      "auth-file": { type: "string" },
      output: { type: "string" },
      samples: { type: "string", default: "20" },
      scenarios: { type: "string", default: "refresh,reopen,switch" },
      "cache-states": { type: "string", default: "hot,cold-generation" },
      entries: { type: "string", default: "1000,10000" },
    },
  });
  const baseUrl = values["baseline-base-url"] ?? values["base-url"];
  const authFile = values["auth-file"] ?? process.env.CHAT_HISTORY_BENCH_AUTH_FILE;
  if (!baseUrl || !values.output || !authFile)
    throw new Error("Require base URL, output directory and local authentication file");
  const count = Number(values.samples);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("samples must be a positive integer");
  const scenarios = z.array(z.enum(["refresh", "reopen", "switch"])).parse(values.scenarios!.split(","));
  const states = z
    .array(z.enum(["hot", "cold-generation", "cold-ttl", "cold-eviction", "cold-restart"]))
    .parse(values["cache-states"]!.split(","));
  const entries = values.entries!.split(",").map(Number);
  const endpoints: Endpoint[] = [
    {
      version: "67e16f688",
      baseUrl,
      controlUrl: values["control-url"]!,
      browser: new BenchmarkBrowser("fenix-pagination-baseline"),
    },
  ];
  if (values["candidate-base-url"])
    endpoints.push({
      version: "candidate",
      baseUrl: values["candidate-base-url"],
      controlUrl: values["candidate-control-url"]!,
      browser: new BenchmarkBrowser("fenix-pagination-candidate"),
    });
  const allSamples = new Map<Endpoint, LoadSample[]>();
  const warmups: LoadSample[] = [];
  const fixtureMap = new Map<Endpoint, z.infer<typeof fixtureSchema>[]>();
  await mkdir(values.output, { recursive: true, mode: 0o700 });
  for (const endpoint of endpoints) {
    await endpoint.browser.run(["open", endpoint.baseUrl]);
    await endpoint.browser.login(authFile);
    const response = await fetch(`${endpoint.controlUrl}/fixtures`, { signal: AbortSignal.timeout(5000) });
    fixtureMap.set(
      endpoint,
      z
        .array(fixtureSchema)
        .parse(await response.json())
        .filter((fixture) => entries.includes(fixture.entryCount)),
    );
    allSamples.set(endpoint, []);
  }
  for (const { entryCount, scenario, cacheState } of createBenchmarkCases(entries, scenarios, states)) {
    // 首次打开不具备运行确认与投影缓存；预热单独保存，不能冒充热命中样本。
    if (cacheState === "hot") {
      for (const endpoint of endpoints) {
        const fixture = fixtureMap.get(endpoint)!.find((item) => item.entryCount === entryCount);
        if (!fixture) throw new Error("Missing fixed history fixture");
        const sample = await measure(endpoint, fixture, 0, scenario, "hot");
        warmups.push(sample);
        const output = join(values.output, "warmups.json");
        await Bun.write(output, JSON.stringify(warmups, null, 2));
        await chmod(output, 0o600);
        assertMeasurementAvailable(sample);
      }
    }
    for (let pair = 0; pair < count; pair++) {
      for (const endpoint of pair % 2 ? [...endpoints].reverse() : endpoints) {
        const fixture = fixtureMap.get(endpoint)!.find((item) => item.entryCount === entryCount);
        if (!fixture) throw new Error("Missing fixed history fixture");
        const sample = await measure(endpoint, fixture, pair, scenario, cacheState);
        const samples = allSamples.get(endpoint)!;
        samples.push(sample);
        const output = join(
          values.output,
          endpoint.version === "candidate" ? "candidate-samples.json" : "baseline-samples.json",
        );
        await Bun.write(output, JSON.stringify(samples, null, 2));
        await chmod(output, 0o600);
        console.log(
          JSON.stringify({
            version: endpoint.version,
            entryCount,
            scenario,
            cacheState,
            pair,
            firstVisibleMs: sample.firstVisibleMs,
            interactiveMs: sample.interactiveMs,
            earlierMs: sample.earlierMs,
            failure: sample.failure,
          }),
        );
        assertMeasurementAvailable(sample);
      }
    }
  }
  process.exitCode = [...allSamples.values()].some((samples) => samples.some((sample) => sample.failure !== null))
    ? 1
    : 0;
}

if (import.meta.main) await main();
