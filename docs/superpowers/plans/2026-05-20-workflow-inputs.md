# Workflow Inputs: 显式节点间数据传递 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Shell 和 Python 节点新增 `inputs` 字段，用显式声明 + 变量注入替代 `${{ }}` 模板语法，同时修复 Agent/API executor 的模板解析 bug。

**Architecture:** 在 `DAGScheduler.resolveNodeInputs()` 中解析 `inputs` 表达式，将结果通过 `NodeExecutionContext.resolvedInputs` 传递给 executor。ProcessExecutor 将 inputs 注入为环境变量，PythonExecutor 将 inputs 注入为 Python 变量赋值代码。Agent/API executor 改为使用 `resolvedInputs` 而非自己重新解析模板。

**Tech Stack:** TypeScript, Bun test, Drizzle ORM, Elysia

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/workflow-engine/src/types/dag.ts` | 新增 `inputs` 字段到 ShellNodeDef / PythonNodeDef |
| Modify | `packages/workflow-engine/src/parser/yaml-parser.ts` | 解析 YAML 中的 `inputs` 字段 |
| Modify | `packages/workflow-engine/src/parser/dag-validator.ts` | 校验 inputs 中引用的节点必须在 depends_on 中 |
| Create | `packages/workflow-engine/src/parser/inputs-resolver.ts` | 解析 inputs 表达式并生成注入代码 |
| Create | `packages/workflow-engine/src/__tests__/parser/inputs-resolver.test.ts` | inputs-resolver 单元测试 |
| Modify | `packages/workflow-engine/src/scheduler/dag-scheduler.ts` | 调整 resolveNodeInputs：shell/python 用 inputs，agent/api 结果放入 resolvedInputs |
| Modify | `packages/workflow-engine/src/executor/process-executor.ts` | 用 resolvedInputs 注入环境变量，去掉模板解析 |
| Modify | `packages/workflow-engine/src/executor/python-executor.ts` | 用 resolvedInputs 注入变量赋值代码，去掉模板解析 |
| Modify | `packages/workflow-engine/src/executor/agent-executor.ts` | 使用 ctx.resolvedInputs，去掉 buildEvalContext |
| Modify | `packages/workflow-engine/src/executor/api-executor.ts` | 使用 ctx.resolvedInputs，去掉 buildEvalContext |
| Modify | `packages/workflow-engine/src/engine/workflow-engine.ts` | ActiveRun 存储 params/secrets，approveNode 恢复时使用 |
| Modify | `packages/workflow-engine/src/__tests__/parser/dag-validator.test.ts` | 新增 inputs 校验测试 |
| Modify | `packages/workflow-engine/src/__tests__/executor/process-executor.test.ts` | 新增 inputs 注入测试 |
| Modify | `packages/workflow-engine/src/__tests__/executor/python-executor.test.ts` | 新增 inputs 注入测试 |
| Modify | `packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts` | 验证 resolvedInputs 生效 |
| Modify | `packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts` | 端到端测试：inputs 传递、approveNode 恢复 |

---

### Task 1: Add `inputs` field to ShellNodeDef and PythonNodeDef types

**Files:**
- Modify: `packages/workflow-engine/src/types/dag.ts:32-58`

- [ ] **Step 1: Add `inputs` field to ShellNodeDef and PythonNodeDef**

In `packages/workflow-engine/src/types/dag.ts`, add `inputs` to both interfaces:

```typescript
/** Shell 节点 — 执行命令 */
export interface ShellNodeDef extends BaseNodeDef {
  type: 'shell';
  command: string | string[];
  cwd?: string;
  /** 显式声明需要注入为环境变量的上游数据，key 为环境变量名，value 为表达式 */
  inputs?: Record<string, string>;
}

/** Python 节点 — 执行 Python 脚本 */
export interface PythonNodeDef extends BaseNodeDef {
  type: 'python';
  code: string;
  requirements?: string[];
  cwd?: string;
  /** 显式声明需要注入为 Python 变量的上游数据，key 为变量名，value 为表达式 */
  inputs?: Record<string, string>;
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -30`
Expected: No new type errors (inputs is optional, so existing code unaffected)

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/types/dag.ts
git commit -m "feat(workflow): add inputs field to ShellNodeDef and PythonNodeDef types"
```

---

### Task 2: Update YAML parser to parse `inputs` field

**Files:**
- Modify: `packages/workflow-engine/src/parser/yaml-parser.ts:122-150`

- [ ] **Step 1: Add inputs parsing to shell and python cases in parseNode**

In `packages/workflow-engine/src/parser/yaml-parser.ts`, update the shell case (around line 122) and python case (around line 137):

```typescript
    case "shell": {
      if (!("command" in n)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): shell node requires 'command'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "shell",
        command: n.command as string | string[],
        cwd: typeof n.cwd === "string" ? n.cwd : undefined,
        inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
      };
    }
    case "python": {
      if (!("code" in n)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): python node requires 'code'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "python",
        code: n.code as string,
        requirements: Array.isArray(n.requirements) ? (n.requirements as string[]) : undefined,
        cwd: typeof n.cwd === "string" ? n.cwd : undefined,
        inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
      };
    }
```

- [ ] **Step 2: Run existing tests**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/parser/yaml-parser.ts
git commit -m "feat(workflow): parse inputs field in YAML for shell and python nodes"
```

---

### Task 3: Add validation for `inputs` references

**Files:**
- Modify: `packages/workflow-engine/src/parser/dag-validator.ts`
- Modify: `packages/workflow-engine/src/__tests__/parser/dag-validator.test.ts`

For shell/python nodes with `inputs`, every `nodes.<id>` referenced in an inputs expression must appear in the node's `depends_on`. This is an error, not a warning (no auto-add).

- [ ] **Step 1: Write the failing test**

Append to `packages/workflow-engine/src/__tests__/parser/dag-validator.test.ts`:

```typescript
// inputs 引用的节点必须在 depends_on 中（shell）
test("shell inputs 引用未声明依赖的节点报错", () => {
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
    inputs:
      DATA: nodes.step1.output
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(false);
  const inputIssue = result.issues.find(
    (i) => i.code === "INPUTS_MISSING_DEPENDENCY" && i.nodeId === "step2",
  );
  expect(inputIssue).toBeDefined();
  expect(inputIssue!.message).toContain("step1");
});

// inputs 引用的节点已声明依赖 → 校验通过（shell）
test("shell inputs 引用的节点已声明依赖 → 校验通过", () => {
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
    depends_on: [step1]
    inputs:
      DATA: nodes.step1.output
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(true);
});

// inputs 引用未声明依赖的节点报错（python）
test("python inputs 引用未声明依赖的节点报错", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: step1
    type: shell
    command: echo hello
  - id: step2
    type: python
    code: print(data)
    inputs:
      data: nodes.step1.output
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(false);
  const inputIssue = result.issues.find(
    (i) => i.code === "INPUTS_MISSING_DEPENDENCY" && i.nodeId === "step2",
  );
  expect(inputIssue).toBeDefined();
});

// inputs 引用 params 和 secrets 不需要 depends_on
test("inputs 引用 params/secrets 不需要 depends_on", () => {
  const def = parseWorkflowYaml(`\
schema_version: '1'
name: test
nodes:
  - id: step1
    type: shell
    command: echo hi
    inputs:
      NAME: params.name
      KEY: secrets.API_KEY
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(true);
});

// inputs 引用多个节点，部分未声明依赖
test("inputs 引用多个节点，部分未声明依赖报错", () => {
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
    command: echo c
    depends_on: [a]
    inputs:
      A_DATA: nodes.a.output
      B_DATA: nodes.b.output
`);
  const result = validateDAG(def);
  expect(result.valid).toBe(false);
  const inputIssues = result.issues.filter((i) => i.code === "INPUTS_MISSING_DEPENDENCY");
  expect(inputIssues).toHaveLength(1);
  expect(inputIssues[0].message).toContain("b");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/dag-validator.test.ts`
Expected: New tests FAIL (INPUTS_MISSING_DEPENDENCY not yet implemented)

- [ ] **Step 3: Implement inputs validation in dag-validator.ts**

In `packages/workflow-engine/src/parser/dag-validator.ts`, add a new validation step after the existing step 5 (variable reference check), before step 2 (cycle detection). Insert around line 99:

```typescript
  // 6. inputs 引用校验：shell/python 的 inputs 中引用 nodes.<id> 必须在 depends_on 中
  for (const node of def.nodes) {
    if (node.type !== 'shell' && node.type !== 'python') continue;
    const inputs = (node as import('../types/dag').ShellNodeDef | import('../types/dag').PythonNodeDef).inputs;
    if (!inputs) continue;

    const deps = new Set(node.depends_on ?? []);
    for (const [, expr] of Object.entries(inputs)) {
      const refs = new Set<string>();
      extractNodeIdFromExpr(expr, refs);
      for (const refId of refs) {
        if (!deps.has(refId)) {
          issues.push({
            type: 'error',
            code: 'INPUTS_MISSING_DEPENDENCY',
            message: `Node '${node.id}' references 'nodes.${refId}' in inputs but does not declare it in depends_on`,
            nodeId: node.id,
          });
        }
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/dag-validator.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/parser/dag-validator.ts packages/workflow-engine/src/__tests__/parser/dag-validator.test.ts
git commit -m "feat(workflow): validate inputs references must be in depends_on"
```

---

### Task 4: Create inputs-resolver utility

**Files:**
- Create: `packages/workflow-engine/src/parser/inputs-resolver.ts`
- Create: `packages/workflow-engine/src/__tests__/parser/inputs-resolver.test.ts`

This module resolves `inputs` expressions and generates injection code for Shell (env vars) and Python (variable assignments).

- [ ] **Step 1: Write the failing tests**

Create `packages/workflow-engine/src/__tests__/parser/inputs-resolver.test.ts`:

```typescript
import { expect, test } from "bun:test";
import {
  resolveInputs,
  generateShellEnvVars,
  generatePythonPreamble,
} from "../../parser/inputs-resolver";
import type { EvalContext } from "../../types/expression";

const ctx: EvalContext = {
  nodes: {
    fetch: {
      output: { result: "hello", items: [1, 2, 3], count: 42, active: true },
      status: "COMPLETED",
    },
  },
  params: { name: "world" },
  secrets: { API_KEY: "secret123" },
};

// ---------- resolveInputs ----------

// 解析简单路径引用
test("resolveInputs 解析简单路径引用", () => {
  const result = resolveInputs(
    { DATA: "nodes.fetch.output.result" },
    ctx,
  );
  expect(result.DATA.value).toBe("hello");
});

// 解析 params 引用
test("resolveInputs 解析 params 引用", () => {
  const result = resolveInputs({ NAME: "params.name" }, ctx);
  expect(result.NAME.value).toBe("world");
});

// 解析 secrets 引用
test("resolveInputs 解析 secrets 引用", () => {
  const result = resolveInputs({ KEY: "secrets.API_KEY" }, ctx);
  expect(result.KEY.value).toBe("secret123");
});

// 解析数字值
test("resolveInputs 解析数字值", () => {
  const result = resolveInputs({ COUNT: "nodes.fetch.output.count" }, ctx);
  expect(result.COUNT.value).toBe(42);
});

// 解析布尔值
test("resolveInputs 解析布尔值", () => {
  const result = resolveInputs({ FLAG: "nodes.fetch.output.active" }, ctx);
  expect(result.FLAG.value).toBe(true);
});

// 解析对象值
test("resolveInputs 解析对象值", () => {
  const result = resolveInputs({ DATA: "nodes.fetch.output" }, ctx);
  expect(result.DATA.value).toEqual({
    result: "hello",
    items: [1, 2, 3],
    count: 42,
    active: true,
  });
});

// 解析数组值
test("resolveInputs 解析数组值", () => {
  const result = resolveInputs({ ITEMS: "nodes.fetch.output.items" }, ctx);
  expect(result.ITEMS.value).toEqual([1, 2, 3]);
});

// 解析带运算的表达式
test("resolveInputs 解析字符串拼接表达式", () => {
  const result = resolveInputs(
    { LABEL: "'prefix_' + nodes.fetch.output.result" },
    ctx,
  );
  expect(result.LABEL.value).toBe("prefix_hello");
});

// 解析 null 值（路径不存在）
test("resolveInputs 路径不存在返回 null", () => {
  const result = resolveInputs(
    { MISSING: "nodes.fetch.output.nonexistent" },
    ctx,
  );
  expect(result.MISSING.value).toBe(null);
});

// 空输入
test("resolveInputs 空输入返回空对象", () => {
  const result = resolveInputs({}, ctx);
  expect(Object.keys(result)).toHaveLength(0);
});

// ---------- generateShellEnvVars ----------

// 字符串值
test("generateShellEnvVars 字符串值", () => {
  const env = generateShellEnvVars({ MY_VAR: { value: "hello", rawExpression: "x" } });
  expect(env).toEqual({ MY_VAR: "hello" });
});

// 数字值转为字符串
test("generateShellEnvVars 数字值转为字符串", () => {
  const env = generateShellEnvVars({ COUNT: { value: 42, rawExpression: "x" } });
  expect(env).toEqual({ COUNT: "42" });
});

// 布尔值转为字符串
test("generateShellEnvVars 布尔值转为字符串", () => {
  const env = generateShellEnvVars({ FLAG: { value: true, rawExpression: "x" } });
  expect(env).toEqual({ FLAG: "true" });
});

// null 转为空字符串
test("generateShellEnvVars null 转为空字符串", () => {
  const env = generateShellEnvVars({ VAL: { value: null, rawExpression: "x" } });
  expect(env).toEqual({ VAL: "" });
});

// 对象值 JSON 序列化
test("generateShellEnvVars 对象值 JSON 序列化", () => {
  const env = generateShellEnvVars({
    DATA: { value: { result: "hello" }, rawExpression: "x" },
  });
  expect(env).toEqual({ DATA: '{"result":"hello"}' });
});

// ---------- generatePythonPreamble ----------

// 字符串值用 JSON.stringify 注入（双引号包裹）
test("generatePythonPreamble 字符串值", () => {
  const code = generatePythonPreamble({ name: { value: "hello", rawExpression: "x" } });
  expect(code).toBe('name = "hello"');
});

// 数字值用 Python 字面量
test("generatePythonPreamble 数字值", () => {
  const code = generatePythonPreamble({ count: { value: 42, rawExpression: "x" } });
  expect(code).toBe("count = 42");
});

// 布尔值用 True/False
test("generatePythonPreamble 布尔值", () => {
  const code = generatePythonPreamble({ flag: { value: true, rawExpression: "x" } });
  expect(code).toBe("flag = True");
  const code2 = generatePythonPreamble({ flag: { value: false, rawExpression: "x" } });
  expect(code2).toBe("flag = False");
});

// null 用 None
test("generatePythonPreamble null", () => {
  const code = generatePythonPreamble({ val: { value: null, rawExpression: "x" } });
  expect(code).toBe("val = None");
});

// 对象值用 json.loads
test("generatePythonPreamble 对象值用 json.loads", () => {
  const code = generatePythonPreamble({
    data: { value: { result: "hello" }, rawExpression: "x" },
  });
  expect(code).toContain("import json");
  expect(code).toContain("data = json.loads(");
});

// 数组值用 json.loads
test("generatePythonPreamble 数组值用 json.loads", () => {
  const code = generatePythonPreamble({
    items: { value: [1, 2, 3], rawExpression: "x" },
  });
  expect(code).toContain("import json");
  expect(code).toContain("items = json.loads(");
});

// 混合值只生成一个 import json
test("generatePythonPreamble 混合值只生成一个 import json", () => {
  const code = generatePythonPreamble({
    name: { value: "hello", rawExpression: "x" },
    data: { value: { x: 1 }, rawExpression: "x" },
    count: { value: 42, rawExpression: "x" },
  });
  const importCount = (code.match(/import json/g) || []).length;
  expect(importCount).toBe(1);
  expect(code).toContain('name = "hello"');
  expect(code).toContain("count = 42");
  expect(code).toContain("data = json.loads(");
});

// 字符串中的特殊字符被正确转义
test("generatePythonPreamble 字符串含双引号被转义", () => {
  const code = generatePythonPreamble({
    text: { value: 'say "hello"', rawExpression: "x" },
  });
  expect(code).toBe('text = "say \\"hello\\""');
});

// json.loads 中的单引号被转义
test("generatePythonPreamble json.loads 中值含单引号", () => {
  const code = generatePythonPreamble({
    data: { value: { text: "it's fine" }, rawExpression: "x" },
  });
  // json.loads 用单引号包裹，内部单引号需转义
  expect(code).toContain("json.loads('");
  expect(code).toContain("it\\'s fine");
});

// 空输入返回空字符串
test("generatePythonPreamble 空输入返回空字符串", () => {
  const code = generatePythonPreamble({});
  expect(code).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/inputs-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement inputs-resolver**

Create `packages/workflow-engine/src/parser/inputs-resolver.ts`:

```typescript
/**
 * Inputs 解析器 — 解析 inputs 表达式并生成 Shell 环境变量 / Python 变量注入代码。
 */

import { parseExpression, evaluateExpression } from "./expression-parser";
import type { EvalContext } from "../types/expression";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";

/** 解析后的单个 input */
export interface ResolvedInput {
  value: unknown;
  rawExpression: string;
}

/**
 * 解析 inputs 映射中的所有表达式，返回解析结果。
 */
export function resolveInputs(
  inputs: Record<string, string>,
  context: EvalContext,
): Record<string, ResolvedInput> {
  const resolved: Record<string, ResolvedInput> = {};
  for (const [key, expr] of Object.entries(inputs)) {
    try {
      const ast = parseExpression(expr);
      const value = evaluateExpression(ast, context);
      resolved[key] = { value, rawExpression: expr };
    } catch (err) {
      if (err instanceof WorkflowError) throw err;
      throw new WorkflowError(
        `Failed to resolve input '${key}': ${(err as Error).message}`,
        WorkflowErrorCode.INVALID_EXPRESSION,
        { key, expression: expr },
      );
    }
  }
  return resolved;
}

/**
 * 将解析后的 inputs 转为 Shell 环境变量映射。
 * 所有值统一转为字符串。
 */
export function generateShellEnvVars(
  resolved: Record<string, ResolvedInput>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, { value }] of Object.entries(resolved)) {
    if (value === null || value === undefined) {
      env[key] = "";
    } else if (typeof value === "object") {
      env[key] = JSON.stringify(value);
    } else {
      env[key] = String(value);
    }
  }
  return env;
}

/**
 * 将解析后的 inputs 生成为 Python 变量赋值代码。
 * - 简单值（字符串/数字/布尔/null）用 Python 字面量
 * - 复杂值（对象/数组）用 json.loads()
 */
export function generatePythonPreamble(
  resolved: Record<string, ResolvedInput>,
): string {
  const entries = Object.entries(resolved);
  if (entries.length === 0) return "";

  const lines: string[] = [];
  let needsJsonImport = false;

  for (const [varName, { value }] of entries) {
    if (value === null || value === undefined) {
      lines.push(`${varName} = None`);
    } else if (typeof value === "string") {
      lines.push(`${varName} = ${JSON.stringify(value)}`);
    } else if (typeof value === "number") {
      lines.push(`${varName} = ${value}`);
    } else if (typeof value === "boolean") {
      lines.push(`${varName} = ${value ? "True" : "False"}`);
    } else {
      needsJsonImport = true;
      const jsonStr = JSON.stringify(value);
      const escaped = jsonStr.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      lines.push(`${varName} = json.loads('${escaped}')`);
    }
  }

  if (needsJsonImport) {
    lines.unshift("import json");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/inputs-resolver.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/parser/inputs-resolver.ts packages/workflow-engine/src/__tests__/parser/inputs-resolver.test.ts
git commit -m "feat(workflow): create inputs-resolver with shell env and python preamble generators"
```

---

### Task 5: Update DAGScheduler to resolve inputs and adjust template handling

**Files:**
- Modify: `packages/workflow-engine/src/scheduler/dag-scheduler.ts`

This task modifies `resolveNodeInputs()` to:
- For shell/python: resolve `inputs` via `resolveInputs()`, store in `resolved.inputs`. Do NOT resolve `command`/`code`/`env` with `${{ }}`.
- For agent/api: keep existing `${{ }}` resolution (unchanged).
- Remove `buildEvalContext()` — no longer needed at scheduler level for the new path. Keep it only for nodes that still use `${{ }}` (agent, api, workflow, loop, audit).

- [ ] **Step 1: Modify resolveNodeInputs in dag-scheduler.ts**

Add import at top of `packages/workflow-engine/src/scheduler/dag-scheduler.ts`:

```typescript
import { resolveInputs } from '../parser/inputs-resolver';
```

Then modify the `resolveNodeInputs` method. Replace the `switch (node.type)` cases for `shell` and `python`:

```typescript
  /** 解析节点输入中的 ${{ }} 表达式或 inputs 字段 */
  private resolveNodeInputs(node: NodeDef): Record<string, unknown> {
    const evalContext = this.buildEvalContext();

    const resolved: Record<string, unknown> = {};

    // 解析各节点类型特有的字段
    switch (node.type) {
      case 'shell': {
        // Shell 节点：command 不做模板解析，通过 inputs 注入环境变量
        resolved.command = node.command;
        if (node.cwd) resolved.cwd = node.cwd;
        if (node.inputs) {
          resolved.inputs = resolveInputs(node.inputs, evalContext);
        }
        break;
      }
      case 'python': {
        // Python 节点：code 不做模板解析，通过 inputs 注入变量
        resolved.code = node.code;
        if (node.requirements) resolved.requirements = node.requirements;
        if (node.cwd) resolved.cwd = node.cwd;
        if (node.inputs) {
          resolved.inputs = resolveInputs(node.inputs, evalContext);
        }
        break;
      }
      case 'agent': {
        resolved.prompt = resolveTemplate(node.prompt, evalContext);
        if (node.agent) resolved.agent = resolveTemplate(node.agent, evalContext);
        if (node.skill) resolved.skill = resolveTemplate(node.skill, evalContext);
        if (node.model) resolved.model = resolveTemplate(node.model, evalContext);
        if (node.temperature !== undefined) resolved.temperature = node.temperature;
        if (node.steps !== undefined) resolved.steps = node.steps;
        break;
      }
      case 'api': {
        resolved.url = resolveTemplate(node.url, evalContext);
        if (node.body) resolved.body = resolveTemplate(node.body, evalContext);
        if (node.headers) {
          resolved.headers = Object.fromEntries(
            Object.entries(node.headers).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
          );
        }
        break;
      }
      case 'audit': {
        resolved.display_data = node.display_data;
        break;
      }
      case 'workflow': {
        resolved.ref = resolveTemplate(node.ref, evalContext);
        if (node.params) {
          resolved.params = Object.fromEntries(
            Object.entries(node.params).map(([k, v]) => {
              if (typeof v === 'string') return [k, resolveTemplate(v, evalContext)];
              return [k, v];
            }),
          );
        }
        break;
      }
      case 'loop': {
        resolved.condition = resolveTemplate(node.condition, evalContext);
        resolved.max_iterations = node.max_iterations;
        break;
      }
    }

    // 通用字段：condition（用于所有节点类型的条件执行）
    if (node.condition) {
      resolved.condition = resolveTemplate(node.condition, evalContext);
    }
    // env 字段：shell/python 的 env 保留原始值（静态常量），agent/api 等做模板解析
    if (node.env) {
      if (node.type === 'shell' || node.type === 'python') {
        resolved.env = node.env;
      } else {
        resolved.env = Object.fromEntries(
          Object.entries(node.env).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
        );
      }
    }

    return resolved;
  }
```

- [ ] **Step 2: Run scheduler tests**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/scheduler/`
Expected: All existing tests pass (MockNodeExecutor ignores resolvedInputs, so no behavior change)

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/scheduler/dag-scheduler.ts
git commit -m "feat(workflow): scheduler resolves inputs for shell/python, skips template resolution on command/code"
```

---

### Task 6: Update ProcessExecutor — inputs as env vars, remove template resolution

**Files:**
- Modify: `packages/workflow-engine/src/executor/process-executor.ts`
- Modify: `packages/workflow-engine/src/__tests__/executor/process-executor.test.ts`

- [ ] **Step 1: Write the failing test for inputs injection**

Append to `packages/workflow-engine/src/__tests__/executor/process-executor.test.ts`, inside the top-level `describe('ProcessExecutor', ...)` block (after the existing tests):

```typescript
  // inputs 注入为环境变量
  test("inputs 注入为环境变量", async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        command: "echo $MY_DATA",
        inputs: {
          MY_DATA: { value: "from_inputs", rawExpression: "nodes.x.output" },
          MY_COUNT: { value: 42, rawExpression: "nodes.x.output.count" },
        },
      },
    });
    const node = shellNode("echo $MY_DATA", {
      inputs: { MY_DATA: "nodes.x.output", MY_COUNT: "nodes.x.output.count" },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe("from_inputs");
  });

  // inputs 对象值 JSON 序列化为环境变量
  test("inputs 对象值 JSON 序列化为环境变量", async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        command: "echo $DATA",
        inputs: {
          DATA: { value: { result: "hello" }, rawExpression: "nodes.x.output" },
        },
      },
    });
    const node = shellNode("echo $DATA", {
      inputs: { DATA: "nodes.x.output" },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe('{"result":"hello"}');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/process-executor.test.ts`
Expected: New tests FAIL (executor doesn't read resolvedInputs.inputs)

- [ ] **Step 3: Rewrite ProcessExecutor.execute to use resolvedInputs**

Replace the `execute` method in `packages/workflow-engine/src/executor/process-executor.ts`. The key changes:
- Read `command` from `ctx.resolvedInputs.command` (already resolved by scheduler, or raw)
- Read inputs from `ctx.resolvedInputs.inputs`, convert to env vars via `generateShellEnvVars`
- Remove `buildEvalContext()`, `resolveCommand()`, `resolveEnv()` — no longer needed
- Keep `env` field handling for static constants

New `execute` method (replace lines 30-81):

```typescript
  async execute(node: import('../types/dag').NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== 'shell') {
      throw new WorkflowError(
        `ProcessExecutor only handles 'shell' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const shellNode = node as ShellNodeDef;

    // 从 resolvedInputs 获取命令（scheduler 已处理 inputs）
    const command = ctx.resolvedInputs.command as string | string[];
    const resolvedCommand = typeof command === 'string'
      ? ['/bin/sh', '-c', command]
      : command;

    // 合并环境变量：env（静态）+ inputs（动态）+ secrets
    const env: Record<string, string | undefined> = { ...process.env as Record<string, string> };

    // 静态 env 字段
    const nodeEnv = ctx.resolvedInputs.env as Record<string, string> | undefined;
    if (nodeEnv) {
      for (const [k, v] of Object.entries(nodeEnv)) {
        env[k] = v;
      }
    }

    // inputs 注入为环境变量
    const resolvedInputs = ctx.resolvedInputs.inputs as Record<string, { value: unknown; rawExpression: string }> | undefined;
    if (resolvedInputs) {
      for (const [key, { value }] of Object.entries(resolvedInputs)) {
        if (value === null || value === undefined) {
          env[key] = "";
        } else if (typeof value === "object") {
          env[key] = JSON.stringify(value);
        } else {
          env[key] = String(value);
        }
      }
    }

    // secrets 注入
    for (const [k, v] of Object.entries(ctx.secrets)) {
      env[k] = v;
    }

    const cwd = (ctx.resolvedInputs.cwd as string) ?? process.cwd();

    // AbortSignal 组合
    const timeoutMs = (shellNode.timeout ?? 300_000 / 1000) * 1000;
    const timeoutController = new AbortController();

    if (ctx.signal.aborted) {
      timeoutController.abort();
    }

    const timer = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);

    const onExternalAbort = () => {
      clearTimeout(timer);
      timeoutController.abort();
    };
    ctx.signal.addEventListener('abort', onExternalAbort, { once: true });

    try {
      return await this.executeWithRetry(
        shellNode,
        resolvedCommand,
        env,
        cwd,
        ctx,
        timeoutController.signal,
      );
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onExternalAbort);
    }
  }
```

Also update `spawnProcess` signature — the `env` parameter changes from `Record<string, string | undefined>` to match, and remove `_evalContext` parameter. The `resolveCommand`, `resolveEnv`, and `buildEvalContext` methods can be removed entirely.

Remove these methods: `buildEvalContext`, `resolveCommand`, `resolveEnv`.

- [ ] **Step 4: Run all process-executor tests**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/process-executor.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/executor/process-executor.ts packages/workflow-engine/src/__tests__/executor/process-executor.test.ts
git commit -m "feat(workflow): ProcessExecutor uses inputs injection, removes ${{ }} template resolution"
```

---

### Task 7: Update PythonExecutor — inputs as variable injection, remove template resolution

**Files:**
- Modify: `packages/workflow-engine/src/executor/python-executor.ts`
- Modify: `packages/workflow-engine/src/__tests__/executor/python-executor.test.ts`

- [ ] **Step 1: Write the failing test for Python inputs injection**

Create/append to `packages/workflow-engine/src/__tests__/executor/python-executor.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from 'bun:test';
import { PythonExecutor } from '../../executor/python-executor';
import type { PythonNodeDef } from '../../types/dag';
import type { NodeExecutionContext } from '../../scheduler/dag-scheduler';
import { createInMemoryStorage } from '../../storage/in-memory-storage';

function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: 'test-run-py',
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

function pythonNode(code: string, overrides?: Partial<PythonNodeDef>): PythonNodeDef {
  return {
    id: 'test-python',
    type: 'python',
    code,
    ...overrides,
  };
}

describe('PythonExecutor inputs injection', () => {
  let executor: PythonExecutor;

  beforeEach(() => {
    executor = new PythonExecutor();
  });

  // inputs 注入为 Python 变量（简单字符串）
  test("inputs 注入字符串变量", async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: "print(name)",
        inputs: {
          name: { value: "hello", rawExpression: "x" },
        },
      },
    });
    const node = pythonNode("print(name)", {
      inputs: { name: "nodes.x.output.name" },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe("hello");
  });

  // inputs 注入数字变量
  test("inputs 注入数字变量", async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: "print(count)",
        inputs: {
          count: { value: 42, rawExpression: "x" },
        },
      },
    });
    const node = pythonNode("print(count)", {
      inputs: { count: "nodes.x.output.count" },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe("42");
  });

  // inputs 注入对象变量（json.loads）
  test("inputs 注入对象变量", async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: "print(data['result'])",
        inputs: {
          data: { value: { result: "hello" }, rawExpression: "x" },
        },
      },
    });
    const node = pythonNode("print(data['result'])", {
      inputs: { data: "nodes.x.output" },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe("hello");
  });

  // inputs 注入 null 为 None
  test("inputs 注入 None", async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: "print(val is None)",
        inputs: {
          val: { value: null, rawExpression: "x" },
        },
      },
    });
    const node = pythonNode("print(val is None)", {
      inputs: { val: "nodes.x.output.nonexistent" },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe("True");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/python-executor.test.ts`
Expected: New tests FAIL

- [ ] **Step 3: Rewrite PythonExecutor.execute to use resolvedInputs**

Modify `packages/workflow-engine/src/executor/python-executor.ts`. Key changes:
- Read `code` from `ctx.resolvedInputs.code` (raw, no template resolution)
- Read inputs from `ctx.resolvedInputs.inputs`, generate Python preamble via `generatePythonPreamble`
- Prepend preamble to code before writing temp file
- Remove `buildEvalContext`, `resolveEnv`

Add import at top of file:

```typescript
import { generatePythonPreamble } from '../parser/inputs-resolver';
```

Replace the `execute` method (the first 30 lines of the class). The core change is in `spawnPython` where the code is assembled:

```typescript
  async execute(node: import('../types/dag').NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== 'python') {
      throw new WorkflowError(
        `PythonExecutor only handles 'python' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const pyNode = node as PythonNodeDef;

    // 从 resolvedInputs 获取代码和 inputs
    const userCode = (ctx.resolvedInputs.code as string) ?? pyNode.code;
    const resolvedInputs = ctx.resolvedInputs.inputs as Record<string, { value: unknown; rawExpression: string }> | undefined;

    // 生成 Python 前导代码（变量注入）
    const preamble = resolvedInputs ? generatePythonPreamble(resolvedInputs) : '';
    const fullCode = preamble ? `${preamble}\n${userCode}` : userCode;

    // 合并环境变量
    const env: Record<string, string | undefined> = { ...process.env as Record<string, string> };
    const nodeEnv = ctx.resolvedInputs.env as Record<string, string> | undefined;
    if (nodeEnv) {
      for (const [k, v] of Object.entries(nodeEnv)) {
        env[k] = v;
      }
    }
    for (const [k, v] of Object.entries(ctx.secrets)) {
      env[k] = v;
    }

    const cwd = (ctx.resolvedInputs.cwd as string) ?? process.cwd();

    const timeoutMs = (pyNode.timeout ?? 300_000 / 1000) * 1000;
    const timeoutController = new AbortController();

    if (ctx.signal.aborted) timeoutController.abort();

    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const onExternalAbort = () => { clearTimeout(timer); timeoutController.abort(); };
    ctx.signal.addEventListener('abort', onExternalAbort, { once: true });

    try {
      return await this.executeWithRetry(pyNode, fullCode, env, cwd, ctx, timeoutController.signal);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onExternalAbort);
    }
  }
```

Remove `buildEvalContext` and `resolveEnv` methods. The `executeWithRetry` and `spawnPython` methods stay mostly the same but `spawnPython` no longer needs the `_evalContext` parameter.

- [ ] **Step 4: Run all python-executor tests**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/python-executor.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/executor/python-executor.ts packages/workflow-engine/src/__tests__/executor/python-executor.test.ts
git commit -m "feat(workflow): PythonExecutor uses inputs injection, generates variable preamble"
```

---

### Task 8: Fix AgentExecutor — use resolvedInputs instead of own template resolution

**Files:**
- Modify: `packages/workflow-engine/src/executor/agent-executor.ts`

- [ ] **Step 1: Modify AgentExecutor to use ctx.resolvedInputs**

In `packages/workflow-engine/src/executor/agent-executor.ts`, replace the `execute` and `executeOnce` methods. Key change: read resolved values from `ctx.resolvedInputs` instead of calling `resolveTemplate` with own eval context.

Replace `execute` method (lines 49-112):

```typescript
  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== 'agent') {
      throw new WorkflowError(
        `AgentExecutor only handles 'agent' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const agentNode = node as AgentNodeDef;

    // 从 resolvedInputs 读取已解析的值（scheduler 已完成模板解析）
    const resolvedPrompt = (ctx.resolvedInputs.prompt as string) ?? agentNode.prompt;
    const resolvedAgent = (ctx.resolvedInputs.agent as string) ?? agentNode.agent;
    const resolvedSkill = (ctx.resolvedInputs.skill as string) ?? agentNode.skill;

    // 合并 agent config + 节点级覆盖
    const mergedConfig = await this.resolveAndMergeConfig(agentNode);

    // 重试配置：默认 2 次
    const retryConfig = agentNode.retry ?? { count: 2, delay: 1000, backoff: 'exponential' };
    const maxAttempts = (retryConfig.count ?? 2) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const baseDelay = retryConfig.delay ?? 1000;
        const multiplier = retryConfig.backoff === 'exponential' ? Math.pow(2, attempt - 1) : 1;
        const jitter = 0.5 + Math.random() * 0.5;
        const delay = Math.round(baseDelay * multiplier * jitter);

        await this.emitEvent(ctx, 'node.retrying', agentNode, {
          attempt: attempt + 1,
          max_attempts: maxAttempts,
          next_delay_ms: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        return await this.executeOnce(agentNode, ctx, resolvedPrompt, resolvedAgent, resolvedSkill, mergedConfig);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new WorkflowError(
            'Node cancelled',
            WorkflowErrorCode.DAG_CANCELLED,
            { node_id: node.id },
          );
        }

        if (attempt === maxAttempts - 1) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new WorkflowError('All retry attempts exhausted', WorkflowErrorCode.NODE_FAILED);
  }
```

Remove the `buildEvalContext` method. The rest of the class (`executeOnce`, `resolveAndMergeConfig`, `emitEvent`) stays the same.

- [ ] **Step 2: Run agent-executor tests**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/executor/agent-executor.ts
git commit -m "fix(workflow): AgentExecutor uses resolvedInputs instead of own template resolution"
```

---

### Task 9: Fix ApiExecutor — use resolvedInputs instead of own template resolution

**Files:**
- Modify: `packages/workflow-engine/src/executor/api-executor.ts`

- [ ] **Step 1: Modify ApiExecutor to use ctx.resolvedInputs**

In `packages/workflow-engine/src/executor/api-executor.ts`, replace the `execute` and `doRequest` methods.

Replace `execute` method:

```typescript
  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== 'api') {
      throw new WorkflowError(
        `ApiExecutor only handles 'api' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const apiNode = node as ApiNodeDef;

    return this.executeWithRetry(apiNode, ctx, (_attempt, signal) =>
      this.doRequest(apiNode, ctx, signal),
    );
  }
```

Replace `doRequest` — read resolved values from `ctx.resolvedInputs`:

```typescript
  private async doRequest(
    node: ApiNodeDef,
    ctx: NodeExecutionContext,
    signal: AbortSignal,
  ): Promise<NodeOutput> {
    // 从 resolvedInputs 获取已解析的值
    const url = (ctx.resolvedInputs.url as string) ?? node.url;
    const method = node.method ?? 'GET';

    const headers: Record<string, string> = {};
    const resolvedHeaders = ctx.resolvedInputs.headers as Record<string, string> | undefined;
    if (resolvedHeaders) {
      for (const [k, v] of Object.entries(resolvedHeaders)) {
        headers[k] = v;
      }
    } else if (node.headers) {
      for (const [k, v] of Object.entries(node.headers)) {
        headers[k] = v;
      }
    }

    const init: RequestInit = {
      method,
      headers,
      signal,
    };

    const resolvedBody = ctx.resolvedInputs.body as string | undefined;
    if (resolvedBody ?? node.body) {
      init.body = resolvedBody ?? node.body;
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    await this.emitNodeStarted(node.id, node.type, ctx, { url, method, inputs: ctx.resolvedInputs });

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const isExternalCancel = ctx.signal.aborted;
        await this.emitNodeFailed(
          node.id, node.type, ctx,
          isExternalCancel ? 'cancelled' : 'timeout',
        );
        throw new WorkflowError(
          isExternalCancel ? 'API request cancelled' : 'API request timed out',
          isExternalCancel ? WorkflowErrorCode.DAG_CANCELLED : WorkflowErrorCode.NODE_TIMEOUT,
          { node_id: node.id },
        );
      }
      const msg = error instanceof Error ? error.message : String(error);
      await this.emitNodeFailed(node.id, node.type, ctx, msg);
      throw new WorkflowError(`API request failed: ${msg}`, WorkflowErrorCode.NODE_FAILED, { node_id: node.id });
    }

    const bodyText = await response.text();
    const { stdout, json, size, ref } = await this.processResponseBody(bodyText, ctx);

    const exitCode = response.ok ? 0 : response.status;

    if (!response.ok) {
      await this.emitNodeFailed(node.id, node.type, ctx, `HTTP ${response.status}`, exitCode);
      throw new WorkflowError(
        `HTTP request failed with status ${response.status}`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: node.id, exit_code: exitCode, stdout },
      );
    }

    const output: NodeOutput = { stdout, json, exit_code: exitCode, size, ref };
    await this.emitNodeCompleted(node.id, node.type, ctx, output);
    return output;
  }
```

Remove the `buildEvalContext` method.

- [ ] **Step 2: Run api-executor tests**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/api-executor.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/executor/api-executor.ts
git commit -m "fix(workflow): ApiExecutor uses resolvedInputs instead of own template resolution"
```

---

### Task 10: Fix approveNode — preserve params and secrets in ActiveRun

**Files:**
- Modify: `packages/workflow-engine/src/engine/workflow-engine.ts`

- [ ] **Step 1: Add params and secrets to ActiveRun interface**

In `packages/workflow-engine/src/engine/workflow-engine.ts`, update the `ActiveRun` interface:

```typescript
interface ActiveRun {
  cancellation: CancellationManager;
  workflowDef: WorkflowDef;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
}
```

Update all places that create `activeRuns.set(...)`:

```typescript
// In run() (around line 202):
activeRuns.set(runId, { cancellation, workflowDef: validation.def, params: resolvedParams, secrets });

// In recover() (around line 478):
activeRuns.set(runId, { cancellation, workflowDef: validation.def, params: {}, secrets });

// In rerunFrom() (around line 586):
activeRuns.set(newRunId, { cancellation, workflowDef: validation.def, params: {}, secrets });
```

- [ ] **Step 2: Update approveNode to use stored params/secrets**

In the `approveNode` function, replace the hardcoded empty objects:

```typescript
    // 用恢复上下文重新调度
    const context: SchedulerContext = {
      runId,
      workflowDef: activeRun.workflowDef,
      storage,
      params: activeRun.params,
      secrets: activeRun.secrets,
      nodeExecutor: registry,
      cancellation: activeRun.cancellation,
      initialNodeStates: nodeStates,
      initialNodeOutputs: nodeOutputs,
    };
```

- [ ] **Step 3: Run engine tests**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/engine/workflow-engine.ts
git commit -m "fix(workflow): approveNode preserves params and secrets in ActiveRun"
```

---

### Task 11: End-to-end test — inputs data passing through full engine

**Files:**
- Modify: `packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts`

- [ ] **Step 1: Write end-to-end test with inputs**

Append to `packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts`:

```typescript
// Shell inputs 端到端数据传递
test("Shell 节点通过 inputs 接收上游输出", async () => {
  const yaml = `
name: inputs-e2e
schema_version: "1"
nodes:
  - id: produce
    type: shell
    command: echo '{"result":"hello","count":42}'
  - id: consume
    type: shell
    depends_on: [produce]
    inputs:
      DATA: nodes.produce.output
    command: echo "$DATA" | grep -o '"result":"hello"'
`;
  const engine = createTestEngine();
  const result = await engine.run(yaml);
  expect(result.status).toBe("SUCCESS");

  const consumeOutput = await engine.getOutput(result.runId, "consume");
  expect(consumeOutput?.exit_code).toBe(0);
  expect(consumeOutput?.stdout).toContain("result");
});

// Python inputs 端到端数据传递
test("Python 节点通过 inputs 接收上游输出", async () => {
  const yaml = `
name: python-inputs-e2e
schema_version: "1"
nodes:
  - id: produce
    type: shell
    command: echo '{"name":"world","count":42}'
  - id: consume
    type: python
    depends_on: [produce]
    inputs:
      data: nodes.produce.output
    code: |
      print(data['name'])
`;
  const engine = createTestEngine();
  const result = await engine.run(yaml);
  expect(result.status).toBe("SUCCESS");

  const consumeOutput = await engine.getOutput(result.runId, "consume");
  expect(consumeOutput?.exit_code).toBe(0);
  expect(consumeOutput?.stdout.trim()).toBe("world");
});
```

- [ ] **Step 2: Run end-to-end tests**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/`
Expected: All tests PASS (0 fail)

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/__tests__/engine/workflow-engine.test.ts
git commit -m "test(workflow): end-to-end tests for inputs data passing through full engine"
```

---

### Task 12: Export inputs-resolver from package index

**Files:**
- Modify: `packages/workflow-engine/src/index.ts`

- [ ] **Step 1: Add export for inputs-resolver**

In `packages/workflow-engine/src/index.ts`, add:

```typescript
export { resolveInputs, generateShellEnvVars, generatePythonPreamble } from './parser/inputs-resolver';
export type { ResolvedInput } from './parser/inputs-resolver';
```

- [ ] **Step 2: Commit**

```bash
git add packages/workflow-engine/src/index.ts
git commit -m "feat(workflow): export inputs-resolver utilities from package index"
```

---

### Task 13: Run full test suite and typecheck

**Files:** None

- [ ] **Step 1: Run typecheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck`
Expected: No errors

- [ ] **Step 2: Run full workflow-engine test suite**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/`
Expected: All tests PASS

- [ ] **Step 3: Run full project test suite**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/`
Expected: All existing tests PASS (no regressions)

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore(workflow): fix any remaining test/type issues from inputs refactor"
```
