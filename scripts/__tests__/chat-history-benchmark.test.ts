import { describe, expect, test } from "bun:test";
import { assertMeasurementAvailable, collectHistoryMetrics } from "../chat-history/benchmark";
import { SocketByteCounter } from "../chat-history/cdp";
import { compareLoadSamples, type LoadSample } from "../chat-history/compare";
import { createHistoryFixture } from "../chat-history/fixtures";
import { createBenchmarkCases, prepareColdHistory } from "../chat-history/lifecycle";

function samples(overrides: Partial<LoadSample> = {}, count = 20): LoadSample[] {
  return Array.from({ length: count }, (_, pair) => ({
    version: "baseline",
    pair,
    scenario: "refresh",
    entryCount: 1000,
    cacheState: "hot",
    fixtureDigest: "fixed-history",
    firstVisibleMs: 100,
    interactiveMs: 200,
    earlierMs: 150,
    failure: null,
    contentVerified: true,
    layout: { viewportWidth: 1280, viewportHeight: 720, contentWidth: 800, contentDisplay: "flex" },
    sockets: { state: { receivedBytes: 1000 }, content: { receivedBytes: 500 } },
    stages: {},
    ...overrides,
  }));
}

// ACP 切换的目标一定换代，不能拿切换前的热缓存把目标错误归入热组。
test("切换只生成目标换代组，刷新保留所有请求的冷热场景", () => {
  expect(createBenchmarkCases([1000], ["refresh", "switch"], ["hot", "cold-ttl", "cold-generation"])).toEqual([
    { entryCount: 1000, scenario: "refresh", cacheState: "hot" },
    { entryCount: 1000, scenario: "refresh", cacheState: "cold-ttl" },
    { entryCount: 1000, scenario: "refresh", cacheState: "cold-generation" },
    { entryCount: 1000, scenario: "switch", cacheState: "cold-generation" },
  ]);
});

// 冷准备失败必须终止当前样本，不能静默改成普通刷新使冷组失真。
test("冷生命周期准备失败及模式不符均明确拒绝", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/reset") return new Response("unavailable", { status: 503 });
      return Response.json({ prepared: true, mode: "cold-generation" });
    },
  });
  try {
    await expect(prepareColdHistory(server.url.origin, 1000, "cold-generation")).rejects.toThrow(
      "Cold history preparation failed",
    );
    await expect(prepareColdHistory(server.url.origin, 1000, "cold-ttl")).rejects.toThrow(
      "Cold history preparation mode differs",
    );
  } finally {
    server.stop(true);
  }
});

// 基础设施不可测时停止整次采样，真实产品超时仍应保留并继续配对。
test("测量错误终止采样而产品超时保留为失败观测", () => {
  expect(() => assertMeasurementAvailable(samples({ failure: "measurement-error" })[0]!)).toThrow(
    "Benchmark measurement unavailable",
  );
  expect(() => assertMeasurementAvailable(samples({ failure: "timeout" })[0]!)).not.toThrow();
  expect(() => assertMeasurementAvailable(samples()[0]!)).not.toThrow();
});

describe("chat history performance comparison", () => {
  // 首屏须变快，上翻允许最多 10ms；按全部样本计算中位数和最近秩 P95。
  test("faster initial page with up to 10ms earlier overhead passes", () => {
    const result = compareLoadSamples(
      samples(),
      samples({ version: "candidate", firstVisibleMs: 90, interactiveMs: 180, earlierMs: 160 }),
    );
    expect(result.pass).toBe(true);
    expect(result.groups[0]?.candidate.interactiveMs).toEqual({ median: 180, p95: 180, max: 180 });
  });

  // 只有回看容差放宽；首屏原地踏步不能冒充这次优化已达到目标。
  test("unchanged first-page timings fail even within earlier tolerance", () => {
    const result = compareLoadSamples(samples(), samples({ earlierMs: 155 }));
    expect(result.pass).toBe(false);
    expect(result.groups[0]?.issues).toContain("interactiveMs:not-improved");
  });

  // 中位数合格时，少数回看长尾也只能增加最多 10ms。
  test("earlier P95 beyond 10ms fails independently", () => {
    const candidate = samples({ firstVisibleMs: 90, interactiveMs: 180, earlierMs: 150 });
    candidate[18] = { ...candidate[18]!, earlierMs: 161 };
    candidate[19] = { ...candidate[19]!, earlierMs: 162 };
    expect(compareLoadSamples(samples(), candidate).groups[0]?.issues).toContain("earlierMs:regressed");
  });

  // 提前展示首条不能掩盖末页或输入框更晚可用。
  test("a faster first message cannot hide a slower complete page", () => {
    const result = compareLoadSamples(samples(), samples({ firstVisibleMs: 10, interactiveMs: 201 }));
    expect(result.pass).toBe(false);
    expect(result.groups[0]?.issues).toContain("interactiveMs:regressed");
  });

  // 首屏变快后，用户回看历史的交互也必须独立满足不回退门槛。
  test("a faster initial load cannot hide slower earlier history", () => {
    const result = compareLoadSamples(samples(), samples({ firstVisibleMs: 10, interactiveMs: 20, earlierMs: 161 }));
    expect(result.pass).toBe(false);
    expect(result.groups[0]?.issues).toContain("earlierMs:regressed");
  });

  // 平均值更低不能掩盖少量用户面对的长尾回退。
  test("faster median does not hide a slower P95", () => {
    const candidate = samples({ interactiveMs: 50 });
    candidate[18] = { ...candidate[18]!, interactiveMs: 201 };
    candidate[19] = { ...candidate[19]!, interactiveMs: 202 };
    const result = compareLoadSamples(samples(), candidate);
    expect(result.pass).toBe(false);
    expect(result.groups[0]?.candidate.interactiveMs).toEqual({ median: 50, p95: 201, max: 202 });
  });

  // 失败必须留在分母中，不能通过删除超时样本让结果变快。
  test("a failed candidate load fails the nonregression gate", () => {
    const candidate = samples();
    candidate[0] = { ...candidate[0]!, failure: "timeout", interactiveMs: null, contentVerified: false };
    const result = compareLoadSamples(samples(), candidate);
    expect(result.pass).toBe(false);
    expect(result.groups[0]?.candidate.failureRate).toBe(0.05);
  });

  // 两个版本都失败不能当作完整行为和性能验收通过。
  test("matching failure rates do not establish a valid performance result", () => {
    const failed = samples({ failure: "timeout", firstVisibleMs: null, interactiveMs: null, earlierMs: null });
    expect(compareLoadSamples(failed, failed).pass).toBe(false);
  });

  // 两端共同失去测量能力不能算作相同产品失败率，即使剩余完整配对足够也拒绝验收。
  test("infrastructure errors invalidate a group despite enough complete pairs", () => {
    const baseline = samples({}, 40);
    const candidate = samples({ firstVisibleMs: 90, interactiveMs: 180 }, 40);
    baseline[0] = { ...baseline[0]!, failure: "measurement-error" };
    candidate[0] = { ...candidate[0]!, failure: "measurement-error" };
    const result = compareLoadSamples(baseline, candidate);
    expect(result.groups[0]?.paired.baseline.count).toBe(39);
    expect(result.groups[0]?.issues).toContain("measurement-unavailable");
    expect(result.pass).toBe(false);
  });

  // 基线失败仍计入分母；有足够完整配对且候选失败率下降时，不能把改善一票否决。
  test("baseline failures retain their denominator while complete pairs establish latency", () => {
    const baseline = samples({}, 40);
    baseline[0] = {
      ...baseline[0]!,
      failure: "timeout",
      contentVerified: false,
      layout: null,
      firstVisibleMs: null,
      interactiveMs: null,
      earlierMs: null,
    };
    const candidate = samples({ firstVisibleMs: 90, interactiveMs: 180, earlierMs: 155 }, 40);
    const result = compareLoadSamples(baseline, candidate);
    expect(result.pass).toBe(true);
    expect(result.groups[0]?.baseline.count).toBe(40);
    expect(result.groups[0]?.baseline.failureRate).toBe(1 / 40);
    expect(result.groups[0]?.candidate.failureRate).toBe(0);
    expect(result.groups[0]?.paired?.baseline.count).toBe(39);
    expect(result.groups[0]?.paired?.candidate.count).toBe(39);
  });

  // 总请求达到二十次不等于有二十个完整配对，不能用缺失的末页耗时填充统计。
  test("fewer than twenty complete paired successes remain insufficient", () => {
    const baseline = samples();
    baseline[0] = { ...baseline[0]!, failure: "timeout", contentVerified: false, interactiveMs: null };
    const result = compareLoadSamples(baseline, samples({ firstVisibleMs: 90, interactiveMs: 180 }));
    expect(result.pass).toBe(false);
    expect(result.groups[0]?.issues).toContain("insufficient-complete-pairs");
  });

  // 配对数量足够也不能抹掉候选失败；失败率门槛必须独立生效。
  test("candidate failure-rate increase fails despite enough complete pairs", () => {
    const candidate = samples({ firstVisibleMs: 90, interactiveMs: 180 }, 40);
    candidate[0] = { ...candidate[0]!, failure: "timeout", contentVerified: false, interactiveMs: null };
    const result = compareLoadSamples(samples({}, 40), candidate);
    expect(result.groups[0]?.paired.baseline.count).toBe(39);
    expect(result.groups[0]?.issues).toContain("failure-rate-regressed");
    expect(result.pass).toBe(false);
  });

  // 无法配对的成功长尾仍须公开保留；配对门槛只使用双方均完整的相同轮次。
  test("unmatched successful extrema remain in descriptive statistics", () => {
    const baseline = samples({}, 40);
    baseline[0] = {
      ...baseline[0]!,
      failure: "timeout",
      contentVerified: false,
      layout: null,
      firstVisibleMs: null,
      interactiveMs: null,
      earlierMs: null,
    };
    const candidate = samples({ firstVisibleMs: 90, interactiveMs: 180 }, 40);
    candidate[0] = { ...candidate[0]!, firstVisibleMs: 9000, interactiveMs: 9000, earlierMs: 9000 };
    const result = compareLoadSamples(baseline, candidate);
    expect(result.pass).toBe(true);
    expect(result.groups[0]?.candidate.interactiveMs?.max).toBe(9000);
    expect(result.groups[0]?.paired?.candidate.interactiveMs?.max).toBe(180);
    expect(candidate[0]?.interactiveMs).toBe(9000);
  });

  // 成功声明必须有完整内容，不能借其他成功配对掩盖一个漏消息的伪成功样本。
  test("incomplete purported successes still fail with enough other complete pairs", () => {
    const candidate = samples({ firstVisibleMs: 90, interactiveMs: 180 }, 40);
    candidate[0] = { ...candidate[0]!, contentVerified: false };
    expect(compareLoadSamples(samples({}, 40), candidate).groups[0]?.issues).toContain("incomplete-content-or-timing");
  });

  // 样本数和配对身份必须完整，不能挑选或重复较好的轮次。
  test("missing or duplicate pairs are rejected", () => {
    expect(compareLoadSamples(samples(), samples().slice(1)).pass).toBe(false);
    const duplicate = samples();
    duplicate[19] = duplicate[0]!;
    expect(compareLoadSamples(samples(), duplicate).pass).toBe(false);
    expect(compareLoadSamples([], []).pass).toBe(false);
    expect(compareLoadSamples(samples().slice(0, 5), samples().slice(0, 5)).pass).toBe(false);
  });

  // 冷加载不能被另一个热加载分组的大幅改善抵消。
  test("each cache and history group must pass independently", () => {
    const baseline = [...samples(), ...samples({ cacheState: "cold-restart" })];
    const candidate = [
      ...samples({ interactiveMs: 10 }),
      ...samples({ cacheState: "cold-restart", interactiveMs: 201 }),
    ];
    expect(compareLoadSamples(baseline, candidate).pass).toBe(false);
    expect(compareLoadSamples(baseline, samples()).pass).toBe(false);
  });

  // 内容不同或缺少工具时，即便更快也不是同一行为的性能比较。
  test("fixture mismatch and incomplete visible content fail", () => {
    expect(compareLoadSamples(samples(), samples({ fixtureDigest: "different" })).pass).toBe(false);
    expect(compareLoadSamples(samples(), samples({ contentVerified: false })).pass).toBe(false);
  });

  // 样式缺失或面板宽度不同会改变换行与布局成本，不能作为同条件的性能对照。
  test("unstyled or differently sized chat layouts cannot pass", () => {
    const layout = { viewportWidth: 1280, viewportHeight: 720, contentWidth: 1262, contentDisplay: "block" };
    const unstyled = samples().map((sample) => ({ ...sample, layout }));
    expect(compareLoadSamples(unstyled, samples()).groups[0]?.issues).toContain("layout-mismatch");
    expect(compareLoadSamples(unstyled, unstyled).groups[0]?.issues).toContain("invalid-layout");
  });

  // 无效计时不能被排序或 JSON 序列化掩盖成正常样本。
  test("invalid durations cannot pass", () => {
    for (const interactiveMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, null]) {
      expect(compareLoadSamples(samples(), samples({ interactiveMs })).pass).toBe(false);
    }
  });
});

describe("fixed complete chat history fixture", () => {
  // 历史规模变化时末页保持一致，才能判断首屏工作是否随总历史线性增长。
  test("all three history sizes have identical latest content and exact source entry counts", () => {
    const fixtures = [1000, 10000, 20000].map(createHistoryFixture);
    expect(fixtures.map((fixture) => fixture.entries.length)).toEqual([1000, 10000, 20000]);
    expect(fixtures[0]!.entries.slice(-100)).toEqual(fixtures[1]!.entries.slice(-100));
    expect(fixtures[0]!.entries.slice(-100)).toEqual(fixtures[2]!.entries.slice(-100));
    expect(fixtures[0]!.expectedTail).toEqual(fixtures[2]!.expectedTail);
  });

  // 角色、工具边界和系统计划必须有独立于被测 mapper 的固定预期。
  test("tail fixtures explicitly cover nontext and callback identities", () => {
    const fixture = createHistoryFixture(1000);
    const cases = fixture.entries.filter((entry) => entry.entryId.startsWith("tail-special:"));
    expect(cases.map((entry) => entry.entryId)).toEqual([
      "tail-special:user-a",
      "tail-special:user-b",
      "tail-special:assistant",
      "tail-special:tool-only",
      "tail-special:plan",
      "tail-special:failure",
      "tail-special:callback",
      "tail-special:resource",
    ]);
    const assistant = fixture.expectedTail.find((entry) => entry.id === "tail-special:assistant");
    expect(assistant?.type === "assistant_message" ? assistant.chunks : []).toEqual([
      { type: "thought", text: "检查天气来源" },
      { type: "message", text: "正在查询" },
    ]);
    expect(fixture.events.length).toBeGreaterThan(0);
  });
});

describe("chat socket measurements", () => {
  // 内存用量可下降；它是当前值，不能和累计计数器一样做差得到负数。
  test("collects current resident bytes and counter deltas separately", () => {
    expect(
      collectHistoryMetrics(
        { "fenix.chat.projection.resident.bytes": 20, "fenix.chat.projection.source.scans": 3 },
        { "fenix.chat.projection.resident.bytes": 10, "fenix.chat.projection.source.scans": 4 },
      ),
    ).toEqual({ "fenix.chat.projection.resident.bytes": 10, "fenix.chat.projection.source.scans": 1 });
  });

  // 两种连接都计入，CDP 二进制帧的 base64 长度不能冒充网络载荷长度。
  test("counts both sockets and decodes binary frame lengths", () => {
    const counter = new SocketByteCounter();
    counter.accept("Network.webSocketCreated", { requestId: "old", url: "ws://localhost/acp/yjs/e?instanceUid=i" });
    counter.accept("Network.webSocketCreated", { requestId: "new", url: "ws://localhost/acp/yjs/e?chatSync=1" });
    counter.accept("Network.webSocketFrameReceived", {
      requestId: "old",
      response: { opcode: 2, payloadData: "AQIDBA==" },
    });
    counter.accept("Network.webSocketFrameReceived", {
      requestId: "new",
      response: { opcode: 1, payloadData: "天气" },
    });
    counter.accept("Network.webSocketFrameSent", { requestId: "old", response: { opcode: 2, payloadData: "AQI=" } });
    expect(counter.snapshot()).toEqual({
      state: { receivedBytes: 4, sentBytes: 2 },
      content: { receivedBytes: 6, sentBytes: 0 },
    });
  });

  // 连接重建或分组重置时不能把上一轮载荷归入本轮；非聊天连接不进入统计。
  test("closed and reset sockets cannot contaminate a new measurement", () => {
    const counter = new SocketByteCounter();
    counter.accept("Network.webSocketCreated", { requestId: "other", url: "ws://localhost/file-ws" });
    counter.accept("Network.webSocketFrameReceived", {
      requestId: "other",
      response: { opcode: 1, payloadData: "ignored" },
    });
    counter.accept("Network.webSocketCreated", { requestId: "old", url: "ws://localhost/acp/yjs/e" });
    counter.accept("Network.webSocketClosed", { requestId: "old" });
    counter.accept("Network.webSocketFrameReceived", {
      requestId: "old",
      response: { opcode: 1, payloadData: "late" },
    });
    counter.reset();
    expect(counter.snapshot()).toEqual({
      state: { receivedBytes: 0, sentBytes: 0 },
      content: { receivedBytes: 0, sentBytes: 0 },
    });
  });
});
