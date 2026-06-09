# Transform 节点实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 workflow 引擎新增 `transform` 节点类型，支持纯内存 JSON 变换——通过 JS 表达式将上游输出重塑为下游所需格式。

**Architecture:** 新增 `TransformNodeDef` 类型定义 + `TransformExecutor` 执行器，复用现有 `resolveInputs()` 解析上游数据，对 `output` 字段中的每个 JS 表达式通过 `new Function()` 求值，结果拼装为 JSON 对象返回。前端沿用现有 `WorkflowNode` 组件和 `NodeConfigCard` 配置模式。

**Tech Stack:** TypeScript (Bun), React 19 (@xyflow/react), i18next

---

### Task 1: TransformNodeDef 类型定义

**Files:**
- Modify: `packages/workflow-engine/src/types/dag.ts`

- [ ] **Step 1: 在 NodeType 联合类型中加入 "transform"**

找到第 18 行：

```typescript
export type NodeType = "shell" | "python" | "agent" | "api" | "audit" | "workflow" | "loop";
```

改为：

```typescript
export type NodeType = "shell" | "python" | "agent" | "api" | "audit" | "workflow" | "loop" | "transform";
```

- [ ] **Step 2: 在 LoopNodeDef 之后（约第 99 行之后）新增 TransformNodeDef 接口**

```typescript
/** Transform 节点 — 纯内存 JSON 变换，通过 JS 表达式重塑上游数据 */
export interface TransformNodeDef extends BaseNodeDef {
  type: "transform";
  /** 从上游拉取的数据，key 为变量名，value 为表达式（如 nodes.X.output） */
  inputs?: Record<string, string>;
  /** 输出结构，key 为字段名，value 为 JavaScript 表达式，表达式作用域包含 inputs 变量 + params + secrets */
  output: Record<string, string>;
}
```

- [ ] **Step 3: 在 NodeDef 判别联合中加入 TransformNodeDef**

找到第 102-109 行的 `NodeDef`：

```typescript
export type NodeDef =
  | ShellNodeDef
  | PythonNodeDef
  | AgentNodeDef
  | ApiNodeDef
  | AuditNodeDef
  | SubWorkflowNodeDef
  | LoopNodeDef;
```

改为：

```typescript
export type NodeDef =
  | ShellNodeDef
  | PythonNodeDef
  | AgentNodeDef
  | ApiNodeDef
  | AuditNodeDef
  | SubWorkflowNodeDef
  | LoopNodeDef
  | TransformNodeDef;
```

- [ ] **Step 4: 验证类型编译**

```bash
cd packages/workflow-engine && bun run tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/types/dag.ts
git commit -m "feat(workflow): add TransformNodeDef type definition"
```

---

### Task 2: YAML 解析器支持 transform

**Files:**
- Modify: `packages/workflow-engine/src/parser/yaml-parser.ts`

- [ ] **Step 1: VALID_NODE_TYPES 加入 "transform"**

找到第 12 行：

```typescript
const VALID_NODE_TYPES: NodeType[] = ["shell", "python", "agent", "api", "audit", "workflow", "loop"];
```

改为：

```typescript
const VALID_NODE_TYPES: NodeType[] = ["shell", "python", "agent", "api", "audit", "workflow", "loop", "transform"];
```

- [ ] **Step 2: switch 语句中增加 transform 分支**

在 `parseNode()` 函数的 switch 语句 `case "loop":` 分支之后（第 239 行 `}` 之前），插入：

```typescript
case "transform": {
  if (!("output" in n) || !isRecord(n.output) || Object.keys(n.output as Record<string, unknown>).length === 0) {
    throw new WorkflowError(
      `nodes[${index}] (${n.id}): transform node requires non-empty 'output' mapping`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }
  return {
    ...base,
    type: "transform",
    inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
    output: n.output as Record<string, string>,
  };
}
```

- [ ] **Step 3: 验证编译**

```bash
cd packages/workflow-engine && bun run tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/parser/yaml-parser.ts
git commit -m "feat(workflow): add transform node YAML parsing support"
```

---

### Task 3: DAG 校验器 inputs 引用校验支持

**Files:**
- Modify: `packages/workflow-engine/src/parser/dag-validator.ts`

- [ ] **Step 1: 将 transform 加入 inputs 引用校验**

找到第 103 行：

```typescript
if (node.type !== "shell" && node.type !== "python") continue;
```

改为：

```typescript
if (node.type !== "shell" && node.type !== "python" && node.type !== "transform") continue;
```

- [ ] **Step 2: 将 inputs 提取逻辑兼容 transform 节点类型**

找到第 104 行：

```typescript
const inputs = (node as import("../types/dag").ShellNodeDef).inputs;
```

改为：

```typescript
const inputs = (
  node.type === "transform"
    ? (node as import("../types/dag").TransformNodeDef).inputs
    : (node as import("../types/dag").ShellNodeDef).inputs
);
```

- [ ] **Step 3: 验证编译**

```bash
cd packages/workflow-engine && bun run tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/parser/dag-validator.ts
git commit -m "feat(workflow): add transform node inputs validation to DAG validator"
```

---

### Task 4: TransformExecutor 实现

**Files:**
- Create: `packages/workflow-engine/src/executor/transform-executor.ts`

- [ ] **Step 1: 创建 TransformExecutor**

```typescript
/**
 * Transform 节点执行器 — 纯内存 JSON 变换。
 *
 * 职责：
 * - 从 ctx.resolvedInputs 获取已解析的 inputs（通过 resolveInputs 解析的表达式值）
 * - 构建作用域对象：inputs 变量 + params + secrets
 * - 对 output 中每个 key 的 JS 表达式通过 new Function() 求值
 * - 组装结果为 JSON 对象，stdout 为 JSON.stringify(result)
 * - 任一表达式失败 → 整节点失败
 */

import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { TransformNodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";

/** Transform 节点执行器 */
export class TransformExecutor implements NodeExecutor {
  async execute(node: import("../types/dag").NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== "transform") {
      throw new WorkflowError(
        `TransformExecutor only handles 'transform' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const transformNode = node as TransformNodeDef;

    // 从 resolvedInputs 提取 inputs 变量值（resolveInputs 返回 { key: { value, rawExpression } }）
    const resolvedInputVars: Record<string, unknown> = {};
    const rawInputs = ctx.resolvedInputs.inputs as Record<string, { value: unknown; rawExpression: string }> | undefined;
    if (rawInputs) {
      for (const [key, entry] of Object.entries(rawInputs)) {
        resolvedInputVars[key] = entry.value;
      }
    }

    // 构建表达式求值作用域
    const scope: Record<string, unknown> = {
      ...resolvedInputVars,
      params: ctx.params,
      secrets: ctx.secrets,
    };

    const result: Record<string, unknown> = {};

    for (const [key, expr] of Object.entries(transformNode.output)) {
      try {
        const fn = new Function(
          ...Object.keys(scope),
          `"use strict"; return (${expr})`,
        );
        result[key] = fn(...Object.values(scope));
      } catch (err) {
        throw new WorkflowError(
          `Transform expression '${key}' failed: ${(err as Error).message}`,
          WorkflowErrorCode.NODE_FAILED,
          {
            node_id: transformNode.id,
            output_key: key,
            expression: expr,
          },
        );
      }
    }

    const outputJson = JSON.stringify(result);

    return {
      stdout: outputJson,
      json: result,
      exit_code: 0,
      size: Buffer.byteLength(outputJson, "utf-8"),
    };
  }
}
```

- [ ] **Step 2: 验证编译**

```bash
cd packages/workflow-engine && bun run tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/executor/transform-executor.ts
git commit -m "feat(workflow): add TransformExecutor implementation"
```

---

### Task 5: 引擎注册 + 公开导出

**Files:**
- Modify: `packages/workflow-engine/src/engine/workflow-engine.ts`
- Modify: `packages/workflow-engine/src/index.ts`

- [ ] **Step 1: workflow-engine.ts 引入 TransformExecutor**

在文件顶部 import 区域（约第 10 行附近）：

```typescript
import { TransformExecutor } from "../executor/transform-executor";
```

- [ ] **Step 2: buildRegistry() 注册 transform**

在 `buildRegistry()` 函数中（约第 128-138 行），在 `registry.register("loop", ...)` 之后添加：

```typescript
registry.register("transform", new TransformExecutor());
```

- [ ] **Step 3: index.ts 导出 TransformNodeDef**

在 `index.ts` 第 58 行（`SubWorkflowNodeDef` 类型导出之后）添加：

```typescript
  TransformNodeDef,
```

- [ ] **Step 4: 验证编译**

```bash
cd packages/workflow-engine && bun run tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/engine/workflow-engine.ts packages/workflow-engine/src/index.ts
git commit -m "feat(workflow): register TransformExecutor in engine and export types"
```

---

### Task 6: DAG 调度器 inputs 解析支持

**Files:**
- Modify: `packages/workflow-engine/src/scheduler/dag-scheduler.ts`

- [ ] **Step 1: resolveNodeInputs() 增加 transform case**

在 `resolveNodeInputs()` 的 switch 语句（约第 406 行 `case "loop":` 之后，`}` 之前），插入：

```typescript
case "transform": {
  // Transform 节点：通过 inputs 注入上游数据，output 表达式在 executor 内求值
  if (node.inputs) {
    resolved.inputs = resolveInputs(node.inputs, evalContext);
  }
  break;
}
```

- [ ] **Step 2: 验证编译**

```bash
cd packages/workflow-engine && bun run tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/scheduler/dag-scheduler.ts
git commit -m "feat(workflow): add transform node inputs resolution in DAG scheduler"
```

---

### Task 7: TransformExecutor 单元测试

**Files:**
- Create: `packages/workflow-engine/src/__tests__/executor/transform-executor.test.ts`

- [ ] **Step 1: 写测试文件**

```typescript
/**
 * TransformExecutor 测试
 */

import { describe, expect, test } from "bun:test";
import { TransformExecutor } from "../../executor/transform-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { TransformNodeDef } from "../../types/dag";
import { WorkflowError } from "../../types/errors";

// ---------- 辅助工具 ----------

function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: "test-run-001",
    params: { minScore: 80 },
    secrets: { API_KEY: "test-key-123" },
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

function transformNode(
  output: Record<string, string>,
  overrides?: Partial<TransformNodeDef>,
): TransformNodeDef {
  return {
    id: "tf-test",
    type: "transform",
    output,
    ...overrides,
  };
}

// ========== TransformExecutor 测试 ==========

describe("TransformExecutor", () => {
  let executor: TransformExecutor;

  // 创建 executor 实例
  test("创建 TransformExecutor 实例", () => {
    executor = new TransformExecutor();
    expect(executor).toBeDefined();
  });

  // 基本字段映射
  test("基本字段映射 — 从 inputs 提取字段", async () => {
    executor = new TransformExecutor();
    const ctx = makeCtx({
      resolvedInputs: {
        inputs: {
          data: { value: { items: [{ name: "Alice", score: 95 }, { name: "Bob", score: 87 }], total: 2 }, rawExpression: "nodes.api_1.output" },
        },
      },
    });
    const node = transformNode({
      names: "data.items.map(i => i.name)",
      count: "data.total",
    });

    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.json).toEqual({ names: ["Alice", "Bob"], count: 2 });
    expect(output.stdout).toContain('"Alice"');
  });

  // 表达式访问 params
  test("表达式可访问 params", async () => {
    executor = new TransformExecutor();
    const ctx = makeCtx({
      params: { minScore: 80 },
      resolvedInputs: {
        inputs: {
          data: { value: { items: [{ name: "Alice", score: 95 }, { name: "Bob", score: 60 }] }, rawExpression: "nodes.api_1.output" },
        },
      },
    });
    const node = transformNode({
      passing: "data.items.filter(i => i.score >= params.minScore).map(i => i.name)",
    });

    const output = await executor.execute(node, ctx);

    expect(output.json).toEqual({ passing: ["Alice"] });
  });

  // 表达式访问 secrets
  test("表达式可访问 secrets", async () => {
    executor = new TransformExecutor();
    const ctx = makeCtx({
      secrets: { PREFIX: "USER_" },
      resolvedInputs: {
        inputs: {
          data: { value: { name: "Alice" }, rawExpression: "nodes.api_1.output" },
        },
      },
    });
    const node = transformNode({
      prefixed: "secrets.PREFIX + data.name",
    });

    const output = await executor.execute(node, ctx);

    expect(output.json).toEqual({ prefixed: "USER_Alice" });
  });

  // 简单计算
  test("简单计算 — reduce 求平均值", async () => {
    executor = new TransformExecutor();
    const ctx = makeCtx({
      resolvedInputs: {
        inputs: {
          data: { value: { items: [{ score: 10 }, { score: 20 }, { score: 30 }] }, rawExpression: "nodes.api_1.output" },
        },
      },
    });
    const node = transformNode({
      avg: "(data.items.reduce((s, i) => s + i.score, 0) / data.items.length).toFixed(1)",
    });

    const output = await executor.execute(node, ctx);

    expect(output.json).toEqual({ avg: "20.0" });
  });

  // 表达式失败 → 整节点失败
  test("表达式抛异常 → 整节点抛出 WorkflowError", async () => {
    executor = new TransformExecutor();
    const ctx = makeCtx({
      resolvedInputs: {
        inputs: {
          data: { value: null, rawExpression: "nodes.api_1.output" },
        },
      },
    });
    const node = transformNode({
      result: "data.items.length",
    });

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // 非 transform 节点类型 → 报错
  test("传入非 transform 节点类型 → 抛错", async () => {
    executor = new TransformExecutor();
    const ctx = makeCtx();
    const node = { id: "test", type: "shell", command: "echo" } as unknown as TransformNodeDef;

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // 无 inputs 节点（仅使用 params）
  test("无 inputs 字段 — 仅使用 params", async () => {
    executor = new TransformExecutor();
    const ctx = makeCtx({
      params: { env: "production", threshold: 100 },
    });
    const node = transformNode({
      config: "JSON.stringify({ env: params.env, threshold: params.threshold })",
    });

    const output = await executor.execute(node, ctx);

    const parsed = JSON.parse(output.stdout);
    expect(parsed.config).toBe('{"env":"production","threshold":100}');
  });
});
```

- [ ] **Step 2: 运行测试，确认全部通过**

```bash
cd packages/workflow-engine && bun test src/__tests__/executor/transform-executor.test.ts
```

Expected: 8 tests pass, 0 fail.

- [ ] **Step 3: 运行已有测试确保无回归**

```bash
cd packages/workflow-engine && bun test
```

Expected: 全部已有测试仍通过。

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/__tests__/executor/transform-executor.test.ts
git commit -m "test(workflow): add TransformExecutor unit tests"
```

---

### Task 8: 前端 API 类型更新

**Files:**
- Modify: `web/src/api/workflow-engine.ts`

- [ ] **Step 1: NodeType 联合类型加 "transform"**

找到第 14 行：

```typescript
export type NodeType = "shell" | "agent" | "api" | "audit" | "workflow" | "loop";
```

改为：

```typescript
export type NodeType = "shell" | "python" | "agent" | "api" | "audit" | "workflow" | "loop" | "transform";
```

（注：现有代码缺少 `"python"`，一并补上）

- [ ] **Step 2: Commit**

```bash
git add web/src/api/workflow-engine.ts
git commit -m "feat(web): add transform to frontend NodeType union"
```

---

### Task 9: 前端节点渲染 — nodes.tsx

**Files:**
- Modify: `web/src/pages/workflow/nodes.tsx`

- [ ] **Step 1: 引入 Shuffle 图标（作为 transform 的图标）**

在 import 区域（约第 1-16 行），在 lucide-react 导入中加入 `Shuffle`：

```typescript
import {
  ArrowRight,
  Bot,
  CheckCircle,
  Code,
  Eye,
  GitBranch,
  Globe,
  Loader,
  Play,
  RefreshCw,
  ShieldCheck,
  Shuffle,
  Terminal,
  XCircle,
} from "lucide-react";
```

- [ ] **Step 2: NODE_COLORS 添加 transform 配色**

在 `NODE_COLORS` 对象中（约第 28 行 `loop` 之后）加入：

```typescript
  transform: { main: "#f97316", light: "rgba(249,115,22,0.08)", headerText: "#fff" },
```

- [ ] **Step 3: NODE_ICONS 添加 transform 图标**

在 `NODE_ICONS` 对象中（约第 39 行 `loop` 之后）加入：

```typescript
  transform: <Shuffle size={12} />,
```

- [ ] **Step 4: NODE_LABEL_KEYS 添加 transform 标签**

在 `NODE_LABEL_KEYS` 对象中（约第 50 行 `loop` 之后）加入：

```typescript
  transform: "nodes.transform",
```

- [ ] **Step 5: getPreview() 添加 transform 预览**

在 `getPreview()` 函数的 switch 语句中（约第 100 行 `case "loop":` 之后）加入：

```typescript
    case "transform":
      return Object.keys((data.output as Record<string, unknown>) ?? {}).join(", ");
```

- [ ] **Step 6: nodeTypes 导出加 transform**

在 `nodeTypes` 对象中（约第 351 行 `loop: WorkflowNode` 之后）加入：

```typescript
  transform: WorkflowNode,
```

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/workflow/nodes.tsx
git commit -m "feat(web): add transform node rendering (color, icon, label, preview)"
```

---

### Task 10: 前端编辑器面板 — WorkflowEditor.tsx

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 在 palette icon 导入中加 Shuffle**

找到 `WorkflowEditor.tsx` 顶部 import 区域（约第 19-40 行），确保 lucide-react 导入中包含 `Shuffle`：

```typescript
import {
  Bot,
  CheckCircle,
  Code,
  Download,
  Edit3,
  Eye,
  FilePlus,
  Globe,
  LayoutGrid,
  Link,
  List,
  Lock,
  MessageSquare,
  Play,
  RefreshCw,
  Rocket,
  Save,
  ShieldCheck,
  Shuffle,
  Terminal,
  Upload,
} from "lucide-react";
```

- [ ] **Step 2: PALETTE_ITEMS 加 transform**

在 `PALETTE_ITEMS` 数组中（约第 76 行 `{ type: "audit", ... }` 之后）加入：

```typescript
  { type: "transform", labelKey: "nodes.transform", icon: Shuffle, color: "#f97316" },
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat(web): add transform to workflow editor palette"
```

---

### Task 11: 前端 YAML 工具 — yaml-utils.ts

**Files:**
- Modify: `web/src/pages/workflow/yaml-utils.ts`

- [ ] **Step 1: TYPE_PREFIXES 加 transform**

找到 `TYPE_PREFIXES` 对象（约第 196-204 行），在 `loop` 之后加入：

```typescript
  transform: "tf",
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/yaml-utils.ts
git commit -m "feat(web): add transform ID prefix to yaml-utils"
```

---

### Task 12: 前端配置表单 — NodeConfigCard.tsx

**Files:**
- Modify: `web/src/pages/workflow/components/NodeConfigCard.tsx`

- [ ] **Step 1: 类型选择器中加入 transform option**

找到 `<select>` 标签中节点类型选项（约第 63-69 行），在 `loop` option 之后加入：

```tsx
                <option value="transform">{t("nodes.transform")}</option>
```

- [ ] **Step 2: 节点配置区增加 transform 专属表单**

在 `{nodeType === "loop" && (` 区块之后（约第 362 行 `)}` 之后），加入：

```tsx
            {nodeType === "transform" && (
              <>
                <div className="wf-prop-field">
                  <label>{t("editor.transform_inputs_title")}</label>
                  <InputsEditor
                    value={sd?.inputs as Record<string, string> | undefined}
                    onChange={(val) => {
                      const cleaned: Record<string, string> = {};
                      if (val) {
                        for (const [k, v] of Object.entries(val)) {
                          if (k.trim()) cleaned[k.trim()] = v;
                        }
                      }
                      updateNodeData({ inputs: Object.keys(cleaned).length ? cleaned : undefined });
                    }}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.transform_inputs_key_placeholder")}
                    valuePlaceholder={t("editor.transform_inputs_value_placeholder")}
                    addLabel={t("editor.transform_inputs_add")}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.transform_output_title")}</label>
                  <InputsEditor
                    value={sd?.output as Record<string, string> | undefined}
                    onChange={(val) => {
                      const cleaned: Record<string, string> = {};
                      if (val) {
                        for (const [k, v] of Object.entries(val)) {
                          if (k.trim()) cleaned[k.trim()] = v;
                        }
                      }
                      updateNodeData({ output: Object.keys(cleaned).length ? cleaned : undefined });
                    }}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.transform_output_key_placeholder")}
                    valuePlaceholder={t("editor.transform_output_value_placeholder")}
                    addLabel={t("editor.transform_output_add")}
                  />
                </div>
              </>
            )}
```

（注：复用现有 `InputsEditor` 组件，因为 inputs 和 output 都只是 key-value 映射。）

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/components/NodeConfigCard.tsx
git commit -m "feat(web): add transform node config form to NodeConfigCard"
```

---

### Task 13: 前端配置表单 — NodeConfigPanel.tsx（兼容旧版）

**Files:**
- Modify: `web/src/pages/workflow/components/NodeConfigPanel.tsx`

- [ ] **Step 1: 类型选择器加 transform**

同 Task 11 Step 1，在 `<select>` 的 `loop` option 之后加 `<option value="transform">`。

- [ ] **Step 2: 节点配置区增加 transform 专属表单**

同 Task 11 Step 2。

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/components/NodeConfigPanel.tsx
git commit -m "feat(web): add transform node config form to NodeConfigPanel"
```

---

### Task 14: 前端 i18n — 英文翻译

**Files:**
- Modify: `web/src/i18n/locales/en/workflows.json`

- [ ] **Step 1: nodes 命名空间加 transform 标签**

在 `nodes` 对象中（`"loop": "Loop"` 之后）加入：

```json
    "transform": "Transform",
```

- [ ] **Step 2: editor 命名空间加 transform 配置字段**

在 `editor` 对象中（`"inputs_add": "Add Input"` 之后）加入：

```json
    "transform_inputs_title": "Inputs",
    "transform_inputs_key_placeholder": "Variable name",
    "transform_inputs_value_placeholder": "Expression (e.g. nodes.X.output)",
    "transform_inputs_add": "Add Input",
    "transform_output_title": "Output (JS expressions)",
    "transform_output_key_placeholder": "Field name",
    "transform_output_value_placeholder": "JS expression (e.g. data.items.map(i => i.name))",
    "transform_output_add": "Add Output",
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/workflows.json
git commit -m "feat(i18n): add transform node English translations"
```

---

### Task 15: 前端 i18n — 中文翻译

**Files:**
- Modify: `web/src/i18n/locales/zh/workflows.json`

- [ ] **Step 1: nodes 命名空间加 transform 标签**

在 `nodes` 对象中（`"loop": "循环"` 之后）加入：

```json
    "transform": "变换",
```

- [ ] **Step 2: editor 命名空间加 transform 配置字段**

在 `editor` 对象中（`"inputs_add": "添加输入"` 之后）加入：

```json
    "transform_inputs_title": "输入变量",
    "transform_inputs_key_placeholder": "变量名",
    "transform_inputs_value_placeholder": "表达式（如 nodes.X.output）",
    "transform_inputs_add": "添加输入",
    "transform_output_title": "输出表达式（JS）",
    "transform_output_key_placeholder": "字段名",
    "transform_output_value_placeholder": "JS 表达式（如 data.items.map(i => i.name)）",
    "transform_output_add": "添加输出",
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/zh/workflows.json
git commit -m "feat(i18n): add transform node Chinese translations"
```

---

### Task 16: 端到端验证

- [ ] **Step 1: 运行后端全部测试**

```bash
bun test src/__tests__/
```

Expected: 全部测试通过，包括新增的 TransformExecutor 测试。

- [ ] **Step 2: 运行 workflow-engine 包全部测试**

```bash
cd packages/workflow-engine && bun test
```

Expected: 全部通过。

- [ ] **Step 3: 运行前端构建**

```bash
bun run build:web
```

Expected: 构建成功，无 TS 错误。

- [ ] **Step 4: 运行 precheck**

```bash
bun run precheck
```

Expected: biome format / biome check / tsc 全部通过。

- [ ] **Step 5: 启动开发环境手动验证**

```bash
bun run dev &
bun run dev:web &
```

在浏览器中：
1. 打开 workflow 编辑器
2. 确认左侧面板出现 Transform 节点（橙色，Shuffle 图标）
3. 拖入 Transform 节点，点击打开配置 Popover
4. 类型下拉中可选择 "变换"（中文）/ "Transform"（英文）
5. 配置 inputs（如 `data: nodes.api_1.output`）和 output（如 `names: data.items.map(i => i.name)`）
6. 保存工作流，检查 YAML 中 transform 节点是否正确序列化

Expected: 所有交互正常。

- [ ] **Step 6: Commit**

```bash
git commit -m "chore: final verification of transform node feature"
```
