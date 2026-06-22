# 自定义节点插件系统 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 workflow-engine 新增 `custom` 节点类型，支持用户在 `tools/` 目录放置 TS 文件定义自定义工具，引擎启动时自动扫描注册、YAML 解析时校验、执行时分发。

**Architecture:** 新增 `plugins/` 模块（`types.ts` / `registry.ts` / `custom-executor.ts`），修改 `types/dag.ts`（新增 `CustomNodeDef`）、`yaml-parser.ts`（解析 `type: custom`）、`workflow-engine.ts`（注册 custom executor）、`index.ts`（导出新类型）。遵循 TDD：每个 Task 先写测试验证失败，再写实现让它通过。

**Tech Stack:** TypeScript, Bun test, Zod v4, `packages/workflow-engine/` 现有代码库

---

## 文件结构

```
packages/workflow-engine/src/
├── plugins/                          # 新建目录
│   ├── types.ts                      # CustomNode, InputDef, ExecuteContext
│   ├── registry.ts                   # CustomNodeRegistry
│   ├── custom-executor.ts            # CustomNodeExecutor
│   └── __tests__/
│       ├── registry.test.ts          # CustomNodeRegistry 测试
│       └── custom-executor.test.ts   # CustomNodeExecutor 测试
├── types/
│   └── dag.ts                        # 修改: NodeType + CustomNodeDef
├── parser/
│   └── yaml-parser.ts                # 修改: ParseOptions + case "custom"
│   └── dag-validator.ts              # 修改: custom 节点 DAG 校验
├── engine/
│   └── workflow-engine.ts            # 修改: WorkflowEngineOptions + buildRegistry
├── index.ts                          # 修改: 导出新增类型
└── __tests__/
    └── parser/
        └── yaml-parser.test.ts       # 修改: custom 节点解析测试
    └── engine/
        └── workflow-engine.test.ts   # 修改: custom 节点端到端测试
```

---

### Task 1: 新增 `plugins/types.ts` — 核心接口定义

**Files:**
- Create: `packages/workflow-engine/src/plugins/types.ts`

- [ ] **Step 1: 创建 `plugins/types.ts`**

```typescript
/**
 * 自定义节点插件系统 — 核心类型定义。
 *
 * 定义 CustomNode（工具合约）、InputDef（输入声明）、ExecuteContext（运行时上下文）。
 * 这些类型被 CustomNodeRegistry 和 CustomNodeExecutor 共同依赖。
 */

import type { z } from "zod/v4";
import type { StorageAdapter } from "../storage/storage-adapter";
import type { NodeOutput } from "../types/execution";

/** 输入字段声明 */
export interface InputDef {
  /** 字段类型，前端据此渲染 input handle */
  type: "string" | "number" | "boolean" | "file" | "file-list";
  /** 是否必填，默认 true */
  required?: boolean;
  /** 字段描述，前端 tooltip */
  description: string;
  /** Zod 校验 schema。引擎在 inputs 表达式求值后、execute() 调用前执行校验 */
  validate?: z.ZodType;
}

/** 自定义节点插件接口 — 所有工具的基类 */
export interface CustomNode {
  /** 工具唯一名称，YAML 中通过 tool 字段引用 */
  name: string;

  /** 工具描述，前端卡片展示 + tooltip */
  description: string;

  /** 输入字段声明 */
  inputs: Record<string, InputDef>;

  /** 输出字段名列表。具体的文件路径 pattern 在 YAML 的 CustomNodeDef.outputs 中声明 */
  produces: string[];

  /** 核心执行方法。引擎可能在 foreach 场景下调多次，每次处理一个迭代单元 */
  execute(ctx: ExecuteContext): Promise<NodeOutput>;

  /**
   * 清理钩子（可选）。execute() 之后必定调用，无论成功失败。
   * 用于清理临时文件、释放远程连接等。
   * 结果和错误可能同时为 null（execute 抛非预期异常时）。
   */
  onCleanup?(ctx: ExecuteContext, result: NodeOutput | null, error: Error | null): Promise<void>;
}

/** 执行上下文 — 引擎传递给每个 custom node 的运行时信息 */
export interface ExecuteContext {
  /** 已求值的输入值，key 对应 CustomNode.inputs 的 key */
  inputs: Record<string, unknown>;

  /** 工作流级 params */
  params: Record<string, unknown>;

  /** 工作流级 secrets */
  secrets: Record<string, string>;

  /** 工作目录根路径 */
  workDir: string;

  /** 取消信号，引擎 cancel 时 AbortController.abort() */
  signal: AbortSignal;

  /** 存储适配器（写事件/输出） */
  storage: StorageAdapter;

  /** 运行 ID */
  runId: string;

  /** 节点 ID */
  nodeId: string;

  /**
   * foreach 迭代上下文。
   * 非 Map 节点为 null。Map 节点引擎自动展开，每次 execute() 注入当前迭代元素。
   */
  foreach?: {
    item: Record<string, unknown>;
    index: number;
  };
}
```

- [ ] **Step 2: 运行 tsc 验证类型编译通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit -p packages/workflow-engine/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/plugins/types.ts
git commit -m "feat(workflow-engine): add custom node plugin types (CustomNode, InputDef, ExecuteContext)"
```

---

### Task 2: 修改 `types/dag.ts` — 新增 `CustomNodeDef` + 扩展 `NodeType`/`NodeDef`

**Files:**
- Modify: `packages/workflow-engine/src/types/dag.ts`

- [ ] **Step 1: 在 `dag.ts` 中扩展 `NodeType`，新增 `CustomNodeDef`，更新 `NodeDef` 联合体**

在 `dag.ts` 中做以下修改：

1. `NodeType` 加 `"custom"`（第 18 行）:

```typescript
export type NodeType = "shell" | "python" | "agent" | "api" | "audit" | "workflow" | "loop" | "transform" | "custom";
```

2. 在 `TransformNodeDef` 之后（第 108 行后）新增 `CustomNodeDef` 接口:

```typescript
/** Custom 节点 — 动态注册的用户自定义工具 */
export interface CustomNodeDef extends BaseNodeDef {
  type: "custom";
  /** 对应 CustomNode.name，解析时从 CustomNodeRegistry 查找 */
  tool: string;
  /**
   * 输入绑定。key 对应 CustomNode.inputs 的 key，value 为表达式字符串。
   * 引擎在运行时通过 resolveInputs() 求值。
   */
  inputs?: Record<string, string>;
  /**
   * 输出声明。key 对应 CustomNode.produces 的元素，
   * value 为 { pattern: 路径模板（支持 ${{ }}）, type: "file" | "file-list" | "dir" }。
   */
  outputs: Record<string, {
    pattern: string;
    type: "file" | "file-list" | "dir";
  }>;
  /** 迭代数据源表达式，引擎自动展开为 N 个子任务 */
  foreach?: string;
  /** 最大并发子任务数 */
  maxConcurrent?: number;
  /** 子任务失败是否继续，默认 false → 任一失败则整节点 FAILED */
  continueOnError?: boolean;
}
```

3. 在 `NodeDef` 联合体（第 111 行）加 `| CustomNodeDef`:

```typescript
export type NodeDef =
  | ShellNodeDef
  | PythonNodeDef
  | AgentNodeDef
  | ApiNodeDef
  | AuditNodeDef
  | SubWorkflowNodeDef
  | LoopNodeDef
  | TransformNodeDef
  | CustomNodeDef;
```

- [ ] **Step 2: 运行 tsc 验证类型编译通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit -p packages/workflow-engine/tsconfig.json
```

预期: 编译通过（现有 switch case 对 `NodeDef` 的 exhaustive check 可能报需要处理 `custom` case，如果报错则 Task 3-5 会逐步解决）。

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/types/dag.ts
git commit -m "feat(workflow-engine): add CustomNodeDef type and extend NodeType with 'custom'"
```

---

### Task 3: 修改 `parser/yaml-parser.ts` — 解析 `type: "custom"`

**Files:**
- Modify: `packages/workflow-engine/src/parser/yaml-parser.ts`
- Modify: `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts`

- [ ] **Step 1: 写测试 — 解析 custom 节点**

在 `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts` 末尾追加:

```typescript
import type { CustomNode } from "../../plugins/types";
import { CustomNodeRegistry } from "../../plugins/registry";

// ── custom 节点解析测试 ──

/** 创建一个最小 fake CustomNodeRegistry 用于测试 */
function createFakeRegistry(tools: Array<{ name: string; produces: string[] }>): CustomNodeRegistry {
  const registry = new CustomNodeRegistry();
  for (const t of tools) {
    registry.register({
      name: t.name,
      description: `Fake ${t.name}`,
      inputs: {},
      produces: t.produces,
      execute: async () => ({ stdout: "ok", exit_code: 0 }),
    } as CustomNode);
  }
  return registry;
}

// 解析带 tool 的 custom 节点
test("解析 custom 节点", () => {
  const registry = createFakeRegistry([{ name: "trim_galore", produces: ["trimmed_r1", "trimmed_r2"] }]);
  const def = parseWorkflowYaml(`\
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
`, undefined, { customRegistry: registry });
  expect(def.nodes[0].type).toBe("custom");
  if (def.nodes[0].type === "custom") {
    expect(def.nodes[0].tool).toBe("trim_galore");
    expect(def.nodes[0].outputs).toEqual({
      trimmed_r1: { pattern: "/tmp/${{ foreach.item.id }}_1.fq.gz", type: "file" },
      trimmed_r2: { pattern: "/tmp/${{ foreach.item.id }}_2.fq.gz", type: "file" },
    });
  }
});

// custom 节点缺少 tool 字段报错
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
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("tool");
  }
});

// custom 节点 tool 未注册时报错
test("custom 节点 tool 未注册时报错", () => {
  const registry = createFakeRegistry([]);
  try {
    parseWorkflowYaml(`\
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
`, undefined, { customRegistry: registry });
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("not registered");
  }
});

// custom 节点缺少 outputs 报错
test("custom 节点缺少 outputs 报错", () => {
  const registry = createFakeRegistry([{ name: "trim_galore", produces: ["out"] }]);
  try {
    parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: bad
    type: custom
    tool: trim_galore
`, undefined, { customRegistry: registry });
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_YAML);
    expect((e as WorkflowError).message).toContain("outputs");
  }
});

// custom 节点解析可选字段（foreach / maxConcurrent / continueOnError / inputs）
test("custom 节点解析可选字段", () => {
  const registry = createFakeRegistry([{ name: "my_tool", produces: ["out"] }]);
  const def = parseWorkflowYaml(`\
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
`, undefined, { customRegistry: registry });
  expect(def.nodes[0].type).toBe("custom");
  if (def.nodes[0].type === "custom") {
    expect(def.nodes[0].foreach).toBe("${{ params.samples }}");
    expect(def.nodes[0].maxConcurrent).toBe(3);
    expect(def.nodes[0].continueOnError).toBe(true);
    expect(def.nodes[0].inputs).toEqual({ r1: "${{ foreach.item.r1 }}" });
  }
});

// 无 registry 时 custom 节点不校验 tool（向后兼容）
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
```

- [ ] **Step 2: 运行测试 — 预期全部 FAIL**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts
```

预期: 新增 custom 相关测试全部 FAIL（parseWorkflowYaml 尚未接受 ParseOptions 参数，VALID_NODE_TYPES 未含 "custom"）。

- [ ] **Step 3: 修改 `yaml-parser.ts`**

3a. 文件顶部新增 import:

```typescript
import type { CustomNodeRegistry } from "../plugins/registry";
```

3b. 新增 `ParseOptions` 接口（在 `VALID_NODE_TYPES` 之后）:

```typescript
/** parseWorkflowYaml 的额外选项 */
export interface ParseOptions {
  /** CustomNodeRegistry 实例，用于校验 tool 存在性 + produces 匹配 */
  customRegistry?: CustomNodeRegistry;
}
```

3c. `VALID_NODE_TYPES` 加 `"custom"`:

```typescript
const VALID_NODE_TYPES: NodeType[] = ["shell", "python", "agent", "api", "audit", "workflow", "loop", "transform", "custom"];
```

3d. `parseWorkflowYaml` 签名改为:

```typescript
export function parseWorkflowYaml(source: string, baseDir?: string, opts?: ParseOptions): WorkflowDef {
```

3e. `parseNode` 签名增加 `opts` 参数:

```typescript
function parseNode(raw: unknown, index: number, opts?: ParseOptions): NodeDef {
```

3f. `parseWorkflowYaml` 中调用 `parseNode` 时传入 `opts`:

```typescript
const nodes: NodeDef[] = raw.nodes.map((n: unknown, i: number) => parseNode(n, i, opts));
```

3g. `parseNode` 中 `switch (type)` 新增 `case "custom"`（在 `case "transform"` 之后）:

```typescript
case "custom": {
  if (!("tool" in n) || typeof n.tool !== "string" || !n.tool.trim()) {
    throw new WorkflowError(
      `nodes[${index}] (${n.id}): custom node requires 'tool'`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }
  // 校验 tool 在 CustomNodeRegistry 中存在（如果有 registry 注入）
  const registry = opts?.customRegistry;
  const toolDef = registry?.get(n.tool);
  if (registry && !toolDef) {
    throw new WorkflowError(
      `nodes[${index}] (${n.id}): custom tool '${n.tool}' not registered`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  // 校验 outputs: 必须声明，且 key 都在 toolDef.produces 中
  if (!n.outputs || !isRecord(n.outputs)) {
    throw new WorkflowError(
      `nodes[${index}] (${n.id}): custom node requires 'outputs' mapping`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  // 如果注册了 registry，校验 outputs key 是否在 produces 中
  if (toolDef) {
    const producesSet = new Set(toolDef.produces);
    for (const key of Object.keys(n.outputs as Record<string, unknown>)) {
      if (!producesSet.has(key)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): output '${key}' not declared in tool '${n.tool}' produces list [${toolDef.produces.join(", ")}]`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
    }
  }

  return {
    ...base,
    type: "custom",
    tool: n.tool as string,
    inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
    outputs: parseOutputs(n.outputs),
    foreach: typeof n.foreach === "string" ? n.foreach : undefined,
    maxConcurrent: typeof n.maxConcurrent === "number" ? n.maxConcurrent : undefined,
    continueOnError: typeof n.continueOnError === "boolean" ? n.continueOnError : undefined,
  };
}
```

3h. 新增 `parseOutputs` 辅助函数（在 `isRecord` 之后）:

```typescript
/** 解析 outputs 字段为 { pattern, type } 结构 */
function parseOutputs(raw: unknown): Record<string, { pattern: string; type: "file" | "file-list" | "dir" }> {
  if (!isRecord(raw)) return {};
  const result: Record<string, { pattern: string; type: "file" | "file-list" | "dir" }> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isRecord(val)) {
      throw new WorkflowError(`outputs.${key}: must be a mapping with 'pattern' and 'type'`, WorkflowErrorCode.INVALID_YAML);
    }
    const pattern = typeof val.pattern === "string" ? val.pattern : "";
    const type = (typeof val.type === "string" && ["file", "file-list", "dir"].includes(val.type)) ? val.type as "file" | "file-list" | "dir" : "file";
    result[key] = { pattern, type };
  }
  return result;
}
```

- [ ] **Step 4: 运行测试 — 预期全部 PASS**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/parser/yaml-parser.ts packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts
git commit -m "feat(workflow-engine): add custom node YAML parsing with tool validation"
```

---

### Task 4: 新增 `plugins/registry.ts` — `CustomNodeRegistry`

**Files:**
- Create: `packages/workflow-engine/src/plugins/registry.ts`
- Create: `packages/workflow-engine/src/plugins/__tests__/registry.test.ts`

- [ ] **Step 1: 写测试 — `CustomNodeRegistry`**

创建 `packages/workflow-engine/src/plugins/__tests__/registry.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { CustomNodeRegistry } from "../registry";
import type { CustomNode, InputDef } from "../types";
import type { NodeOutput } from "../../types/execution";

/** 创建一个最小 fake CustomNode 用于测试 */
function createFakeTool(name: string, produces: string[] = ["out"]): CustomNode {
  return {
    name,
    description: `Fake tool: ${name}`,
    inputs: {
      input1: { type: "string", required: true, description: "An input" } as InputDef,
    },
    produces,
    execute: async () => ({ stdout: `${name} done`, exit_code: 0 } as NodeOutput),
  };
}

// register + get + list 基本流程
test("register 后 get 可查到工具", () => {
  const registry = new CustomNodeRegistry();
  const tool = createFakeTool("my_tool");
  registry.register(tool);
  expect(registry.get("my_tool")).toBe(tool);
  expect(registry.get("nonexistent")).toBeUndefined();
});

// list 返回工具描述
test("list 返回所有已注册工具", () => {
  const registry = new CustomNodeRegistry();
  registry.register(createFakeTool("tool_a", ["a1", "a2"]));
  registry.register(createFakeTool("tool_b", ["b1"]));
  const list = registry.list();
  expect(list).toHaveLength(2);
  expect(list.map(t => t.name).sort()).toEqual(["tool_a", "tool_b"]);
  expect(list[0].inputs).toBeDefined();
  expect(list[0].produces).toBeDefined();
});

// 重复注册同名工具抛错
test("重复注册同名工具时抛 Error", () => {
  const registry = new CustomNodeRegistry();
  registry.register(createFakeTool("dup"));
  expect(() => registry.register(createFakeTool("dup"))).toThrow(/already registered/);
});

// discover 扫描测试目录
test("discover 扫描 tools/ 目录并注册工具", async () => {
  // 创建一个临时 tools 目录
  const tmpDir = `/tmp/custom-tools-test-${Date.now()}`;
  await Bun.write(`${tmpDir}/echo_tool.ts`, `
export default class EchoTool {
  name = "echo_tool";
  description = "A test echo tool";
  inputs = {};
  produces = ["output"];
  async execute(ctx) {
    return { stdout: "echo: " + JSON.stringify(ctx.inputs), exit_code: 0 };
  }
}
`);

  try {
    const registry = await CustomNodeRegistry.discover(tmpDir);
    const tool = registry.get("echo_tool");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("echo_tool");
    expect(tool!.description).toBe("A test echo tool");
  } finally {
    // 清理
    await Bun.$`rm -rf ${tmpDir}`;
  }
});

// discover 跳过无效工具文件（无 execute 方法）
test("discover 跳过不含 execute 的导出", async () => {
  const tmpDir = `/tmp/custom-tools-test-${Date.now()}`;
  await Bun.write(`${tmpDir}/bad_tool.ts`, `
export default class BadTool {
  name = "bad";
  description = "bad";
  inputs = {};
  produces = [];
}
`);

  try {
    const registry = await CustomNodeRegistry.discover(tmpDir);
    expect(registry.get("bad")).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  } finally {
    await Bun.$`rm -rf ${tmpDir}`;
  }
});
```

- [ ] **Step 2: 运行测试 — 预期全部 FAIL**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/plugins/__tests__/registry.test.ts
```

预期: FAIL — `CustomNodeRegistry` 尚未创建。

- [ ] **Step 3: 创建 `plugins/registry.ts`**

```typescript
/**
 * CustomNodeRegistry — 自定义工具注册表。
 *
 * 全局单例，服务启动时调用 discover() 扫描 tools/ 目录一次。
 * per-run 复用同一实例，不热加载、不存 DB。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CustomNode, InputDef } from "./types";

export class CustomNodeRegistry {
  private tools: Map<string, CustomNode> = new Map();

  /** 启动时扫描 tools/ 目录，实例化所有工具 */
  static async discover(toolsDir: string): Promise<CustomNodeRegistry> {
    const registry = new CustomNodeRegistry();

    if (!fs.existsSync(toolsDir) || !fs.statSync(toolsDir).isDirectory()) {
      console.warn(`[CustomNodeRegistry] tools directory not found: ${toolsDir}`);
      return registry;
    }

    const entries = fs.readdirSync(toolsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;

      const fullPath = path.resolve(toolsDir, entry);
      try {
        // dynamic import 加载 TS 文件
        const module = await import(fullPath);
        const ToolClass = module.default;

        if (typeof ToolClass !== "function") {
          console.warn(`[CustomNodeRegistry] skipping ${entry}: default export is not a class`);
          continue;
        }

        const instance = new ToolClass();

        // 校验实例是否符合 CustomNode 接口
        if (!instance.name || typeof instance.name !== "string") {
          console.warn(`[CustomNodeRegistry] skipping ${entry}: missing 'name' property`);
          continue;
        }
        if (typeof instance.execute !== "function") {
          console.warn(`[CustomNodeRegistry] skipping ${entry}: missing 'execute' method`);
          continue;
        }

        registry.register(instance);
        console.log(`[CustomNodeRegistry] registered tool: ${instance.name} (from ${entry})`);
      } catch (err) {
        console.warn(`[CustomNodeRegistry] failed to load ${entry}:`, err);
      }
    }

    return registry;
  }

  /** 按名称查找工具 */
  get(name: string): CustomNode | undefined {
    return this.tools.get(name);
  }

  /** 列出所有已注册工具（供前端 API） */
  list(): Array<{ name: string; description: string; inputs: Record<string, InputDef>; produces: string[] }> {
    const result: Array<{ name: string; description: string; inputs: Record<string, InputDef>; produces: string[] }> = [];
    for (const tool of this.tools.values()) {
      result.push({
        name: tool.name,
        description: tool.description,
        inputs: tool.inputs,
        produces: tool.produces,
      });
    }
    return result;
  }

  /** 手动注册一个工具（测试用，重复注册抛 Error） */
  register(tool: CustomNode): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[CustomNodeRegistry] tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }
}
```

- [ ] **Step 4: 运行测试 — 预期全部 PASS**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/plugins/__tests__/registry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/plugins/registry.ts packages/workflow-engine/src/plugins/__tests__/registry.test.ts
git commit -m "feat(workflow-engine): add CustomNodeRegistry with discover/register/get/list"
```

---

### Task 5: 新增 `plugins/custom-executor.ts` — `CustomNodeExecutor`

**Files:**
- Create: `packages/workflow-engine/src/plugins/custom-executor.ts`
- Create: `packages/workflow-engine/src/plugins/__tests__/custom-executor.test.ts`

- [ ] **Step 1: 写测试 — `CustomNodeExecutor`**

创建 `packages/workflow-engine/src/plugins/__tests__/custom-executor.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { CustomNodeExecutor } from "../custom-executor";
import { CustomNodeRegistry } from "../registry";
import type { CustomNode, ExecuteContext } from "../types";
import type { NodeOutput } from "../../types/execution";
import { WorkflowError } from "../../types/errors";
import type { StorageAdapter } from "../../storage/storage-adapter";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import { z } from "zod/v4";

/** 创建最小 ExecuteContext */
function createTestCtx(overrides?: Partial<ExecuteContext>): ExecuteContext {
  const storage = createInMemoryStorage();
  return {
    inputs: {},
    params: {},
    secrets: {},
    workDir: "/tmp/test",
    signal: new AbortController().signal,
    storage,
    runId: "run_test",
    nodeId: "node_test",
    ...overrides,
  };
}

// 正常执行: execute 返回 NodeOutput
test("正常执行返回 NodeOutput", async () => {
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "echo_tool",
    description: "echo",
    inputs: {},
    produces: ["out"],
    execute: async () => ({ stdout: "hello", exit_code: 0 }),
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  const result = await executor.execute(
    { type: "custom", tool: "echo_tool", id: "n1", outputs: { out: { pattern: "/tmp/x", type: "file" } } } as any,
    createTestCtx(),
  );
  expect(result.stdout).toBe("hello");
  expect(result.exit_code).toBe(0);
});

// tool 未注册时抛 WorkflowError
test("tool 未注册时抛 WorkflowError", async () => {
  const registry = new CustomNodeRegistry();
  const executor = new CustomNodeExecutor(registry);
  await expect(
    executor.execute(
      { type: "custom", tool: "nonexistent", id: "n1", outputs: {} } as any,
      createTestCtx(),
    ),
  ).rejects.toThrow(WorkflowError);
});

// execute 失败后 onCleanup 仍被调用
test("execute 失败后 onCleanup 仍被调用", async () => {
  let cleanupCalled = false;
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "failing_tool",
    description: "fails",
    inputs: {},
    produces: [],
    execute: async () => { throw new Error("boom"); },
    onCleanup: async () => { cleanupCalled = true; },
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  await expect(
    executor.execute(
      { type: "custom", tool: "failing_tool", id: "n1", outputs: {} } as any,
      createTestCtx(),
    ),
  ).rejects.toThrow("boom");
  expect(cleanupCalled).toBe(true);
});

// execute 成功时 onCleanup 也被调用
test("execute 成功时 onCleanup 也被调用", async () => {
  let cleanupCalled = false;
  let cleanupResult: NodeOutput | null = null;
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "clean_tool",
    description: "clean",
    inputs: {},
    produces: [],
    execute: async () => ({ stdout: "ok", exit_code: 0 }),
    onCleanup: async (ctx, result) => { cleanupCalled = true; cleanupResult = result; },
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  const result = await executor.execute(
    { type: "custom", tool: "clean_tool", id: "n1", outputs: {} } as any,
    createTestCtx(),
  );
  expect(cleanupCalled).toBe(true);
  expect(cleanupResult?.stdout).toBe("ok");
});

// Zod 校验失败时抛 WorkflowError
test("Zod 校验失败时抛 WorkflowError", async () => {
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "validated_tool",
    description: "validated",
    inputs: {
      age: { type: "number", required: true, description: "Age", validate: z.number().min(18) },
    },
    produces: [],
    execute: async () => ({ stdout: "ok", exit_code: 0 }),
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  await expect(
    executor.execute(
      { type: "custom", tool: "validated_tool", id: "n1", inputs: { age: "15" }, outputs: {} } as any,
      createTestCtx(),
    ),
  ).rejects.toThrow(WorkflowError);
});

// onCleanup 抛异常不影响 execute 结果
test("onCleanup 抛异常不影响 execute 结果", async () => {
  const registry = new CustomNodeRegistry();
  const tool: CustomNode = {
    name: "cleanup_fail_tool",
    description: "cleanup fails",
    inputs: {},
    produces: [],
    execute: async () => ({ stdout: "ok", exit_code: 0 }),
    onCleanup: async () => { throw new Error("cleanup boom"); },
  };
  registry.register(tool);
  const executor = new CustomNodeExecutor(registry);
  // onCleanup 异常应该被 console.error 记录但不重抛
  const result = await executor.execute(
    { type: "custom", tool: "cleanup_fail_tool", id: "n1", outputs: {} } as any,
    createTestCtx(),
  );
  expect(result.stdout).toBe("ok");
});
```

- [ ] **Step 2: 运行测试 — 预期全部 FAIL**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/plugins/__tests__/custom-executor.test.ts
```

- [ ] **Step 3: 创建 `plugins/custom-executor.ts`**

```typescript
/**
 * CustomNodeExecutor — 桥接 CustomNodeRegistry 和引擎 NodeExecutor 接口。
 *
 * 按引擎的 NodeExecutor 接口实现 execute()，内部从 registry 查找工具、
 * 校验 inputs（Zod）、构建 ExecuteContext、调用 tool.execute()、确保 onCleanup() 被调用。
 */

import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { StorageAdapter } from "../storage/storage-adapter";
import type { NodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";
import { resolveInputs } from "../parser/inputs-resolver";
import type { CustomNodeDef } from "../types/dag";
import { CustomNodeRegistry } from "./registry";
import type { ExecuteContext } from "./types";

export class CustomNodeExecutor implements NodeExecutor {
  constructor(private readonly registry: CustomNodeRegistry) {}

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    const customDef = node as CustomNodeDef;

    // 1. 从 registry 查找 tool
    const tool = this.registry.get(customDef.tool);
    if (!tool) {
      throw new WorkflowError(
        `Custom tool '${customDef.tool}' not registered`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: node.id, tool: customDef.tool },
      );
    }

    // 2. 表达式求值
    let resolvedInputs: Record<string, unknown> = {};
    if (customDef.inputs) {
      const evalCtx = {
        params: ctx.params,
        secrets: ctx.secrets,
        // 为 foreach 场景提供 foreach 变量（如果 ctx 中有相关数据）
        foreach: (ctx as any).foreachItem ?? undefined,
        nodes: (ctx as any).nodeOutputs ?? {},
      };
      // resolveInputs 返回 ResolvedInput[]，转为 Record
      const resolved = resolveInputs(customDef.inputs, evalCtx);
      for (const r of resolved) {
        resolvedInputs[r.key] = r.value;
      }
    }

    // 3. Zod 校验
    for (const [key, def] of Object.entries(tool.inputs)) {
      const value = resolvedInputs[key];
      // 必填校验
      if (def.required !== false && (value === undefined || value === null)) {
        throw new WorkflowError(
          `Custom tool '${tool.name}' requires input '${key}'`,
          WorkflowErrorCode.NODE_FAILED,
          { node_id: node.id, tool: tool.name, input_key: key },
        );
      }
      // Zod schema 校验
      if (def.validate && value !== undefined) {
        try {
          def.validate.parse(value);
        } catch (err) {
          throw new WorkflowError(
            `Custom tool '${tool.name}' input '${key}' validation failed: ${(err as Error).message}`,
            WorkflowErrorCode.NODE_FAILED,
            { node_id: node.id, tool: tool.name, input_key: key },
          );
        }
      }
    }

    // 4. 构建 ExecuteContext
    const execCtx: ExecuteContext = {
      inputs: resolvedInputs,
      params: ctx.params,
      secrets: ctx.secrets,
      // workDir 从 params 推导，默认使用临时目录
      workDir: (ctx.params.work_dir as string) ?? "/tmp/workflow",
      signal: ctx.signal,
      storage: ctx.storage,
      runId: ctx.runId,
      nodeId: node.id,
    };

    // 5. 调用 tool.execute(ctx)
    let result: NodeOutput | null = null;
    let error: Error | null = null;
    try {
      result = await tool.execute(execCtx);
      return result;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      // 包装为 WorkflowError 以便引擎统一处理
      if (error instanceof WorkflowError) {
        throw error;
      }
      throw new WorkflowError(
        `Custom tool '${tool.name}' execution failed: ${error.message}`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: node.id, tool: tool.name, cause: error },
      );
    } finally {
      // 6. 确保 onCleanup 被调用
      if (tool.onCleanup) {
        try {
          await tool.onCleanup(execCtx, result, error);
        } catch (cleanupErr) {
          console.error(
            `[CustomNodeExecutor] onCleanup failed for tool '${tool.name}':`,
            cleanupErr,
          );
        }
      }
    }
  }
}
```

- [ ] **Step 4: 运行测试 — 预期全部 PASS**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/plugins/__tests__/custom-executor.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/plugins/custom-executor.ts packages/workflow-engine/src/plugins/__tests__/custom-executor.test.ts
git commit -m "feat(workflow-engine): add CustomNodeExecutor with Zod validation and cleanup hook"
```

---

### Task 6: 修改 `engine/workflow-engine.ts` — 注册 custom executor + 注入 registry

**Files:**
- Modify: `packages/workflow-engine/src/engine/workflow-engine.ts`
- Modify: `packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts`

- [ ] **Step 1: 写集成测试 — 通过引擎运行 custom 节点**

在 `packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts` 末尾追加:

```typescript
import { CustomNodeRegistry } from "../../plugins/registry";
import type { CustomNode } from "../../plugins/types";

// ── custom 节点集成测试 ──

/** 构建带 customRegistry 的测试引擎 */
function createTestEngineWithCustom(tools: CustomNode[]) {
  const registry = new CustomNodeRegistry();
  for (const t of tools) registry.register(t);
  return createTestEngine({ customRegistry: registry });
}

// 通过引擎 run custom 节点（最小工具: echo）
test("引擎运行 custom 节点", async () => {
  const tool: CustomNode = {
    name: "simple_echo",
    description: "Echo tool",
    inputs: {},
    produces: [],
    execute: async () => ({ stdout: "echo from custom", exit_code: 0 }),
  };
  const engine = createTestEngineWithCustom([tool]);
  const yaml = `
name: custom-test
schema_version: "1"
nodes:
  - id: c1
    type: custom
    tool: simple_echo
    outputs:
      out:
        pattern: /tmp/x.txt
        type: file
`;
  const result = await engine.run(yaml);
  expect(result.status).toBe("SUCCESS");
  expect(result.summary.node_summary.total).toBe(1);
  expect(result.summary.node_summary.completed).toBe(1);
});

// custom 节点 tool 未注册时 run 应失败
test("custom 节点 tool 未注册时 run 失败", async () => {
  const engine = createTestEngineWithCustom([]);
  const yaml = `
name: custom-test
schema_version: "1"
nodes:
  - id: c1
    type: custom
    tool: nonexistent
    outputs:
      out:
        pattern: /tmp/x.txt
        type: file
`;
  await expect(engine.run(yaml)).rejects.toThrow(/not registered/);
});
```

- [ ] **Step 2: 运行测试 — 预期 FAIL**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts
```

- [ ] **Step 3: 修改 `workflow-engine.ts`**

3a. 顶部新增 import:

```typescript
import { CustomNodeExecutor } from "../plugins/custom-executor";
import type { CustomNodeRegistry } from "../plugins/registry";
```

3b. `WorkflowEngineOptions` 新增字段（在 `defaultCwd` 之后）:

```typescript
export interface WorkflowEngineOptions {
  storage: StorageAdapter;
  transport?: Transport;
  hmacSecret: string;
  envFile?: string;
  defaultCwd?: string;
  /** 自定义工具注册表（由服务启动时创建并注入） */
  customRegistry?: CustomNodeRegistry;
}
```

3c. `buildRegistry` 中注册 custom executor（在 `return registry;` 之前）:

```typescript
function buildRegistry(runId: string, baseDir: string): NodeExecutorRegistry {
  const registry = new NodeExecutorRegistry();
  registry.register("shell", new ProcessExecutor());
  registry.register("python", new PythonExecutor());
  registry.register("api", new ApiExecutor());
  if (transport) {
    registry.register("agent", new AgentExecutor(transport));
  }
  registry.register("audit", new AuditExecutor(hmacSecret));
  registry.register("workflow", new SubWorkflowExecutor(runId, registry, baseDir));
  registry.register("loop", new LoopExecutor(runId, registry));
  registry.register("transform", new TransformExecutor());
  // 注册 custom executor（如果有 registry 注入）
  if (options.customRegistry) {
    registry.register("custom", new CustomNodeExecutor(options.customRegistry));
  }
  return registry;
}
```

3d. `parse()` 中传递 `ParseOptions`:

```typescript
function parse(yaml: string, baseDir?: string): WorkflowDef {
  return parseWorkflowYaml(yaml, baseDir, { customRegistry: options.customRegistry });
}
```

3e. 同理，`prepareRun` / `runAsync` / `recover` / `rerunFrom` 中调用 `parse()` 的地方不变（`parse` 内部已处理）。

- [ ] **Step 4: 运行测试 — 预期全部 PASS**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/engine/workflow-engine.ts packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts
git commit -m "feat(workflow-engine): register CustomNodeExecutor in buildRegistry with customRegistry injection"
```

---

### Task 7: 修改 `parser/dag-validator.ts` — custom 节点 DAG 校验

**Files:**
- Modify: `packages/workflow-engine/src/parser/dag-validator.ts`

- [ ] **Step 1: 在 `validateDAG` 中新增 custom 节点校验规则**

在 `validateDAG` 函数中，在 inputs 引用校验之后（第 125 行后）新增 custom 节点 outputs 校验:

```typescript
// 7. custom 节点 outputs 校验: outputs key 必须在对应 tool 的 produces 中
// 注意: 此处无法访问 CustomNodeRegistry，因此仅做结构性校验。
// tool → produces 的匹配已在 yaml-parser 中完成（ParseOptions.customRegistry）。
// 此处仅校验 outputs 字段存在且格式正确。
for (const node of def.nodes) {
  if (node.type !== "custom") continue;
  const customDef = node as import("../types/dag").CustomNodeDef;
  // 校验 outputs 非空
  if (!customDef.outputs || Object.keys(customDef.outputs).length === 0) {
    issues.push({
      type: "warning",
      code: "CUSTOM_NO_OUTPUTS",
      message: `Custom node '${node.id}' has no outputs declared — downstream nodes cannot reference its results`,
      nodeId: node.id,
    });
  }
  // 校验 foreach 引用合法性（如果声明了 foreach）
  if (customDef.foreach) {
    const refs = new Set<string>();
    extractNodeIdFromExpr(customDef.foreach, refs);
    // foreach 通常引用 params，不是 nodes 引用，所以这里只做存在性检查
    // 实际变量解析在运行时进行
  }
}
```

- [ ] **Step 2: 运行现有所有测试确认未破坏**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/dag-validator.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/parser/dag-validator.ts
git commit -m "feat(workflow-engine): add DAG validation rules for custom nodes"
```

---

### Task 8: 修改 `index.ts` — 导出新增类型

**Files:**
- Modify: `packages/workflow-engine/src/index.ts`

- [ ] **Step 1: 在 `index.ts` 中新增导出**

在现有导出的 `CustomNodeDef` 类型位置（dag 类型导出区域）新增:

```typescript
// 在 dag 类型导出区域追加 CustomNodeDef:
export type {
  // ... 现有 ...
  CustomNodeDef,
} from "./types/dag";

// 新增 plugins 导出:
export type { CustomNode, ExecuteContext, InputDef } from "./plugins/types";
export { CustomNodeRegistry } from "./plugins/registry";
export { CustomNodeExecutor } from "./plugins/custom-executor";
export type { ParseOptions } from "./parser/yaml-parser";
```

具体修改: 在 `index.ts` 的 dag 类型导出中 `TransformNodeDef` 之后加 `CustomNodeDef`；在文件末尾新增 plugins 导出区。

- [ ] **Step 2: 运行 tsc 验证导出正确**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit -p packages/workflow-engine/tsconfig.json
```

- [ ] **Step 3: 运行全部测试确保无回归**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/
```

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/index.ts
git commit -m "feat(workflow-engine): export CustomNode types, registry, and executor from index"
```

---

### Task 9: 最终验证 — 全量测试 + precheck

- [ ] **Step 1: 运行 workflow-engine 全部测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/
```

预期: 全部 PASS（含新增测试 + 已有测试无回归）。

- [ ] **Step 2: 运行 precheck**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

预期: biome format / organize imports / tsc / biome lint 全部通过。

- [ ] **Step 3: Commit（如有 precheck 自动修复的格式变更）**

```bash
git add -u && git commit -m "chore(workflow-engine): precheck fixes for custom node plugin"
```

---
