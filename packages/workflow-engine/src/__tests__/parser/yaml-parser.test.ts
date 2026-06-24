import { expect, test } from "bun:test";
import { parseWorkflowYaml } from "../../parser/yaml-parser";
import { CustomNodeRegistry } from "../../plugins/registry";
import type { CustomNode } from "../../plugins/types";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";

const VALID_YAML = `\
schema_version: '1'
name: hello-world
params:
  input:
    type: string
    default: hello
nodes:
  - id: step1
    type: shell
    command: 'echo "\${{ params.input }}"'
  - id: step2
    type: shell
    command: echo "done"
    depends_on: [step1]
`;

// 解析有效 YAML 得到正确 WorkflowDef
test("解析有效 YAML 得到 WorkflowDef", () => {
  const def = parseWorkflowYaml(VALID_YAML);
  expect(def.schema_version).toBe("1");
  expect(def.name).toBe("hello-world");
  expect(def.nodes).toHaveLength(2);
  expect(def.nodes[0].id).toBe("step1");
  expect(def.nodes[0].type).toBe("shell");
  expect(def.nodes[1].depends_on).toEqual(["step1"]);
});

// 解析缺少 schema_version 的 YAML
test("缺少 schema_version 报错", () => {
  expect(() =>
    parseWorkflowYaml(`\
name: test
nodes:
  - id: a
    type: shell
    command: echo hi
`),
  ).toThrow(WorkflowError);
  try {
    parseWorkflowYaml(`name: test\nnodes:\n  - id: a\n    type: shell\n    command: echo hi\n`);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("schema_version");
  }
});

// 解析缺少 name 的 YAML
test("缺少 name 报错", () => {
  try {
    parseWorkflowYaml(`\
schema_version: '1'
nodes:
  - id: a
    type: shell
    command: echo hi
`);
    expect(true).toBe(false); // 不应到达
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("name");
  }
});

// schema_version 不为 1
test("schema_version 不为 1 报错", () => {
  try {
    parseWorkflowYaml(`\
schema_version: '2'
name: test
nodes: []
`);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("schema_version");
  }
});

// 缺少 nodes 字段
test("缺少 nodes 字段报错", () => {
  try {
    parseWorkflowYaml(`\
schema_version: '1'
name: test
`);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("nodes");
  }
});

// acpx-g 格式检测
test("acpx-g 格式 YAML 应报 INVALID_YAML", () => {
  try {
    parseWorkflowYaml(`\
kind: Pipeline
metadata:
  name: test
spec:
  steps:
    - name: step1
`);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("acpx-g");
  }
});

// 无效节点类型
test("无效节点类型报错", () => {
  try {
    parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a
    type: invalid_type
    command: echo hi
`);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("invalid_type");
  }
});

// 隐式起始节点
test("无 depends_on 的节点识别为起始节点", () => {
  const def = parseWorkflowYaml(VALID_YAML);
  expect(def._startNodeId).toBe("step1");
});

// 多个起始节点时 _startNodeId 不设置
test("多个起始节点时不设置 _startNodeId", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a
    type: shell
    command: echo a
  - id: b
    type: shell
    command: echo b
`);
  expect(def._startNodeId).toBeUndefined();
});

// baseDir 设置
test("设置 _baseDir", () => {
  const def = parseWorkflowYaml(VALID_YAML, "/tmp/workflows");
  expect(def._baseDir).toBe("/tmp/workflows");
});

// 默认 baseDir
test("默认 _baseDir 为 cwd", () => {
  const def = parseWorkflowYaml(VALID_YAML);
  expect(def._baseDir).toBe(process.cwd());
});

// 各节点类型解析
test("解析 agent 节点", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a1
    type: agent
    prompt: "hello {{ params.x }}"
    agent: gpt-4
`);
  expect(def.nodes[0].type).toBe("agent");
  if (def.nodes[0].type === "agent") {
    expect(def.nodes[0].prompt).toBe("hello {{ params.x }}");
    expect(def.nodes[0].agent).toBe("gpt-4");
  }
});

test("解析 api 节点", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a1
    type: api
    url: https://example.com
    method: POST
    headers:
      Authorization: Bearer token
`);
  expect(def.nodes[0].type).toBe("api");
  if (def.nodes[0].type === "api") {
    expect(def.nodes[0].url).toBe("https://example.com");
    expect(def.nodes[0].method).toBe("POST");
  }
});

test("解析 audit 节点", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a1
    type: audit
    display_data: "请审批"
    expires_in: 3600
`);
  expect(def.nodes[0].type).toBe("audit");
});

test("解析 workflow 节点", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a1
    type: workflow
    ref: ./sub.yaml
    ignore_errors: true
`);
  expect(def.nodes[0].type).toBe("workflow");
  if (def.nodes[0].type === "workflow") {
    expect(def.nodes[0].ref).toBe("./sub.yaml");
    expect(def.nodes[0].ignore_errors).toBe(true);
  }
});

test("解析 loop 节点", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: loop1
    type: loop
    condition: "items.length > 0"
    max_iterations: 10
    body:
      nodes:
        - id: inner1
          type: shell
          command: echo "item"
`);
  expect(def.nodes[0].type).toBe("loop");
  if (def.nodes[0].type === "loop") {
    expect(def.nodes[0].max_iterations).toBe(10);
    expect(def.nodes[0].body.nodes).toHaveLength(1);
  }
});

// 无效 YAML（语法错误）
test("无效 YAML 语法报错", () => {
  try {
    parseWorkflowYaml(`\n  bad: [unclosed`);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
  }
});

// description 和可选字段
test("解析 description 和可选字段", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
description: "测试工作流"
timeout: 300
secrets:
  - API_KEY
params:
  x:
    type: string
nodes:
  - id: a
    type: shell
    command: echo hi
`);
  expect(def.description).toBe("测试工作流");
  expect(def.timeout).toBe(300);
  expect(def.secrets).toEqual(["API_KEY"]);
});

// depends_on 为空数组视为起始节点
test("depends_on 为空数组视为起始节点", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a
    type: shell
    command: echo hi
    depends_on: []
  - id: b
    type: shell
    command: echo hi
    depends_on: [a]
`);
  expect(def._startNodeId).toBe("a");
});

// agent 节点解析 output_messages 可选字段
test("agent 节点解析 output_messages 可选字段", () => {
  const yaml = `
schema_version: "1"
name: test
nodes:
  - id: step1
    type: agent
    prompt: "hello"
    agent: general
    output_messages: 5
`;
  const def = parseWorkflowYaml(yaml);
  const node = def.nodes[0] as import("../../types/dag").AgentNodeDef;
  expect(node.agent).toBe("general");
  expect(node.output_messages).toBe(5);
});

// agent 节点省略可选字段时为 undefined
test("agent 节点省略可选字段时为 undefined", () => {
  const yaml = `
schema_version: "1"
name: test
nodes:
  - id: step1
    type: agent
    prompt: "hello"
    agent: general
`;
  const def = parseWorkflowYaml(yaml);
  const node = def.nodes[0] as import("../../types/dag").AgentNodeDef;
  expect(node.agent).toBe("general");
  expect(node.output_messages).toBeUndefined();
});

// agent 节点缺少 agent 字段时抛错
test("agent 节点缺少 agent 字段时抛错", () => {
  const yaml = `
schema_version: "1"
name: test
nodes:
  - id: step1
    type: agent
    prompt: "hello"
`;
  expect(() => parseWorkflowYaml(yaml)).toThrow(/agent node requires 'agent'/);
});

// ═══════════════════════════════════════════════════════════════
// Custom 节点解析测试
// ═══════════════════════════════════════════════════════════════

/** 创建带假工具的 CustomNodeRegistry，用于测试 */
function createFakeRegistry(
  tools: Array<{ name: string; produces: string[]; kind?: "default" | "slurm" }>,
): CustomNodeRegistry {
  const registry = new CustomNodeRegistry();
  for (const t of tools) {
    registry.register({
      name: t.name,
      description: `Fake ${t.name}`,
      inputs: {},
      produces: t.produces,
      kind: t.kind,
      execute: async () => ({ stdout: "ok", exit_code: 0 }),
    } as CustomNode);
  }
  return registry;
}

test("解析 custom 节点", () => {
  const registry = createFakeRegistry([{ name: "trim_galore", produces: ["trimmed_r1", "trimmed_r2"] }]);
  const def = parseWorkflowYaml(
    `\
schema_version: '1'
name: test
nodes:
  - id: trim
    type: custom
    tool: trim_galore
    outputs:
      trimmed_r1:
        pattern: "/tmp/\${{ foreach.item.id }}_1.fq.gz"
        type: file
      trimmed_r2:
        pattern: "/tmp/\${{ foreach.item.id }}_2.fq.gz"
        type: file
`,
    undefined,
    { customRegistry: registry },
  );
  expect(def.nodes[0].type).toBe("custom");
  if (def.nodes[0].type === "custom") {
    expect(def.nodes[0].tool).toBe("trim_galore");
  }
});

test("custom 节点缺少 tool 字段报错", () => {
  try {
    parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: bad
    type: custom
    outputs:
      x:
        pattern: /tmp/x.txt
        type: file
`);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as Error).message).toContain("tool");
  }
});

test("custom 节点 tool 未注册时报错", () => {
  const registry = createFakeRegistry([]);
  try {
    parseWorkflowYaml(
      `\
schema_version: '1'
name: test
nodes:
  - id: bad
    type: custom
    tool: nonexistent
    outputs:
      x:
        pattern: /tmp/x.txt
        type: file
`,
      undefined,
      { customRegistry: registry },
    );
    expect(true).toBe(false);
  } catch (e) {
    expect((e as Error).message).toContain("not registered");
  }
});

test("custom 节点缺少 outputs 报错", () => {
  const registry = createFakeRegistry([{ name: "trim_galore", produces: ["out"] }]);
  try {
    parseWorkflowYaml(
      `\
schema_version: '1'
name: test
nodes:
  - id: bad
    type: custom
    tool: trim_galore
`,
      undefined,
      { customRegistry: registry },
    );
    expect(true).toBe(false);
  } catch (e) {
    expect((e as Error).message).toContain("outputs");
  }
});

test("custom 节点解析可选字段", () => {
  const registry = createFakeRegistry([{ name: "my_tool", produces: ["out"] }]);
  const def = parseWorkflowYaml(
    `\
schema_version: '1'
name: test
nodes:
  - id: c1
    type: custom
    tool: my_tool
    foreach: "\${{ params.samples }}"
    maxConcurrent: 3
    continueOnError: true
    inputs:
      r1: "\${{ foreach.item.r1 }}"
    outputs:
      out:
        pattern: /tmp/out.txt
        type: file
`,
    undefined,
    { customRegistry: registry },
  );
  expect(def.nodes[0].type).toBe("custom");
  if (def.nodes[0].type === "custom") {
    expect(def.nodes[0].foreach).toBe("${{ params.samples }}");
    expect(def.nodes[0].maxConcurrent).toBe(3);
    expect(def.nodes[0].continueOnError).toBe(true);
    expect(def.nodes[0].inputs).toEqual({ r1: "${{ foreach.item.r1 }}" });
  }
});

test("无 registry 时 custom 节点跳过 tool 校验", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: c1
    type: custom
    tool: any_tool
    outputs:
      out:
        pattern: /tmp/x.txt
        type: file
`);
  expect(def.nodes[0].type).toBe("custom");
  if (def.nodes[0].type === "custom") {
    expect(def.nodes[0].tool).toBe("any_tool");
  }
});

// ── custom 节点 script 字段解析 ──

// 解析 slurm 工具的 script.content + script.env
test("解析 slurm 工具的 script.content + script.env", () => {
  const registry = createFakeRegistry([{ name: "slurm", produces: ["*"], kind: "slurm" }]);
  const def = parseWorkflowYaml(
    `\
schema_version: '1'
name: test
nodes:
  - id: job1
    type: custom
    tool: slurm
    script:
      content: |
        echo hello
        echo $WORK_DIR
      env:
        WORK_DIR: /data
    outputs:
      out:
        pattern: /tmp/out
        type: file
`,
    undefined,
    { customRegistry: registry },
  );
  expect(def.nodes[0].type).toBe("custom");
  if (def.nodes[0].type === "custom") {
    expect(def.nodes[0].script).toBeDefined();
    expect(def.nodes[0].script?.content).toContain("echo hello");
    expect(def.nodes[0].script?.env?.WORK_DIR).toBe("/data");
  }
});

// slurm 工具缺少 script 字段报错
test("slurm 工具缺少 script 字段报错", () => {
  const registry = createFakeRegistry([{ name: "slurm", produces: ["*"], kind: "slurm" }]);
  expect(() =>
    parseWorkflowYaml(
      `\
schema_version: '1'
name: test
nodes:
  - id: job1
    type: custom
    tool: slurm
    outputs:
      out:
        pattern: /tmp/out
        type: file
`,
      undefined,
      { customRegistry: registry },
    ),
  ).toThrow(/script\.content/);
});

// slurm 工具缺少 script.content 报错
test("slurm 工具缺少 script.content 报错", () => {
  const registry = createFakeRegistry([{ name: "slurm", produces: ["*"], kind: "slurm" }]);
  expect(() =>
    parseWorkflowYaml(
      `\
schema_version: '1'
name: test
nodes:
  - id: job1
    type: custom
    tool: slurm
    script:
      env:
        FOO: bar
    outputs:
      out:
        pattern: /tmp/out
        type: file
`,
      undefined,
      { customRegistry: registry },
    ),
  ).toThrow(/script\.content/);
});

// 非 slurm 工具声明 script 字段报错
test("非 slurm 工具声明 script 字段报错", () => {
  const registry = createFakeRegistry([{ name: "plain_tool", produces: ["out"], kind: "default" }]);
  expect(() =>
    parseWorkflowYaml(
      `\
schema_version: '1'
name: test
nodes:
  - id: job1
    type: custom
    tool: plain_tool
    script:
      content: echo hi
    outputs:
      out:
        pattern: /tmp/out
        type: file
`,
      undefined,
      { customRegistry: registry },
    ),
  ).toThrow(/does not support 'script'/);
});

// script.env 非字符串 value 被 warn 并跳过
test("script.env 非字符串 value 被 warn 并跳过", () => {
  const registry = createFakeRegistry([{ name: "slurm", produces: ["*"], kind: "slurm" }]);
  const def = parseWorkflowYaml(
    `\
schema_version: '1'
name: test
nodes:
  - id: job1
    type: custom
    tool: slurm
    script:
      content: echo hi
      env:
        VALID: ok
        BAD_NUM: 123
        BAD_BOOL: true
    outputs:
      out:
        pattern: /tmp/out
        type: file
`,
    undefined,
    { customRegistry: registry },
  );
  if (def.nodes[0].type === "custom") {
    expect(def.nodes[0].script?.env?.VALID).toBe("ok");
    expect(def.nodes[0].script?.env?.BAD_NUM).toBeUndefined();
    expect(def.nodes[0].script?.env?.BAD_BOOL).toBeUndefined();
  }
});

// shell 节点声明 outputs 被解析到 ShellNodeDef.outputs（继承自 BaseNodeDef）
test("shell 节点声明 outputs 被解析到 ShellNodeDef.outputs", () => {
  const yamlStr = `
schema_version: "1"
name: test
nodes:
  - id: s1
    type: shell
    command: echo hi
    outputs:
      result:
        pattern: /tmp/out.txt
        type: file
`;
  const wf = parseWorkflowYaml(yamlStr);
  const node = wf.nodes[0];
  expect(node.type).toBe("shell");
  expect(node.outputs).toEqual({
    result: { pattern: "/tmp/out.txt", type: "file" },
  });
});
