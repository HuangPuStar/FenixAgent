// web/__tests__/trace-graph-layout.test.ts
// 调用图的纯布局函数用例（移植自 langfuse-lite `src/__tests__/trace-graph-layout.test.ts`，只搬纯函数断言；
// 依赖 react-query / 路由的渲染用例与「输出预览抽取」用例不在这里——首版不做输出预览）。
//
// 断言的是图的可观察契约：分支识别（哪些观测算子 agent、哪些算后台）、泳道分配与 fork/join 生成、
// 合并投影后的行与连线端点、以及隐藏 span 的计数。这些都是渲染层无法自证、只能由纯函数保证的部分。

import { describe, expect, test } from "bun:test";
import { buildTraceGraphDisplay } from "../lib/graph/trace-graph-display-layout";
import { buildTraceGraph, type TraceGraphModel, type TraceGraphNode } from "../lib/graph/trace-graph-layout";
import { isBackgroundSubagent, isGraphSubagent } from "../lib/graph/trace-graph-semantics";
import type { TraceObservation } from "../lib/observation-types";

const EPOCH = Date.parse("2026-09-29T09:00:00.000Z");

/** 构造一条观测：未指定的字段填成「可渲染但无语义」的值，用例只声明自己关心的字段。 */
function observation(
  id: string,
  type: string,
  parentObservationId: string | null,
  start: number,
  details: Partial<TraceObservation> = {},
): TraceObservation {
  return {
    id,
    traceId: "trace-1",
    parentObservationId,
    type,
    name: id,
    startTime: new Date(EPOCH + start * 1000).toISOString(),
    endTime: new Date(EPOCH + 10_000).toISOString(),
    completionStartTime: null,
    level: null,
    statusMessage: null,
    environment: null,
    input: undefined,
    output: undefined,
    metadata: undefined,
    model: null,
    modelId: null,
    modelParameters: undefined,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    usageDetails: {},
    costDetails: {},
    totalCost: null,
    latency: null,
    promptName: null,
    promptVersion: null,
    tags: [],
    release: null,
    traceName: "trace-1",
    ...details,
  };
}

/** 一个启动器 TOOL 下同时起三个子 agent（b 后台、c 可选嵌套在 a 下）的并发场景。 */
function parallelAgents(nested = false): TraceObservation[] {
  const agent = (id: string, parent: string, start: number, metadata?: unknown) =>
    observation(id, "AGENT", parent, start, { name: `subagent-${id}`, metadata });
  return [
    observation("launch", "TOOL", null, 0),
    agent("a", "launch", 1),
    agent("b", "launch", 1.01, { background: true }),
    agent("c", nested ? "a" : "launch", 1.02),
    observation("gen-a", "GENERATION", "a", 2),
    observation("gen-b", "GENERATION", "b", 3),
    observation("gen-c", "GENERATION", "c", 4),
  ];
}

/** 手工构造的泳道/行投影模型：observation 为 null，便于隔离测显示层的重排。 */
function model(kinds: TraceGraphNode["kind"][], lanes = kinds.map(() => 0)): TraceGraphModel {
  const nodes = kinds.map(
    (kind, index): TraceGraphNode => ({
      id: String(index),
      observation: null,
      kind,
      lane: lanes[index],
      branchId: `branch-${lanes[index]}`,
      timestamp: index,
      label: kind,
      background: false,
    }),
  );
  return {
    nodes,
    laneCount: 2,
    branchCount: 1,
    hiddenCount: 0,
    startTime: 0,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`,
      from: { row: index, lane: lanes[index] },
      to: { row: index + 1, lane: node.lane },
      kind: "sequence",
      lane: node.lane,
      background: false,
    })),
  };
}

describe("分支识别", () => {
  // 只有 AGENT 且命名以 subagent 开头的观测才是子 agent：TOOL 即使同名也只是工具调用。
  test("按类型与命名约定识别子 agent", () => {
    expect(isGraphSubagent(observation("a", "AGENT", null, 0, { name: "subagent-a" }))).toBe(true);
    expect(isGraphSubagent(observation("a", "TOOL", null, 0, { name: "subagent-a" }))).toBe(false);
    expect(isGraphSubagent(observation("a", "AGENT", null, 0, { name: "Researcher" }))).toBe(false);
  });

  // 时间线面板的 bg/background/async 前缀约定必须在图上同样生效，否则同一份 trace 两处判定不一致。
  test("接受 bg / background / async 前缀的命名", () => {
    for (const name of ["bg subagent:x", "background:subagent:y", "async.subagent:z"]) {
      expect(isGraphSubagent(observation("a", "AGENT", null, 0, { name }))).toBe(true);
    }
  });
});

describe("执行模式推断", () => {
  const byId = (observations: TraceObservation[]) => new Map(observations.map((item) => [item.id, item]));

  // 协议没有专用的执行模式字段，input/metadata 的显式标记是既定约定（true / "true" / mode 都要认）。
  test("识别 metadata 与 input 里的显式后台标记", () => {
    const flag = observation("a", "AGENT", null, 0, { name: "subagent:a", metadata: { runInBackground: true } });
    const mode = observation("b", "AGENT", null, 0, { name: "subagent:b", input: { mode: "background" } });
    const strung = observation("c", "AGENT", null, 0, {
      name: "subagent:c",
      metadata: JSON.stringify({ isBackground: "true" }),
    });
    expect(isBackgroundSubagent(flag, byId([flag]))).toBe(true);
    expect(isBackgroundSubagent(mode, byId([mode]))).toBe(true);
    expect(isBackgroundSubagent(strung, byId([strung]))).toBe(true);
  });

  // 损坏的遥测与散文都不能用来断定执行模式：解析失败按「不是后台」处理，绝不抛错让整张图消失。
  test("解析失败的标记与 prompt 散文不产生后台判定", () => {
    const broken = observation("a", "AGENT", null, 0, { name: "subagent:a", metadata: "{ not json" });
    const prose = observation("b", "AGENT", null, 0, {
      name: "subagent:b",
      input: "Please run this in the background",
    });
    expect(isBackgroundSubagent(broken, byId([broken]))).toBe(false);
    expect(isBackgroundSubagent(prose, byId([prose]))).toBe(false);
  });

  // 后台标记可能挂在启动器 TOOL 上：子 agent 需要从最近的 TOOL 继承该模式。
  test("从启动器 TOOL 继承后台模式", () => {
    const observations = [
      observation("tool", "TOOL", null, 0, { metadata: { runInBackground: true } }),
      observation("worker", "AGENT", "tool", 1, { name: "subagent:worker" }),
    ];
    expect(isBackgroundSubagent(observations[1], byId(observations))).toBe(true);
  });

  // 上溯遇到 AGENT 必须停：否则嵌套的同步子 agent 会继承外层的后台设置，图会把它画成后台分支。
  test("嵌套子 agent 不继承外层 AGENT 的后台模式", () => {
    const observations = [
      observation("outer", "AGENT", null, 0, {
        name: "subagent:outer",
        metadata: { runInBackground: true },
      }),
      observation("wrapper", "SPAN", "outer", 0.1),
      observation("inner", "AGENT", "wrapper", 1, { name: "subagent:inner" }),
    ];
    expect(isBackgroundSubagent(observations[2], byId(observations))).toBe(false);
  });
});

describe("buildTraceGraph 泳道与 fork / join", () => {
  // 每个子 agent 独占一条泳道且互不复用：并发分支的编号与 fork 位置才能在刷新后保持不变。
  test("为并发子 agent 分配稳定泳道并生成 fork", () => {
    const graph = buildTraceGraph(parallelAgents());
    expect(graph.branchCount).toBe(3);
    expect(graph.laneCount).toBe(4);
    expect(graph.startTime).toBe(EPOCH);
    expect(
      graph.nodes
        .filter((node) => node.kind === "fork")
        .map((node) => [node.observation?.id, node.lane, node.parentLane]),
    ).toEqual([
      ["a", 1, 0],
      ["b", 2, 0],
      ["c", 3, 0],
    ]);
    expect(graph.nodes.filter((node) => node.kind === "generation").map((node) => [node.id, node.lane])).toEqual([
      ["gen-a", 1],
      ["gen-b", 2],
      ["gen-c", 3],
    ]);
  });

  // 已记录 endTime 的同步分支才生成 join；后台分支不隐含汇合（它可能比父级活得更久）。
  test("只为同步分支生成 join", () => {
    expect(
      buildTraceGraph(parallelAgents())
        .nodes.filter((node) => node.kind === "join")
        .map((node) => node.observation?.id),
    ).toEqual(["a", "c"]);
  });

  // 嵌套分支的 fork 连回父分支的泳道，而不是回到主线。
  test("嵌套子 agent 的 fork 落在父分支泳道上", () => {
    const fork = buildTraceGraph(parallelAgents(true)).nodes.find((node) => node.id === "fork:c");
    expect(fork?.parentLane).toBe(1);
  });

  // 子节点的开始时间早于父级（时钟偏移）时，fork 必须被提前到子节点之前，否则连线会从未来射向过去。
  test("子节点开始时间更早时提前 fork", () => {
    const graph = buildTraceGraph([
      observation("tool", "TOOL", null, 0),
      observation("skew", "AGENT", "tool", 5, { name: "subagent:skew" }),
      observation("skew-gen", "GENERATION", "skew", 2),
    ]);
    expect(graph.nodes.find((node) => node.id === "fork:skew")?.timestamp).toBe(EPOCH + 2000);
  });

  // 父级缺失或成环时退回主线：分支识别不能因为坏数据产生自环或无限上溯。
  test("父链缺失或成环时退回主线", () => {
    const missing = buildTraceGraph([observation("gen", "GENERATION", "ghost", 1)]);
    expect(missing.nodes[0].lane).toBe(0);
    const cyclic = buildTraceGraph([
      observation("a", "AGENT", "b", 0, { name: "subagent:a" }),
      observation("b", "AGENT", "a", 0.1, { name: "subagent:b" }),
    ]);
    expect(cyclic.nodes.filter((node) => node.kind === "fork").map((node) => node.parentLane)).toEqual([0, 0]);
  });

  // 被隐藏的 span 只做祖先桥接：夹在隐藏 SPAN 下的 generation 仍要落在它所属子 agent 的泳道上。
  test("隐藏 span 桥接分支归属并计入 hiddenCount", () => {
    const graph = buildTraceGraph([
      observation("root", "SPAN", null, 0),
      observation("research", "AGENT", "root", 1, { name: "subagent:research" }),
      observation("wrapper", "SPAN", "research", 1.1),
      observation("plan", "GENERATION", "wrapper", 1.2),
    ]);
    expect(graph.nodes.find((node) => node.id === "plan")?.lane).toBe(1);
    expect(graph.hiddenCount).toBe(2);
  });
});

describe("buildTraceGraphDisplay 行投影", () => {
  // 合并连续工具调用成一行多列，行投影不能丢节点，后续连线要重接到合并行。
  test("合并连续工具并重接后续连线", () => {
    const input = model(["generation", "tool", "tool", "tool", "tool", "generation"]);
    const display = buildTraceGraphDisplay(input, true);
    expect(display.rows.map((row) => row.nodes.length)).toEqual([1, 4, 1]);
    expect(display.rows.flatMap((row) => row.nodes.map((node) => node.id))).toEqual(input.nodes.map((node) => node.id));
    expect(display.edges.map((edge) => [edge.from.row, edge.to.row])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(display.rows[2].top).toBe(display.rows[0].height + display.rows[1].height);
    expect(buildTraceGraphDisplay(input, false).rows).toHaveLength(6);
  });

  // 可用列数变化时组行会换行：组高、后续行的 top 与总高都必须跟着重算，否则连线会落在行外的位置上。
  test("按可用列数重算组行高与后续行位置", () => {
    const input = model(["generation", "tool", "tool", "tool", "tool", "tool", "generation"]);
    const narrow = buildTraceGraphDisplay(input, true, 2);
    const wide = buildTraceGraphDisplay(input, true, 5);
    expect(narrow.rows[1].height).toBe(76);
    expect(wide.rows[1].height).toBe(28);
    expect(narrow.rows[2].top).toBe(104);
    expect(wide.rows[2].top).toBe(56);
    expect(narrow.height).toBe(132);
    expect(narrow.edges).toEqual(wide.edges);
    expect(narrow.rows.flatMap((row) => row.nodes)).toEqual(input.nodes);
    expect(buildTraceGraphDisplay(input, false, 2).height).toBe(input.nodes.length * 28);
  });

  // 泳道变化、generation 与 fork 都是分组边界，不能被合并进相邻组。
  test("泳道切换与 generation / fork 不参与合并", () => {
    const input = model(["tool", "tool", "fork", "tool", "generation", "tool"], [0, 1, 1, 1, 1, 1]);
    expect(buildTraceGraphDisplay(input, true).rows).toHaveLength(6);
  });

  // 同级 fork 合并成一行共享发射点：每条分支的发射线仍要保留各自的后台模式（虚线）。
  test("同级 fork 合并为一行并从共享点发射", () => {
    const input = buildTraceGraph(parallelAgents());
    const display = buildTraceGraphDisplay(input, true);
    const forkRow = display.rows.findIndex((row) => row.nodes[0].kind === "fork");
    expect(display.rows[forkRow].nodes.map((node) => node.observation?.id)).toEqual(["a", "b", "c"]);
    expect(display.rows[forkRow].lane).toBe(0);
    const launches = display.edges.filter((edge) => edge.kind === "fork");
    expect(launches).toHaveLength(3);
    expect(launches.map((edge) => edge.from)).toEqual(Array(3).fill({ row: forkRow, lane: 0 }));
    expect(launches.map((edge) => edge.to.lane)).toEqual([1, 2, 3]);
    expect(launches.map((edge) => edge.background)).toEqual([false, true, false]);
    expect(display.edges.filter((edge) => edge.kind === "join").map((edge) => edge.from.lane)).toEqual([1, 3]);
    expect(display.rows.flatMap((row) => row.nodes)).toEqual(input.nodes);
    expect(buildTraceGraphDisplay(input, false).rows.every((row) => row.nodes.length === 1)).toBe(true);
  });

  // 不同父泳道的 fork 不能合并：否则嵌套分支会被画成同级并发。
  test("嵌套 fork 不与同级 fork 合并", () => {
    const display = buildTraceGraphDisplay(buildTraceGraph(parallelAgents(true)), true);
    const forks = display.rows.filter((row) => row.nodes[0].kind === "fork");
    expect(forks.map((row) => row.nodes.map((node) => node.observation?.id))).toEqual([["a", "b"], ["c"]]);
  });

  // 源工具被合并成一行后，它下游的后台 fork 连线仍要保留后台标记。
  test("源工具合并后仍保留下游后台 fork", () => {
    const input = model(["tool", "tool", "fork", "generation"], [0, 0, 1, 1]);
    input.edges[1] = { ...input.edges[1], kind: "fork", background: true };
    const fork = buildTraceGraphDisplay(input, true).edges.find((edge) => edge.kind === "fork");
    expect(fork).toMatchObject({
      from: { row: 0, lane: 0 },
      to: { row: 1, lane: 1 },
      background: true,
    });
  });
});
