import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import * as yaml from "js-yaml";
import {
  createStartNode,
  defaultMeta,
  flowToYaml,
  nextEdgeId,
  nextNodeId,
  parseDataFlowEdges,
  resetEdgeCounter,
  resetNodeCounter,
  START_NODE_ID,
  syncEdgeCounter,
  syncNodeCounter,
  type WfMeta,
  yamlToFlow,
} from "../pages/workflow/yaml-utils";

function workflowMeta(overrides: Partial<WfMeta> = {}): WfMeta {
  return {
    schema_version: "1",
    name: "测试工作流",
    description: "",
    timeout: 300,
    params: {},
    secrets: [],
    ...overrides,
  };
}

function flowNode(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function logicEdge(source: string, target: string): Edge {
  return { id: `logic-${source}-${target}`, source, target, type: "logic" };
}

describe("workflow yaml utils 纯逻辑", () => {
  // 起始节点必须使用保留 ID，避免导入工作流时产生多个入口节点。
  test("createStartNode 创建不可删除的固定起始节点", () => {
    expect(createStartNode()).toEqual({
      id: START_NODE_ID,
      type: "start",
      position: { x: 40, y: 200 },
      data: {},
      deletable: false,
    });
  });

  // 默认元数据为新建工作流提供稳定且完整的初始值。
  test("defaultMeta 提供新工作流默认值", () => {
    expect(defaultMeta).toEqual({
      schema_version: "1",
      name: "new-workflow",
      description: "",
      timeout: 300,
      params: {},
      secrets: [],
    });
  });

  // 空 YAML 不代表空工作流；解析器应抛错，调用方才能提示用户提供有效内容。
  test("yamlToFlow 对空文档抛出解析错误", () => {
    expect(() => yamlToFlow("")).toThrow();
  });

  // 缺省节点 type 时采用 shell，保持旧 YAML 可被编辑器加载。
  test("yamlToFlow 为缺失 type 的节点补 shell 类型", () => {
    const { nodes } = yamlToFlow("nodes:\n  - id: task_1\n");

    expect(nodes[1]).toMatchObject({ id: "task_1", type: "shell", data: {} });
  });

  // 节点在画布上的初始位置应按索引稳定排列。
  test("yamlToFlow 为连续节点生成稳定位置", () => {
    const { nodes } = yamlToFlow(
      "nodes:\n  - id: one\n    type: shell\n  - id: two\n    type: python\n  - id: three\n    type: agent\n  - id: four\n    type: api\n",
    );

    expect(nodes.slice(1).map((node) => node.position)).toEqual([
      { x: 100, y: 80 },
      { x: 300, y: 180 },
      { x: 500, y: 280 },
      { x: 100, y: 380 },
    ]);
  });

  // 无依赖节点必须由起始节点连接，避免在画布中成为孤立节点。
  test("yamlToFlow 为根节点创建 start 逻辑边", () => {
    const { edges } = yamlToFlow("nodes:\n  - id: root\n    type: shell\n");

    expect(edges).toEqual([
      {
        id: `logic-${START_NODE_ID}-root`,
        source: START_NODE_ID,
        target: "root",
        type: "logic",
        data: { hasCondition: false },
      },
    ]);
  });

  // 显式依赖只能产生上游逻辑边，不应额外连接起始节点。
  test("yamlToFlow 为 depends_on 创建上游逻辑边", () => {
    const { edges } = yamlToFlow(
      "nodes:\n  - id: upstream\n    type: shell\n  - id: downstream\n    type: shell\n    depends_on: [upstream]\n",
    );

    expect(edges.filter((edge) => edge.target === "downstream")).toEqual([
      {
        id: "logic-upstream-downstream",
        source: "upstream",
        target: "downstream",
        type: "logic",
        data: { hasCondition: false },
      },
    ]);
  });

  // 条件字段应标记所有入边，使编辑器正确呈现条件连线。
  test("yamlToFlow 标记带 condition 节点的逻辑边", () => {
    const { edges } = yamlToFlow(
      "nodes:\n  - id: source\n    type: shell\n  - id: target\n    type: shell\n    depends_on: [source]\n    condition: result.ok\n",
    );

    expect(edges.find((edge) => edge.target === "target")?.data).toEqual({ hasCondition: true });
  });

  // 空条件不应误标为条件边，避免出现无效的条件视觉提示。
  test("yamlToFlow 将空 condition 视为普通逻辑边", () => {
    const { edges } = yamlToFlow(
      "nodes:\n  - id: source\n    type: shell\n  - id: target\n    type: shell\n    depends_on: [source]\n    condition: ''\n",
    );

    expect(edges.find((edge) => edge.target === "target")?.data).toEqual({ hasCondition: false });
  });

  // YAML 节点协议字段不得泄漏进 React Flow 的 data。
  test("yamlToFlow 将业务字段与协议字段分离", () => {
    const { nodes } = yamlToFlow(
      "nodes:\n  - id: task\n    type: shell\n    depends_on: [previous]\n    command: echo hello\n    retries: 2\n",
    );

    expect(nodes[1]?.data).toEqual({ command: "echo hello", retries: 2 });
  });

  // 由 inputs 引用的输出字段应注入源节点，供输出 Handle 展示。
  test("yamlToFlow 为被引用的源节点注入输出字段", () => {
    const { nodes } = yamlToFlow(
      "nodes:\n  - id: source\n    type: shell\n  - id: target\n    type: shell\n    inputs:\n      value: ${{ nodes.source.output.answer }}\n",
    );

    expect(nodes.find((node) => node.id === "source")?.data).toEqual({ _outputFields: ["answer"] });
  });

  // 相同源字段被多次引用时只保留一次输出 Handle。
  test("yamlToFlow 对重复输出字段去重", () => {
    const { nodes } = yamlToFlow(
      "nodes:\n  - id: source\n    type: shell\n  - id: target\n    type: shell\n    inputs:\n      first: nodes.source.value\n      second: nodes.source.value\n",
    );

    expect(nodes.find((node) => node.id === "source")?.data).toEqual({ _outputFields: ["value"] });
  });

  // inputs 引用须转换成数据流边并保留双方字段语义。
  test("yamlToFlow 从 inputs 创建数据流边", () => {
    const { edges } = yamlToFlow(
      "nodes:\n  - id: source\n    type: shell\n  - id: target\n    type: shell\n    inputs:\n      payload: nodes.source.result\n",
    );

    expect(edges.find((edge) => edge.type === "dataFlow")).toEqual({
      id: "data-source.result-target.payload",
      source: "source",
      target: "target",
      sourceHandle: "out-result",
      targetHandle: "in-payload",
      type: "dataFlow",
      data: { sourceField: "result", targetParam: "payload" },
    });
  });

  // schema_version 的空字符串沿用兼容默认值而 timeout 的零值必须保留。
  test("yamlToFlow 区分空字符串默认值与零 timeout", () => {
    const { meta } = yamlToFlow("schema_version: ''\nname: ''\ntimeout: 0\n");

    expect(meta).toEqual({
      schema_version: "1",
      name: "untitled",
      description: "",
      timeout: 0,
      params: {},
      secrets: [],
    });
  });

  // secrets 中空项应在解析边界清除，防止下游误认为存在密钥引用。
  test("yamlToFlow 过滤空 secrets", () => {
    const { meta } = yamlToFlow("secrets: [API_KEY, '', null, DB_URL]\n");

    expect(meta.secrets).toEqual(["API_KEY", "DB_URL"]);
  });

  // YAML 解析异常应原样抛出，调用方才能提供明确的导入失败反馈。
  test("yamlToFlow 对无效 YAML 抛出解析错误", () => {
    expect(() => yamlToFlow("nodes: [")).toThrow();
  });

  // 序列化时起始节点是编辑器内部结构，不能写回工作流协议。
  test("flowToYaml 跳过起始节点", () => {
    const parsed = yaml.load(flowToYaml([createStartNode(), flowNode("task", "shell")], [], workflowMeta())) as {
      nodes: Array<{ id: string }>;
    };

    expect(parsed.nodes).toEqual([{ id: "task", type: "shell" }]);
  });

  // 普通逻辑边应写为 depends_on，而数据流边不参与执行依赖。
  test("flowToYaml 仅将逻辑边写为 depends_on", () => {
    const nodes = [flowNode("source", "shell"), flowNode("target", "shell")];
    const edges: Edge[] = [
      logicEdge("source", "target"),
      { id: "data", source: "source", target: "target", type: "dataFlow" },
    ];
    const parsed = yaml.load(flowToYaml(nodes, edges, workflowMeta())) as { nodes: Array<Record<string, unknown>> };

    expect(parsed.nodes[1]).toEqual({ id: "target", type: "shell", depends_on: ["source"] });
  });

  // 同一来源的重复边不得生成重复依赖，确保 YAML 可读且语义幂等。
  test("flowToYaml 对重复逻辑边去重", () => {
    const parsed = yaml.load(
      flowToYaml(
        [flowNode("source", "shell"), flowNode("target", "shell")],
        [logicEdge("source", "target"), logicEdge("source", "target")],
        workflowMeta(),
      ),
    ) as { nodes: Array<Record<string, unknown>> };

    expect(parsed.nodes[1]?.depends_on).toEqual(["source"]);
  });

  // 节点 data 的内部运行时字段不得出现在导出的 YAML 中。
  test("flowToYaml 忽略下划线开头的内部字段", () => {
    const parsed = yaml.load(
      flowToYaml([flowNode("task", "shell", { command: "echo ok", _outputFields: ["result"] })], [], workflowMeta()),
    ) as {
      nodes: Array<Record<string, unknown>>;
    };

    expect(parsed.nodes[0]).toEqual({ id: "task", type: "shell", command: "echo ok" });
  });

  // null、undefined 与空字符串是未填写表单值，导出时必须省略。
  test("flowToYaml 省略空节点字段", () => {
    const parsed = yaml.load(
      flowToYaml(
        [flowNode("task", "shell", { empty: "", nil: null, missing: undefined, zero: 0, enabled: false })],
        [],
        workflowMeta(),
      ),
    ) as {
      nodes: Array<Record<string, unknown>>;
    };

    expect(parsed.nodes[0]).toEqual({ id: "task", type: "shell", zero: 0, enabled: false });
  });

  // 空描述、参数和密钥不应污染最小化 YAML 输出。
  test("flowToYaml 省略空的可选元数据", () => {
    const parsed = yaml.load(flowToYaml([], [], workflowMeta())) as Record<string, unknown>;

    expect(parsed).toEqual({ schema_version: "1", name: "测试工作流", timeout: 300, nodes: [] });
  });

  // 非空元数据与有效密钥引用应完整保留。
  test("flowToYaml 保留非空元数据", () => {
    const parsed = yaml.load(
      flowToYaml([], [], workflowMeta({ description: "说明", params: { limit: 10 }, secrets: ["API_KEY", ""] })),
    ) as Record<string, unknown>;

    expect(parsed).toEqual({
      schema_version: "1",
      name: "测试工作流",
      description: "说明",
      timeout: 300,
      params: { limit: 10 },
      secrets: ["API_KEY"],
      nodes: [],
    });
  });

  // 序列化不得修改调用方提供的节点和边，避免编辑器状态被导出操作污染。
  test("flowToYaml 不修改输入节点与边", () => {
    const nodes = [flowNode("task", "shell", { command: "echo ok" })];
    const edges = [logicEdge("source", "task")];
    const nodesBefore = structuredClone(nodes);
    const edgesBefore = structuredClone(edges);

    flowToYaml(nodes, edges, workflowMeta());

    expect(nodes).toEqual(nodesBefore);
    expect(edges).toEqual(edgesBefore);
  });

  // YAML 往返后应保留节点业务数据与逻辑依赖。
  test("工作流 YAML 往返保留核心语义", () => {
    const source =
      "name: demo\ndescription: round trip\ntimeout: 20\nparams:\n  region: cn\nsecrets: [API_KEY]\nnodes:\n  - id: fetch\n    type: api\n    url: https://example.test\n  - id: process\n    type: shell\n    depends_on: [fetch]\n    command: echo done\n";
    const first = yamlToFlow(source);
    const second = yamlToFlow(flowToYaml(first.nodes, first.edges, first.meta));

    expect(second.meta).toEqual({
      schema_version: "1",
      name: "demo",
      description: "round trip",
      timeout: 20,
      params: { region: "cn" },
      secrets: ["API_KEY"],
    });
    expect(second.nodes.slice(1).map((node) => ({ id: node.id, type: node.type, data: node.data }))).toEqual([
      { id: "fetch", type: "api", data: { url: "https://example.test" } },
      { id: "process", type: "shell", data: { command: "echo done" } },
    ]);
  });

  // 节点 ID 计数器重置后从一开始，方便创建新工作流时获得可预测 ID。
  test("resetNodeCounter 重置节点序号", () => {
    resetNodeCounter();
    nextNodeId("shell");
    resetNodeCounter();

    expect(nextNodeId("shell")).toBe("shell_1");
  });

  // 已知类型必须使用约定前缀，便于 YAML 阅读与后续载入。
  test("nextNodeId 为已知类型生成约定前缀", () => {
    resetNodeCounter();

    expect([nextNodeId("python"), nextNodeId("workflow"), nextNodeId("transform")]).toEqual([
      "python_1",
      "wf_2",
      "tf_3",
    ]);
  });

  // 未知节点类型仍需安全生成通用 ID，避免 UI 因插件类型中断。
  test("nextNodeId 为未知类型回退通用前缀", () => {
    resetNodeCounter();

    expect(nextNodeId("future")).toBe("node_1");
  });

  // 节点计数器只能向前同步，历史小编号不能造成重复 ID。
  test("syncNodeCounter 不降低已有计数器", () => {
    resetNodeCounter();
    nextNodeId("shell");
    nextNodeId("shell");
    syncNodeCounter(["shell_1"]);

    expect(nextNodeId("shell")).toBe("shell_3");
  });

  // 节点计数器读取不同前缀的最大数字后缀。
  test("syncNodeCounter 采用有效 ID 的最大后缀", () => {
    resetNodeCounter();
    syncNodeCounter(["shell_7", "wf_12", "bad_", "upper_9x", "with-dash_20"]);

    expect(nextNodeId("agent")).toBe("agent_13");
  });

  // 边 ID 计数器重置后保持可预测，便于测试与调试。
  test("resetEdgeCounter 重置边序号", () => {
    resetEdgeCounter();
    nextEdgeId("a", "b");
    resetEdgeCounter();

    expect(nextEdgeId("a", "b")).toBe("e1_a_b");
  });

  // 边 ID 应保留 source 和 target 后缀以提供诊断上下文。
  test("nextEdgeId 包含连接两端", () => {
    resetEdgeCounter();

    expect(nextEdgeId("source-node", "target-node")).toBe("e1_source-node_target-node");
  });

  // 边计数器只能单调增长，低编号历史边不可使其回退。
  test("syncEdgeCounter 不降低已有计数器", () => {
    resetEdgeCounter();
    nextEdgeId("a", "b");
    nextEdgeId("b", "c");
    syncEdgeCounter(["e1_a_b"]);

    expect(nextEdgeId("c", "d")).toBe("e3_c_d");
  });

  // 同步边计数器时只识别协议格式的 e<number> 前缀。
  test("syncEdgeCounter 忽略非法 ID 并采用最大有效序号", () => {
    resetEdgeCounter();
    syncEdgeCounter(["e8_a_b", "edge_99", "e_bad", "e12_"]);

    expect(nextEdgeId("a", "b")).toBe("e13_a_b");
  });

  // 普通 nodes.X.field 引用必须解析为数据流边描述。
  test("parseDataFlowEdges 解析普通节点字段引用", () => {
    const result = parseDataFlowEdges([flowNode("target", "shell", { inputs: { value: "nodes.source.answer" } })]);

    expect(result).toEqual([
      { sourceNodeId: "source", sourceField: "answer", targetNodeId: "target", targetParam: "value" },
    ]);
  });

  // 模板表达式语法应去除包装符后按相同规则解析。
  test("parseDataFlowEdges 解析模板表达式引用", () => {
    const result = parseDataFlowEdges([
      flowNode("target", "shell", { inputs: { value: "${{ nodes.source.answer }}" } }),
    ]);

    expect(result).toEqual([
      { sourceNodeId: "source", sourceField: "answer", targetNodeId: "target", targetParam: "value" },
    ]);
  });

  // output 是协议命名空间而非真实字段名，生成 Handle 时必须移除。
  test("parseDataFlowEdges 移除 output 命名空间", () => {
    const result = parseDataFlowEdges([
      flowNode("target", "shell", { inputs: { value: "nodes.source.output.answer" } }),
    ]);

    expect(result[0]?.sourceField).toBe("answer");
  });

  // 节点 ID 可包含横线与下划线，兼容用户导入的合法工作流。
  test("parseDataFlowEdges 支持带横线的源节点 ID", () => {
    const result = parseDataFlowEdges([
      flowNode("target", "shell", { inputs: { value: "nodes.source-node_1.result.value" } }),
    ]);

    expect(result).toEqual([
      { sourceNodeId: "source-node_1", sourceField: "result.value", targetNodeId: "target", targetParam: "value" },
    ]);
  });

  // 非字符串输入表达式不能被误解析为引用。
  test("parseDataFlowEdges 跳过非字符串输入", () => {
    const result = parseDataFlowEdges([
      flowNode("target", "shell", { inputs: { count: 1, enabled: true, missing: null } }),
    ]);

    expect(result).toEqual([]);
  });

  // 格式错误或不完整的表达式必须安全忽略，不能创建悬空边。
  test("parseDataFlowEdges 跳过无效表达式", () => {
    const result = parseDataFlowEdges([
      flowNode("target", "shell", { inputs: { one: "source.value", two: "nodes..value", three: "nodes.source" } }),
    ]);

    expect(result).toEqual([]);
  });

  // 起始节点中的 inputs 属于内部状态，不应生成数据流边。
  test("parseDataFlowEdges 跳过起始节点", () => {
    const result = parseDataFlowEdges([flowNode(START_NODE_ID, "start", { inputs: { value: "nodes.source.answer" } })]);

    expect(result).toEqual([]);
  });

  // 解析函数只读取输入数据，不得向节点 data 注入或修改字段。
  test("parseDataFlowEdges 不修改输入节点", () => {
    const nodes = [flowNode("target", "shell", { inputs: { value: "nodes.source.answer" } })];
    const before = structuredClone(nodes);

    parseDataFlowEdges(nodes);

    expect(nodes).toEqual(before);
  });
});
