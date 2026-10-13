// web/__tests__/observation-adapter.test.ts
// 协议行 → 视图模型的转换契约（`web/lib/observation-adapter.ts`）。
//
// 这一层是「上游字段命名不外泄到渲染层」的唯一收敛点，也是面板最容易静默出错的地方：上游把 `input` 序列化成
// 字符串、把令牌数放在 `usageDetails` 里、把模型名放在 `providedModelName` 里——任何一条读错都只会表现成
// 「详情里这块是空的」，不会报错。因此这里逐条钉住映射与兜底。

import { describe, expect, test } from "bun:test";
import { toTraceObservation } from "../lib/observation-adapter";

/** 一条形态最全的协议行（字段名取自后端白名单，与上游 v2 响应一致）。 */
function fullRow(): Record<string, unknown> {
  return {
    id: "obs_1",
    traceId: "trace_1",
    parentObservationId: "obs_0",
    type: "GENERATION",
    name: "assistant",
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-01T00:00:02.500Z",
    completionStartTime: "2026-01-01T00:00:01.000Z",
    level: "DEFAULT",
    statusMessage: "done",
    environment: "default",
    input: '{"messages":[{"role":"user","content":"hi"}]}',
    output: "plain tool output",
    metadata: { runInBackground: true },
    providedModelName: "claude-sonnet-4",
    modelId: "model_1",
    usageDetails: { input: 100, output: 20, total: 120 },
    costDetails: { input: 0.001, output: 0.002, total: 0.003 },
    totalCost: 0.003,
    latency: 2.5,
    promptName: "chat",
    promptVersion: 3,
    tags: ["peri", 42],
    release: "1.0.0",
    traceName: "turn trace_1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("toTraceObservation", () => {
  // 业务意图：上游把 JSON 容器序列化成字符串时，面板要拿到结构而不是字符串——否则 chat 视图与 JSON 视图都
  // 识别不出载荷，详情里只剩一大段转义文本。
  test("字符串化的 JSON 载荷被解析成结构", () => {
    const observation = toTraceObservation(fullRow());
    expect(observation.input).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  // 业务意图：纯文本载荷（工具输出、prompt 散文）必须原样保留——它恰好可能以 `{` 之外的字符开头，
  // 也可能看起来像 JSON 但实为文本；解析失败时不能把内容换成 null。
  test("非 JSON 字符串原样保留", () => {
    const observation = toTraceObservation(fullRow());
    expect(observation.output).toBe("plain tool output");
  });

  // 业务意图：上游用 `providedModelName` / `usageDetails` / `costDetails` 承载模型与用量；读错命名只会让面板
  // 少显示一块，不报错。同时令牌总数缺失时按输入+输出兜底（自建后端不一定给 total）。
  test("模型名与用量按上游命名映射，total 缺失时按两项之和兜底", () => {
    const row = fullRow();
    row.usageDetails = { input: 10, output: 5 };
    const observation = toTraceObservation(row);
    expect(observation.model).toBe("claude-sonnet-4");
    expect(observation.promptTokens).toBe(10);
    expect(observation.completionTokens).toBe(5);
    expect(observation.totalTokens).toBe(15);
    expect(observation.costDetails.total).toBe(0.003);
  });

  // 业务意图：`tags` 里混入非字符串（上游 tags 是自由数组）时必须过滤掉，而不是让渲染层拿到数字去调
  // `.charAt()`——一个字段类型漂移不该让整块面板崩掉。
  test("tags 过滤掉非字符串项", () => {
    expect(toTraceObservation(fullRow()).tags).toEqual(["peri"]);
  });

  // 业务意图：缺字段的行必须转出一个「字段为空但结构完整」的视图模型——后端 schema 已拦掉缺 id/type/startTime
  // 的行，这里兜的是上游在其它字段上漂移（含 null 与类型错误），转换器绝不能抛错。
  test("缺字段时不抛错并给出稳定缺省值", () => {
    const observation = toTraceObservation({ id: "obs_2", type: "SPAN", startTime: "2026-01-01T00:00:00.000Z" });
    expect(observation).toMatchObject({
      id: "obs_2",
      type: "SPAN",
      traceId: null,
      name: null,
      endTime: null,
      model: null,
      totalTokens: 0,
      tags: [],
      totalCost: null,
    });
  });

  // 业务意图：`latency` 是上游给出的**秒**值，直接透传为数字（展示层用 formatSeconds）；把它误当毫秒会得到
  // 「2500 s」这类荒谬时长，而类型系统看不出来。
  test("latency 按秒透传，非法值降级为 null", () => {
    expect(toTraceObservation(fullRow()).latency).toBe(2.5);
    expect(toTraceObservation({ ...fullRow(), latency: "fast" }).latency).toBeNull();
  });
});
