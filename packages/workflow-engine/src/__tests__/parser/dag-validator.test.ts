import { expect, test } from "bun:test";
import { validateDAG } from "../../parser/dag-validator";
import { parseWorkflowYaml } from "../../parser/yaml-parser";
import { type WorkflowError, WorkflowErrorCode } from "../../types/errors";

// 无环 DAG 校验通过
test("无环 DAG 校验通过", () => {
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
    depends_on: [a]
  - id: c
    type: shell
    command: echo c
    depends_on: [b]
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(true);
  expect(result.issues).toHaveLength(0);
  expect(result.def).toBeDefined();
});

// 校验器不修改原始输入
test("校验器不修改原始输入", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: step1
    type: shell
    command: echo hello
  - id: step2
    type: shell
    command: "echo \${{ nodes.step1.output.stdout }}"
`);
  const originalDeps = def.nodes[1].depends_on;
  validateDAG(def);
  expect(def.nodes[1].depends_on).toEqual(originalDeps);
});

// 环检测：环形依赖 DAG 报 CYCLE_DETECTED
test("环检测：环形依赖报 CYCLE_DETECTED", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a
    type: shell
    command: echo a
    depends_on: [c]
  - id: b
    type: shell
    command: echo b
    depends_on: [a]
  - id: c
    type: shell
    command: echo c
    depends_on: [b]
`);
  try {
    validateDAG(def);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.CYCLE_DETECTED);
    expect((e as WorkflowError).message).toContain("Cycle");
  }
});

// 自环检测
test("自环检测报 CYCLE_DETECTED", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a
    type: shell
    command: echo a
    depends_on: [a]
`);
  try {
    validateDAG(def);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.CYCLE_DETECTED);
  }
});

// 重复节点 ID
test("重复节点 ID 报 DUPLICATE_NODE_ID", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a
    type: shell
    command: echo a
  - id: a
    type: shell
    command: echo a2
`);
  try {
    validateDAG(def);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.DUPLICATE_NODE_ID);
  }
});

// 依赖不存在的节点
test("依赖不存在的节点报 MISSING_DEPENDENCY", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: a
    type: shell
    command: echo a
    depends_on: [nonexistent]
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(false);
  const depIssue = result.issues.find((i) => i.code === WorkflowErrorCode.MISSING_DEPENDENCY);
  expect(depIssue).toBeDefined();
  expect(depIssue!.message).toContain("nonexistent");
});

// 自动补充 depends_on（返回的 def 包含补充后的依赖）
test("自动扫描模板补充 depends_on", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: step1
    type: shell
    command: echo hello
  - id: step2
    type: shell
    command: "echo \${{ nodes.step1.output.stdout }}"
`);
  const result = validateDAG(def);
  // 自动补充应产生 warning
  const autoDep = result.issues.find((i) => i.code === "AUTO_DEPENDENCY_ADDED");
  expect(autoDep).toBeDefined();
  expect(autoDep!.message).toContain("step1");
  // 返回的 def 中 step2 的 depends_on 应已被修改
  expect(result.def.nodes[1].depends_on).toContain("step1");
});

// 自动补充后 DAG 仍然有效
test("自动补充后 DAG 校验通过", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: step1
    type: shell
    command: echo hello
  - id: step2
    type: shell
    command: "echo \${{ nodes.step1.output.stdout }}"
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(true);
});

// 已声明的 depends_on 不重复添加
test("已声明的 depends_on 不重复添加", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: step1
    type: shell
    command: echo hello
  - id: step2
    type: shell
    command: "echo \${{ nodes.step1.output.stdout }}"
    depends_on: [step1]
`);
  const result = validateDAG(def);
  const autoDep = result.issues.find((i) => i.code === "AUTO_DEPENDENCY_ADDED");
  expect(autoDep).toBeUndefined();
  expect(result.def.nodes[1].depends_on).toEqual(["step1"]);
});

// 多个模板引用自动补充多个依赖
test("多个模板引用自动补充多个依赖", () => {
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
  - id: c
    type: shell
    command: "\${{ nodes.a.output.stdout }} \${{ nodes.b.output.stdout }}"
`);
  const result = validateDAG(def);
  const autoDeps = result.issues.filter((i) => i.code === "AUTO_DEPENDENCY_ADDED");
  expect(autoDeps).toHaveLength(2);
  expect(result.def.nodes[2].depends_on).toContain("a");
  expect(result.def.nodes[2].depends_on).toContain("b");
});

// env 字段中的模板引用也扫描
test("env 字段中的模板引用也扫描", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: step1
    type: shell
    command: echo hello
  - id: step2
    type: shell
    command: echo hi
    env:
      RESULT: "\${{ nodes.step1.output.stdout }}"
`);
  const result = validateDAG(def);
  const autoDep = result.issues.find((i) => i.code === "AUTO_DEPENDENCY_ADDED");
  expect(autoDep).toBeDefined();
  expect(result.def.nodes[1].depends_on).toContain("step1");
});

// 空节点列表
test("空节点列表校验通过", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes: []
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(true);
});

// 复杂 DAG 无环
test("复杂 DAG 无环校验通过", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: complex
nodes:
  - id: a
    type: shell
    command: echo a
  - id: b
    type: shell
    command: echo b
  - id: c
    type: shell
    command: echo c
    depends_on: [a]
  - id: d
    type: shell
    command: echo d
    depends_on: [a]
  - id: e
    type: shell
    command: echo e
    depends_on: [b, c]
  - id: f
    type: shell
    command: echo f
    depends_on: [d, e]
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(true);
});
