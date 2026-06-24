# Slurm 节点 script 字段独立化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Slurm 节点的脚本内容从 `inputs.script` 提升为节点级独立字段 `script.content`，新增 `script.env` 子字段通过 `#SBATCH --export` 注入作业环境变量。

**Architecture:** `script` 与 `slurm:` 字段对称，作为节点级声明。解析器（yaml-parser）→ 调度器（dag-scheduler 求值 `${{ }}` 表达式）→ 执行器（custom-executor 透传）→ 工具（SlurmNode.buildScript/generateHeader 消费）。硬切换不兼容旧写法，旧 yaml 走到运行时由 SlurmNode.buildScript 报错引导迁移。

**Tech Stack:** TypeScript + Bun + Elysia + Drizzle + Zod v4（项目用 `from "zod/v4"`，禁止 v3 路径）

**Spec:** [docs/superpowers/specs/2026-06-22-slurm-script-field-design.md](../specs/2026-06-22-slurm-script-field-design.md)

---

## File Structure

按依赖顺序修改 9 个文件 + 3 个测试文件 + 1 个 yaml 示例：

```
packages/workflow-engine/src/
├── plugins/
│   ├── slurm-types.ts           # 新增 ScriptDef interface
│   ├── types.ts                  # CustomNode.kind + ExecuteContext.script
│   ├── slurm-node.ts            # kind 标记 + buildScript + generateHeader
│   └── custom-executor.ts       # 透传 script 到 ExecuteContext
├── types/dag.ts                  # CustomNodeDef.script
├── parser/yaml-parser.ts        # parseScriptConfig + kind 校验
├── scheduler/dag-scheduler.ts   # resolveNodeInputs 增加 script 求值
├── index.ts                      # 导出 ScriptDef 类型
└── __tests__/
    ├── executor/slurm-node.test.ts       # 追加 buildScript / generateHeader 测试
    ├── executor/custom-executor.test.ts  # 追加 script 透传测试
    └── parser/yaml-parser.test.ts        # 追加 script 字段解析测试

tools/slurm.ts                                # inputs 改为 {}
workflow-examples/pe-rna-seq-single-sample.yaml  # 11 节点迁移
```

每个 Task 都产出可独立提交、可独立测试的代码。

---

## Task 1: 新增核心类型（ScriptDef + kind discriminator + ExecuteContext.script + CustomNodeDef.script）

**Files:**
- Modify: `packages/workflow-engine/src/plugins/slurm-types.ts`（追加 ScriptDef）
- Modify: `packages/workflow-engine/src/plugins/types.ts`（CustomNode.kind + ExecuteContext.script）
- Modify: `packages/workflow-engine/src/types/dag.ts`（CustomNodeDef.script）
- Modify: `packages/workflow-engine/src/index.ts`（导出 ScriptDef）

纯类型层变更，无运行时行为变化，不需要测试。

- [ ] **Step 1: 在 `slurm-types.ts` 末尾追加 ScriptDef**

打开 `packages/workflow-engine/src/plugins/slurm-types.ts`，在文件末尾追加：

```typescript
/**
 * Slurm 作业脚本声明 — YAML 中 script 字段的结构。
 * 仅 SlurmNode 子类消费，由 yaml-parser.parseScriptConfig 解析、
 * dag-scheduler 求值 ${{ }} 表达式后注入 ExecuteContext.script。
 */
export interface ScriptDef {
  /** bash 脚本正文，支持 ${{ }} 表达式。不要写 #SBATCH 指令，header 由 generateHeader 生成 */
  content: string;
  /** 额外环境变量，注入到 #SBATCH --export。value 支持 ${{ }} 表达式 */
  env?: Record<string, string>;
}
```

- [ ] **Step 2: 在 `plugins/types.ts` 的 CustomNode interface 加 kind 字段**

打开 `packages/workflow-engine/src/plugins/types.ts`，找到 `CustomNode` interface（约 25-48 行），在 `produces: string[];` 之后、`execute(ctx)` 之前插入：

```typescript
  /**
   * 工具族标记，用于 yaml 解析器判断支持哪些节点级字段。
   * - "default": 普通 CustomNode，不支持 script 字段
   * - "slurm": SlurmNode 子类，必须声明 script 字段，可选声明 slurm 字段
   * 未来扩展其他基类（DockerNode/K8sNode）时新增枚举值。
   */
  kind?: "default" | "slurm";
```

- [ ] **Step 3: 在 `plugins/types.ts` 的 ExecuteContext interface 加 script 字段**

在同一文件 `plugins/types.ts` 找到 `ExecuteContext` interface（约 50-92 行），在 `slurm?: Partial<SlurmConfig>;` 字段之后插入：

```typescript
  /**
   * 已求值的脚本声明（仅 SlurmNode 子类会有值）。
   * 由 dag-scheduler 求值 ${{ }} 表达式后填充：
   * - content: resolveTemplate 结果，始终是 string
   * - env: 遍历每个 value 走 resolveTemplate，结果 Record<string, string>
   *
   * 类型上可选（非 Slurm 工具不会注入），但 SlurmNode.buildScript 在入口校验
   * ctx.script.content 必填，运行时报 NODE_FAILED。
   */
  script?: {
    content: string;
    env: Record<string, string>;
  };
```

并在文件顶部 import 中加入 ScriptDef（如果文件顶部已经从 `./slurm-types` import 了 SlurmConfig，则把 ScriptDef 加进去；否则新增一行）：

```typescript
import type { ScriptDef, SlurmConfig } from "./slurm-types";
```

注意 ExecuteContext 内联了 `{ content, env }` 而不是直接引用 `ScriptDef`，因为求值后 env 是必填（与声明的可选不同）。保持内联类型。

- [ ] **Step 4: 在 `types/dag.ts` 的 CustomNodeDef 加 script 字段**

打开 `packages/workflow-engine/src/types/dag.ts`，找到 `CustomNodeDef` interface（约 111-146 行），在 `slurm?: {...}` 字段之后、`outputs: ...` 之前插入：

```typescript
  /**
   * Slurm 脚本声明（仅当 tool 是 SlurmNode 子类时生效）。
   * 由 parseScriptConfig 解析，dag-scheduler 求值 ${{ }} 表达式后注入 ExecuteContext.script。
   * SlurmNode 子类必须声明此字段（parseNode 校验），非 Slurm 工具禁止声明。
   */
  script?: {
    content: string;
    env?: Record<string, string>;
  };
```

- [ ] **Step 5: 在 `index.ts` 导出 ScriptDef**

打开 `packages/workflow-engine/src/index.ts`，找到 SlurmConfig 类型导出行（约第 35 行）：

```typescript
export type { JobResult, SlurmConfig, SshExecutor } from "./plugins/slurm-types";
```

修改为：

```typescript
export type { JobResult, ScriptDef, SlurmConfig, SshExecutor } from "./plugins/slurm-types";
```

- [ ] **Step 6: 运行 tsc 验证类型无错误**

运行：`cd /Users/konghayao/code/pazhou/remote-control-server && bun run tsc --noEmit -p packages/workflow-engine/tsconfig.json 2>&1 | head -30`

如果 workflow-engine 没有 tsconfig.json，运行根目录的：`cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit 2>&1 | head -30`

Expected: PASS（无类型错误）。如有错误，定位到具体行修正。

- [ ] **Step 7: 运行现有所有测试，确认未破坏**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/ 2>&1 | tail -20`
Expected: PASS（所有现有测试通过，因为本任务只是类型扩展，无运行时变化）

- [ ] **Step 8: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add packages/workflow-engine/src/plugins/slurm-types.ts \
        packages/workflow-engine/src/plugins/types.ts \
        packages/workflow-engine/src/types/dag.ts \
        packages/workflow-engine/src/index.ts
git commit -m "$(cat <<'EOF'
feat(workflow-engine): 新增 ScriptDef 类型与 ExecuteContext.script 字段

为后续把 script 从 inputs.script 提升为节点级字段做类型准备。
- CustomNode 新增 kind discriminator（"default" | "slurm"）
- ExecuteContext 新增 script 字段（content + env）
- CustomNodeDef 新增 script 字段
- 新增 ScriptDef 类型并从包根导出

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SlurmNode 新增 kind 标记 + buildScript 改读 ctx.script.content（TDD）

**Files:**
- Modify: `packages/workflow-engine/src/plugins/slurm-node.ts`
- Test: `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`

- [ ] **Step 1: 写失败测试 — 默认 buildScript 读 ctx.script.content**

打开 `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`，在文件末尾（最后一行 `});` 之后）追加：

```typescript
// ── buildScript 默认实现：从 ctx.script.content 读取 ──

describe("SlurmNode.buildScript() default impl", () => {
  test("应从 ctx.script.content 读取并返回", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const ctx = makeCtx({
      script: { content: "echo hello world", env: {} },
    });
    expect(node.buildScript(ctx)).toBe("echo hello world");
  });

  test("ctx.script 缺失时抛 NODE_FAILED 含 'script.content'", () => {
    // 用一个不覆写 buildScript 的子类，触发默认实现
    class DefaultImplNode extends SlurmNode {
      name = "default_impl";
      description = "test default";
      inputs = {};
      produces = [];
    }
    const node = new DefaultImplNode();
    expect(() => node.buildScript(makeCtx())).toThrow(/script\.content/);
  });

  test("ctx.script.content 为空字符串时抛 NODE_FAILED", () => {
    class DefaultImplNode extends SlurmNode {
      name = "default_impl";
      description = "test default";
      inputs = {};
      produces = [];
    }
    const node = new DefaultImplNode();
    const ctx = makeCtx({ script: { content: "   ", env: {} } });
    expect(() => node.buildScript(ctx)).toThrow(/script\.content/);
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts 2>&1 | tail -30`
Expected: FAIL — "应从 ctx.script.content 读取并返回" 通过（TestSlurmNode 覆写了 buildScript）；"ctx.script 缺失时抛 NODE_FAILED" 失败（默认 buildScript 还在读 ctx.inputs.script，不抛错）；"ctx.script.content 为空字符串时抛 NODE_FAILED" 失败

- [ ] **Step 3: 在 SlurmNode 加 kind 标记**

打开 `packages/workflow-engine/src/plugins/slurm-node.ts`，找到 `SlurmNode` 类定义（约第 22 行），在 `slurmConfig: SlurmConfig = {...}` 之前加入：

```typescript
  // 用于 yaml-parser 判断是否是 SlurmNode 子类（决定 script 字段是否必填）
  kind = "slurm" as const;
```

- [ ] **Step 4: 改造 SlurmNode.buildScript 读 ctx.script.content**

在同一文件 `slurm-node.ts`，找到现有 `buildScript(ctx: ExecuteContext): string` 方法（约第 48-65 行），整体替换为：

```typescript
  /**
   * 生成 sbatch 脚本正文。默认实现：从 ctx.script.content 读取（已求值的 bash 字符串）。
   * 子类可覆写以实现命令组装逻辑（向后兼容场景：子类内部自己拼命令，不依赖 ctx.script）。
   *
   * 默认实现要求 ctx.script.content 存在且非空，否则抛 NODE_FAILED。
   */
  buildScript(ctx: ExecuteContext): string {
    const content = ctx.script?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new WorkflowError(
        `Slurm tool '${this.name}' requires 'script.content' (bash script content). ` +
          `Either declare script.content in YAML or override buildScript() in the tool class.`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: ctx.nodeId, tool: this.name },
      );
    }
    return content;
  }
```

- [ ] **Step 5: 运行测试，验证全部通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts 2>&1 | tail -15`
Expected: PASS — 所有测试通过（新增的 3 个 + 原有的 generateHeader/execute/retry/mapSlurmState 测试）

- [ ] **Step 6: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add packages/workflow-engine/src/plugins/slurm-node.ts \
        packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow-engine): SlurmNode 默认 buildScript 从 ctx.script.content 读取

- 新增 kind = "slurm" discriminator（供 yaml-parser 判断工具族）
- buildScript 默认实现改为读 ctx.script.content，错误消息引导用户迁移
- 测试桩 TestSlurmNode 不受影响（覆写了 buildScript）

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: generateHeader 注入 #SBATCH --export（TDD）

**Files:**
- Modify: `packages/workflow-engine/src/plugins/slurm-node.ts`
- Test: `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`

- [ ] **Step 1: 写失败测试 — env 注入到 #SBATCH --export**

打开 `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`，在文件末尾追加：

```typescript
// ── generateHeader 注入 #SBATCH --export ──

describe("SlurmNode.generateHeader() with script.env", () => {
  test("ctx.script.env 有值时追加 #SBATCH --export=ALL,...", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const ctx = makeCtx({
      script: {
        content: "echo ok",
        env: { OMP_NUM_THREADS: "4", WORK_DIR: "/data" },
      },
    });
    const header = node.testGenerateHeader(ctx);
    expect(header).toContain("#SBATCH --export=ALL,OMP_NUM_THREADS=4,WORK_DIR=/data");
  });

  test("ctx.script 缺失时不输出 #SBATCH --export", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const header = node.testGenerateHeader(makeCtx());
    expect(header).not.toContain("#SBATCH --export");
  });

  test("ctx.script.env 为空对象时不输出 #SBATCH --export", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const ctx = makeCtx({ script: { content: "x", env: {} } });
    const header = node.testGenerateHeader(ctx);
    expect(header).not.toContain("#SBATCH --export");
  });

  test("--export 位于 --error 之后、extraSBATCH 之前", () => {
    const node = new TestSlurmNode({
      partition: "xahcnormal",
      cores: 4,
      extraSBATCH: ["--gres=gpu:1"],
    });
    const ctx = makeCtx({ script: { content: "x", env: { FOO: "bar" } } });
    const header = node.testGenerateHeader(ctx);
    const errorIdx = header.indexOf("#SBATCH --error");
    const exportIdx = header.indexOf("#SBATCH --export");
    const extraIdx = header.indexOf("#SBATCH --gres=gpu:1");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeGreaterThan(errorIdx);
    expect(extraIdx).toBeGreaterThan(exportIdx);
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts -t "script.env" 2>&1 | tail -20`
Expected: FAIL — 第一个测试失败（header 不含 `--export`），其余 3 个通过（因为还没有任何 --export 输出）

- [ ] **Step 3: 改造 generateHeader 注入 --export**

打开 `packages/workflow-engine/src/plugins/slurm-node.ts`，找到 `generateHeader(ctx)` 方法（约第 192-231 行），定位到 `lines.push(\`#SBATCH --error=${outDir}/${jobName}_%j.err\`);` 这一行，在它之后、`if (config.extraSBATCH ...)` 之前插入：

```typescript
    // 注入用户声明的环境变量到 #SBATCH --export
    // 关键：必须以 ALL 开头，否则 Slurm 不会继承默认环境（PATH/HOME/SLURM_* 等），
    // 会导致脚本里 module load / apptainer 等命令找不到。
    // 边界：value 含逗号或等号时会被 sbatch 解析为多个 entry，用户需自行保证 value 简单。
    const env = ctx.script?.env;
    if (env && Object.keys(env).length > 0) {
      const entries = Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      lines.push(`#SBATCH --export=ALL,${entries}`);
    }
```

- [ ] **Step 4: 运行测试，验证全部通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts 2>&1 | tail -15`
Expected: PASS — 所有测试通过

- [ ] **Step 5: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add packages/workflow-engine/src/plugins/slurm-node.ts \
        packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow-engine): SlurmNode header 注入 #SBATCH --export

ctx.script.env 有值时，在 --error 之后、extraSBATCH 之前注入
#SBATCH --export=ALL,K=V,...，让 Slurm 子进程继承声明的环境变量。
ALL 前缀保证默认环境（PATH/HOME/SLURM_*）不丢失。

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: parseScriptConfig + parseNode 注入 script 字段 + kind 校验（TDD）

**Files:**
- Modify: `packages/workflow-engine/src/parser/yaml-parser.ts`
- Test: `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts`

- [ ] **Step 1: 写失败测试 — 解析 script.content + script.env**

打开 `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts`，找到现有的 `createFakeRegistry` 函数（约第 362-374 行），把它升级为支持 kind 参数：

```typescript
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
```

然后在文件末尾追加新测试：

```typescript
// ── custom 节点 script 字段解析 ──

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
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts -t "script" 2>&1 | tail -30`
Expected: FAIL — 所有新测试都失败（parseScriptConfig 还没实现）

- [ ] **Step 3: 在 yaml-parser.ts 新增 parseScriptConfig 函数**

打开 `packages/workflow-engine/src/parser/yaml-parser.ts`，找到现有的 `parseSlurmConfig` 函数（约第 351-375 行），在它之后（`isRecord` 辅助函数之前）追加：

```typescript
/**
 * 解析 custom 节点的 script: 字段为 { content, env }。
 * 仅 tool 是 SlurmNode 子类时由 parseNode 调用。
 *
 * 校验：
 * - content 必须是非空字符串，否则抛 INVALID_YAML（含节点 id + 字段路径）
 * - env 若声明必须是 Record<string, string>，value 非字符串时 warn 并跳过（宽容处理）
 * - 字段全缺失时返回 undefined（但 SlurmNode 子类的 parseNode 会要求 content 必填）
 */
function parseScriptConfig(raw: unknown, nodeId: string): CustomNodeDef["script"] {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new WorkflowError(
      `nodes (${nodeId}): 'script' must be a mapping with 'content' and optional 'env'`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  const result: NonNullable<CustomNodeDef["script"]> = {};

  // content: 必须是非空字符串
  if (typeof raw.content !== "string" || !raw.content.trim()) {
    throw new WorkflowError(
      `nodes (${nodeId}): 'script.content' is required and must be a non-empty string`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }
  result.content = raw.content;

  // env: 可选，必须是 Record<string, string>，value 非字符串时 warn 并跳过
  if (raw.env !== undefined && raw.env !== null) {
    if (!isRecord(raw.env)) {
      throw new WorkflowError(
        `nodes (${nodeId}): 'script.env' must be a mapping of string -> string`,
        WorkflowErrorCode.INVALID_YAML,
      );
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== "string") {
        console.warn(`[yaml-parser] nodes (${nodeId}): script.env['${k}'] is not a string, skipping`);
        continue;
      }
      env[k] = v;
    }
    if (Object.keys(env).length > 0) result.env = env;
  }

  return result;
}
```

- [ ] **Step 4: 在 parseNode 的 case "custom" 注入 script 校验和解析**

在同一文件 `yaml-parser.ts`，找到 `case "custom":`（约第 271-322 行）。在现有的 produces 校验逻辑之后（约第 307 行 `}` 之后，`return {` 之前），插入 kind 判断和 script 校验：

```typescript
      // 新增：根据 tool kind 判断是否允许/要求 script 字段
      const isSlurmTool = toolDef?.kind === "slurm";

      if (isSlurmTool) {
        // SlurmNode 子类：script 必填
        if (n.script === undefined || n.script === null) {
          throw new WorkflowError(
            `nodes[${index}] (${n.id}): slurm tool '${n.tool}' requires 'script.content'`,
            WorkflowErrorCode.INVALID_YAML,
          );
        }
      } else if (n.script !== undefined && n.script !== null) {
        // 非 SlurmNode 工具：禁止 script 字段，避免用户误用
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): non-slurm tool '${n.tool}' does not support 'script' field`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
```

然后在同一 case 的 `return { ... }` 对象里，在 `slurm: parseSlurmConfig(n.slurm),` 之后加一行：

```typescript
        script: parseScriptConfig(n.script, n.id as string),
```

完整的 return 对象应该是（仅展示改动行）：

```typescript
      return {
        ...base,
        type: "custom",
        tool: n.tool as string,
        inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
        slurm: parseSlurmConfig(n.slurm),
        script: parseScriptConfig(n.script, n.id as string),
        outputs: parseOutputs(n.outputs),
        foreach: typeof n.foreach === "string" ? n.foreach : undefined,
        maxConcurrent: typeof n.maxConcurrent === "number" ? n.maxConcurrent : undefined,
        continueOnError: typeof n.continueOnError === "boolean" ? n.continueOnError : undefined,
      };
```

- [ ] **Step 5: 运行测试，验证全部通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts 2>&1 | tail -15`
Expected: PASS — 所有测试通过（新增 5 个 + 原有的）

- [ ] **Step 6: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add packages/workflow-engine/src/parser/yaml-parser.ts \
        packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow-engine): yaml 解析器支持 script 字段

- 新增 parseScriptConfig：content 必填、env 宽容处理非字符串 value
- parseNode 根据 tool.kind 严格校验：slurm 工具必填 script，非 slurm 禁止 script
- 测试 createFakeRegistry 升级支持 kind 参数

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: resolveNodeInputs 增加 script 表达式求值（TDD）

**Files:**
- Modify: `packages/workflow-engine/src/scheduler/dag-scheduler.ts`
- Test: `packages/workflow-engine/src/__tests__/scheduler/dag-scheduler.test.ts`

- [ ] **Step 1: 写失败测试 — script.content 和 script.env 求值**

打开 `packages/workflow-engine/src/__tests__/scheduler/dag-scheduler.test.ts`，先看文件顶部已有的测试结构（找到 custom 节点相关测试的位置）。在文件末尾追加新测试：

```typescript
import type { CustomNodeDef } from "../../types/dag";

// ── resolveNodeInputs 对 custom 节点 script 字段的求值 ──

test("custom 节点 script.content 表达式被求值", async () => {
  // 用一个简化的方式：直接构造 CustomNodeDef，验证调度器在执行时
  // 把求值后的 script 传给 executor。
  // 本测试用 fake custom executor 捕获 ExecuteContext.script
  const capturedScript: Array<{ content: string; env: Record<string, string> } | undefined> = [];

  // 直接构造 DAG：单 custom 节点 + params
  const yaml = `\
schema_version: '1'
name: test-script-resolve
params:
  work_dir:
    type: string
    default: /data/test
  cores:
    type: number
    default: 8
nodes:
  - id: job1
    type: custom
    tool: slurm
    script:
      content: |
        echo "workdir=${{ params.work_dir }}"
      env:
        WORK_DIR: ${{ params.work_dir }}
        CORES: ${{ params.cores }}
    outputs:
      out:
        pattern: /tmp/out
        type: file
`;

  // 这里用完整 WorkflowEngine 跑一遍最准确，但工作量大。
  // 替代方案：直接测试 resolveNodeInputs（如果是私有方法，可通过执行一个
  // 记录 ctx 的 fake 工具来间接验证）。
  // 下面采用"注册捕获型 fake slurm 工具"的方式：

  // 注：完整端到端验证在 Task 6（custom-executor 测试）做。
  // 这里只验证 resolveNodeInputs 行为：通过运行一个 slurm-kind 的 fake 工具，
  // 捕获它收到的 ctx.script。
  const { CustomNodeRegistry } = await import("../../plugins/registry");
  const { CustomNodeExecutor } = await import("../../plugins/custom-executor");

  const registry = new CustomNodeRegistry();
  registry.register({
    name: "slurm",
    description: "fake slurm",
    inputs: {},
    produces: ["*"],
    kind: "slurm",
    execute: async (ctx) => {
      capturedScript.push(ctx.script);
      return { stdout: "ok", exit_code: 0, size: 2 };
    },
  } as unknown as import("../../plugins/types").CustomNode);

  // 解析 yaml 得到 CustomNodeDef
  const { parseWorkflowYaml } = await import("../../parser/yaml-parser");
  const def = parseWorkflowYaml(yaml, undefined, { customRegistry: registry });
  const customDef = def.nodes[0] as CustomNodeDef;

  // 直接构造 executor + ctx，跳过完整调度器
  // 关键：resolvedInputs 需要手动构造（因为 resolveNodeInputs 是私有方法，
  // 我们通过等价的 resolveInputs/resolveTemplate 调用来模拟）
  const { resolveInputs } = await import("../../parser/inputs-resolver");
  const { resolveTemplate } = await import("../../parser/expression-parser");

  // 简化：手动复现 resolveNodeInputs 的 custom 分支逻辑
  const evalContext = {
    params: { work_dir: "/data/test", cores: 8 },
    secrets: {},
    nodes: {},
  };

  const resolvedScript = {
    content: resolveTemplate(customDef.script!.content, evalContext),
    env: Object.fromEntries(
      Object.entries(customDef.script!.env!).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
    ),
  };

  expect(resolvedScript.content).toContain('workdir=/data/test');
  expect(resolvedScript.env.WORK_DIR).toBe("/data/test");
  expect(resolvedScript.env.CORES).toBe("8"); // resolveTemplate 强制 string
});
```

注意：由于 `resolveNodeInputs` 是 `DagScheduler` 的私有方法，测试通过直接调用 `resolveTemplate` 来等价验证逻辑。完整的端到端验证在 Task 6 通过 custom-executor 测试覆盖。

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/scheduler/dag-scheduler.test.ts -t "script.content 表达式被求值" 2>&1 | tail -20`
Expected: 这个测试可能直接通过（因为它不依赖调度器改造，只是验证 resolveTemplate 行为）。如果通过了，是因为测试设计不严格——我们需要在 Step 3 实施改造后，通过 Task 6 的端到端测试来保证。

如果 Step 1 的测试通过了（没失败），就跳到 Step 3 直接做改造。如果失败了，先排查原因。

实际上这个 Step 1 测试的目的是建立 baseline——记录"现在 resolveTemplate 能正确处理表达式"。真正的行为验证在 Task 6 的 custom-executor 端到端测试。

- [ ] **Step 3: 在 dag-scheduler.ts 的 case "custom" 增加 script 求值**

打开 `packages/workflow-engine/src/scheduler/dag-scheduler.ts`，找到 `resolveNodeInputs` 的 `case "custom":` 分支（约第 428-435 行）。整体替换为：

```typescript
      case "custom": {
        // Custom 节点：通过 inputs 注入上游数据，executor 内做 Zod 校验
        const customNode = node as import("../types/dag").CustomNodeDef;
        if (customNode.inputs) {
          resolved.inputs = resolveInputs(customNode.inputs, evalContext);
        }
        // 新增：script 求值（仅 SlurmNode 子类会声明 script 字段，解析器已校验）
        if (customNode.script) {
          resolved.script = {
            // content: 走 resolveTemplate（拼接模式，结果始终是 string）
            content: resolveTemplate(customNode.script.content, evalContext),
            // env: 遍历每个 value 走 resolveTemplate，统一转 string
            env: customNode.script.env
              ? Object.fromEntries(
                  Object.entries(customNode.script.env).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
                )
              : {},
          };
        }
        break;
      }
```

- [ ] **Step 4: 运行测试，验证不破坏现有功能**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/ 2>&1 | tail -10`
Expected: PASS — 所有现有测试通过（dag-scheduler 改造是新增分支，不影响现有行为）

- [ ] **Step 5: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add packages/workflow-engine/src/scheduler/dag-scheduler.ts \
        packages/workflow-engine/src/__tests__/scheduler/dag-scheduler.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow-engine): 调度器求值 custom 节点的 script 表达式

resolveNodeInputs 的 custom 分支新增 script 求值：
- content 走 resolveTemplate（拼接模式，结果 string）
- env 每个 value 走 resolveTemplate（统一转 string）

求值结果注入 resolvedInputs.script，由 custom-executor 透传到 ExecuteContext。

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: custom-executor 透传 script 到 ExecuteContext（TDD）

**Files:**
- Modify: `packages/workflow-engine/src/plugins/custom-executor.ts`
- Test: `packages/workflow-engine/src/__tests__/executor/custom-executor.test.ts`

- [ ] **Step 1: 写失败测试 — executor 透传 script 到 ExecuteContext**

打开 `packages/workflow-engine/src/__tests__/executor/custom-executor.test.ts`，在文件末尾追加：

```typescript
// ========== script 字段透传（SlurmNode 子类场景） ==========

test("executor 把 resolvedInputs.script 透传到 ExecuteContext.script", async () => {
  const registry = new CustomNodeRegistry();
  let capturedCtx: ExecuteContext | null = null;
  registry.register({
    name: "fake_slurm",
    description: "fake slurm tool",
    inputs: {},
    produces: ["*"],
    kind: "slurm",
    execute: async (ctx) => {
      capturedCtx = ctx;
      return { stdout: "ok", exit_code: 0, size: 2 };
    },
  } as unknown as CustomNode);

  const executor = new CustomNodeExecutor(registry);
  const ctx = makeCtx({
    resolvedInputs: {
      script: {
        content: "echo hello",
        env: { WORK_DIR: "/data", CORES: "8" },
      },
    },
  });
  const node = customNode("fake_slurm", {
    script: { content: "echo hello", env: { WORK_DIR: "/data" } },
  });

  await executor.execute(node, ctx);

  expect(capturedCtx).not.toBeNull();
  expect(capturedCtx!.script).toBeDefined();
  expect(capturedCtx!.script?.content).toBe("echo hello");
  expect(capturedCtx!.script?.env.WORK_DIR).toBe("/data");
  expect(capturedCtx!.script?.env.CORES).toBe("8");
});

test("非 slurm 工具的 ExecuteContext.script 为 undefined", async () => {
  const registry = new CustomNodeRegistry();
  let capturedCtx: ExecuteContext | null = null;
  registry.register(
    makeFakeTool({
      name: "plain_tool",
      executeFn: async (ctx) => {
        capturedCtx = ctx;
        return { stdout: "ok", exit_code: 0, size: 2 };
      },
    }),
  );

  const executor = new CustomNodeExecutor(registry);
  const ctx = makeCtx(); // resolvedInputs 不含 script
  const node = customNode("plain_tool");

  await executor.execute(node, ctx);

  expect(capturedCtx).not.toBeNull();
  expect(capturedCtx!.script).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/custom-executor.test.ts -t "resolvedInputs.script 透传" 2>&1 | tail -20`
Expected: FAIL — `capturedCtx.script` 为 undefined（executor 还没有透传逻辑）

- [ ] **Step 3: 在 custom-executor.ts 透传 script**

打开 `packages/workflow-engine/src/plugins/custom-executor.ts`，找到 `// 4. 构建 ExecuteContext` 注释下的 `const execCtx: ExecuteContext = { ... }`（约第 80-91 行），在 `slurm: customDef.slurm,` 之后加一行：

```typescript
    // 透传已求值的 script（仅 SlurmNode 子类会有值，由调度器 resolveNodeInputs 求值后注入）
    script: (ctx.resolvedInputs.script as ExecuteContext["script"]) ?? undefined,
```

完整的 execCtx 对象（仅展示改动行）：

```typescript
    const execCtx: ExecuteContext = {
      inputs: resolvedInputs,
      params: ctx.params,
      secrets: ctx.secrets,
      workDir: (ctx.params.work_dir as string) ?? "/tmp/workflow",
      slurm: customDef.slurm,
      script: (ctx.resolvedInputs.script as ExecuteContext["script"]) ?? undefined,
      signal: ctx.signal,
      storage: ctx.storage,
      runId: ctx.runId,
      nodeId: node.id,
    };
```

- [ ] **Step 4: 运行测试，验证全部通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/custom-executor.test.ts 2>&1 | tail -10`
Expected: PASS — 所有测试通过

- [ ] **Step 5: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add packages/workflow-engine/src/plugins/custom-executor.ts \
        packages/workflow-engine/src/__tests__/executor/custom-executor.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow-engine): custom-executor 透传 script 到 ExecuteContext

把调度器求值后的 resolvedInputs.script 透传到 ExecuteContext.script，
SlurmNode.buildScript/generateHeader 通过此字段读取脚本内容与环境变量。

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: tools/slurm.ts inputs 改为 {}

**Files:**
- Modify: `tools/slurm.ts`

- [ ] **Step 1: 改造 tools/slurm.ts**

打开 `tools/slurm.ts`，整体替换为：

```typescript
/**
 * 通用 Slurm 工具 — 唯一的 custom tool，所有 HPC 作业统一走它。
 *
 * 设计哲学：工具层不耦合任何业务（不再为 trim_galore / salmon / star 等单独写 TS 子类）。
 * 脚本内容由 YAML 节点的 `script.content` 注入，环境变量由 `script.env` 声明，
 * Slurm 资源由 YAML 节点的 `slurm:` 字段声明，
 * 引擎通过 ${{ }} 表达式把 params / 上游 outputs 求值后拼进脚本。
 *
 * 一个节点 = 一段 bash 脚本 + 一组资源声明，引擎不再关心脚本里跑的是什么工具。
 *
 * YAML 示例：
 *   - id: trim_galore
 *     type: custom
 *     tool: slurm
 *     slurm:
 *       partition: xahcnormal
 *       cores: 4
 *       walltime: "02:00:00"
 *       modules: ["apps/apptainer/1.2.4"]
 *     script:
 *       content: |
 *         apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
 *           trim_galore --paired --cores 4 ...
 *       env:
 *         WORK_DIR: ${{ params.work_dir }}
 *     outputs:
 *       trimmed_r1:
 *         pattern: "${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz"
 *         type: file
 */
import type { InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class SlurmToolNode extends SlurmNode {
  name = "slurm";
  description = "通用 Slurm HPC 作业执行器：脚本内容由 script.content 注入，资源由 slurm 字段声明";

  // inputs 为空对象 — 通用 slurm 工具不声明任何 input 字段
  // 脚本内容由节点级 script.content 提供（由 SlurmNode.buildScript 默认实现读取）
  // YAML 用户如需声明上游数据绑定（用于前端连线），仍可在节点 inputs 里写字段，
  // 但通用工具不消费它们
  inputs: Record<string, InputDef> = {};

  /**
   * 通配符 outputs：YAML 节点可声明任意 outputs key（trimmed_r1 / bam / quant_sf / ...），
   * 引擎跳过严格 produces 校验，由用户在 YAML 自行保证 pattern 真实存在。
   */
  produces = ["*"];
}
```

- [ ] **Step 2: 运行 tsc 验证类型**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit 2>&1 | grep -i "tools/slurm" | head -10`
Expected: 无输出（无类型错误）

- [ ] **Step 3: 运行所有测试，确认未破坏**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/ 2>&1 | tail -10`
Expected: PASS — 所有测试通过

- [ ] **Step 4: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add tools/slurm.ts
git commit -m "$(cat <<'EOF'
chore(tools): 通用 slurm 工具 inputs 改为空对象

script 不再作为 input 字段，改由节点级 script.content 提供。
SlurmNode.buildScript 默认实现从 ctx.script.content 读取。

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 迁移 workflow-examples/pe-rna-seq-single-sample.yaml

**Files:**
- Modify: `workflow-examples/pe-rna-seq-single-sample.yaml`

11 步流程对应 8 个 yaml 节点（Galaxy 有的步骤合并为单节点）。8 个节点机械重构：`inputs.script: |` → `script: { content: | }`。在 `multiqc` 节点额外演示 `script.env` 用法。

- [ ] **Step 1: 更新 yaml 顶部注释**

打开 `workflow-examples/pe-rna-seq-single-sample.yaml`，找到顶部注释块（约第 27-29 行）：

```yaml
# 工具抽象说明：所有节点统一用 tool: slurm（通用 Slurm 执行器），
# 脚本内容由 inputs.script 注入，资源由 slurm: 字段声明。
# cores 值通过 $SLURM_CPUS_PER_TASK 环境变量自动传入脚本（Slurm 标准实践）。
```

修改为：

```yaml
# 工具抽象说明：所有节点统一用 tool: slurm（通用 Slurm 执行器），
# 脚本内容由 script.content 注入，资源由 slurm: 字段声明。
# cores 值通过 $SLURM_CPUS_PER_TASK 环境变量自动传入脚本（Slurm 标准实践）。
```

- [ ] **Step 2: 迁移 trim_galore 节点**

找到 trim_galore 节点（约第 110-140 行），把它从：

```yaml
  - id: trim_galore
    type: custom
    tool: slurm
    description: ④ Trim Galore 接头切除与质控
    depends_on: []
    slurm:
      partition: xahcnormal
      cores: 4
      walltime: "02:00:00"
      modules: ["apps/apptainer/1.2.4"]
    inputs:
      script: |
        echo "=== Trim Galore - ${{ params.sample_id }} ==="
        mkdir -p ${{ params.work_dir }}/step_4
        apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
          trim_galore --paired --cores "$SLURM_CPUS_PER_TASK" \
            --output_dir ${{ params.work_dir }}/step_4 --gzip \
            ${{ params.sample_r1 }} ${{ params.sample_r2 }}

        # 输出校验：trim_galore 命名规则为 {sample}_1_val_1.fq.gz / {sample}_2_val_2.fq.gz
        R1_OUT="${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz"
        R2_OUT="${{ params.work_dir }}/step_4/${{ params.sample_id }}_2_val_2.fq.gz"
        test -s "$R1_OUT" || { echo "ERROR: $R1_OUT missing or empty" >&2; exit 1; }
        test -s "$R2_OUT" || { echo "ERROR: $R2_OUT missing or empty" >&2; exit 1; }
    outputs:
      trimmed_r1:
        pattern: "${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz"
        type: file
      trimmed_r2:
        pattern: "${{ params.work_dir }}/step_4/${{ params.sample_id }}_2_val_2.fq.gz"
        type: file
```

改为（`inputs:` 删除，`script:` 顶层 + `content: |` 子字段，脚本正文多缩进 2 空格）：

```yaml
  - id: trim_galore
    type: custom
    tool: slurm
    description: ④ Trim Galore 接头切除与质控
    depends_on: []
    slurm:
      partition: xahcnormal
      cores: 4
      walltime: "02:00:00"
      modules: ["apps/apptainer/1.2.4"]
    script:
      content: |
        echo "=== Trim Galore - ${{ params.sample_id }} ==="
        mkdir -p ${{ params.work_dir }}/step_4
        apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
          trim_galore --paired --cores "$SLURM_CPUS_PER_TASK" \
            --output_dir ${{ params.work_dir }}/step_4 --gzip \
            ${{ params.sample_r1 }} ${{ params.sample_r2 }}

        # 输出校验：trim_galore 命名规则为 {sample}_1_val_1.fq.gz / {sample}_2_val_2.fq.gz
        R1_OUT="${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz"
        R2_OUT="${{ params.work_dir }}/step_4/${{ params.sample_id }}_2_val_2.fq.gz"
        test -s "$R1_OUT" || { echo "ERROR: $R1_OUT missing or empty" >&2; exit 1; }
        test -s "$R2_OUT" || { echo "ERROR: $R2_OUT missing or empty" >&2; exit 1; }
    outputs:
      trimmed_r1:
        pattern: "${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz"
        type: file
      trimmed_r2:
        pattern: "${{ params.work_dir }}/step_4/${{ params.sample_id }}_2_val_2.fq.gz"
        type: file
```

- [ ] **Step 3: 迁移 flatten 节点**

找到 flatten 节点（约第 142-161 行），从：

```yaml
    inputs:
      script: |
        echo "=== Flatten collection - ${{ params.sample_id }} ==="
        echo "Started at: $(date)"
        echo ok
        echo "Finished at: $(date)"
```

改为：

```yaml
    script:
      content: |
        echo "=== Flatten collection - ${{ params.sample_id }} ==="
        echo "Started at: $(date)"
        echo ok
        echo "Finished at: $(date)"
```

（脚本正文 4 行各缩进 2 空格）

- [ ] **Step 4: 迁移 salmon_quant 节点**

找到 salmon_quant 节点（约第 163-198 行），从：

```yaml
    inputs:
      script: |
        echo "=== Salmon quant ==="
        ...
```

改为：

```yaml
    script:
      content: |
        echo "=== Salmon quant ==="
        ...
```

（整段脚本正文每行缩进 2 空格）

- [ ] **Step 5: 迁移 rna_star 节点**

找到 rna_star 节点（约第 200-241 行），同样的模式：`inputs:\n      script: |` → `script:\n      content: |`，脚本正文每行多缩进 2 空格。

- [ ] **Step 6: 迁移 fastqc 节点**

找到 fastqc 节点（约第 243-275 行），同样的模式迁移。

- [ ] **Step 7: 迁移 featurecounts 节点**

找到 featurecounts 节点（约第 277-308 行），同样的模式迁移。

- [ ] **Step 8: 迁移 multiqc 节点（额外演示 env 用法）**

找到 multiqc 节点（约第 310-348 行），从：

```yaml
  - id: multiqc
    type: custom
    tool: slurm
    description: ⑩ MultiQC 全流程质控汇总
    depends_on: [salmon_quant, rna_star, fastqc, featurecounts]
    slurm:
      partition: xahcnormal
      cores: 8
      walltime: "01:00:00"
      modules: ["apps/apptainer/1.2.4"]
    inputs:
      script: |
        echo "=== MultiQC ==="
        echo "Started at: $(date)"
        OUT_DIR="${{ params.work_dir }}/step_10"
        # 精确指定扫描目录，避免纳入历史残留（design.md §5.5）
        mkdir -p "$OUT_DIR"
        # MultiQC 会把标题中的空格替换为 -，影响输出文件名
        TITLE="PE RNA-Seq Workflow Report"
        apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
          multiqc \
            ${{ params.work_dir }}/step_4 \
            ${{ params.work_dir }}/step_6 \
            ${{ params.work_dir }}/step_7 \
            ${{ params.work_dir }}/step_8 \
            ${{ params.work_dir }}/step_9 \
            --outdir "$OUT_DIR" \
            --title "$TITLE"

        # 输出校验（标题空格→连字符，文件名为 PE-RNA-Seq-Workflow-Report_multiqc_report.html）
        REPORT="$OUT_DIR/PE-RNA-Seq-Workflow-Report_multiqc_report.html"
        test -s "$REPORT" || { echo "ERROR: $REPORT missing or empty" >&2; exit 1; }
        echo "Finished at: $(date)"
    outputs:
      report:
        pattern: "${{ params.work_dir }}/step_10/PE-RNA-Seq-Workflow-Report_multiqc_report.html"
        type: file
```

改为（把 `${{ params.work_dir }}` 抽到 `WORK_DIR` env，脚本里用 `$WORK_DIR`）：

```yaml
  - id: multiqc
    type: custom
    tool: slurm
    description: ⑩ MultiQC 全流程质控汇总
    depends_on: [salmon_quant, rna_star, fastqc, featurecounts]
    slurm:
      partition: xahcnormal
      cores: 8
      walltime: "01:00:00"
      modules: ["apps/apptainer/1.2.4"]
    script:
      content: |
        echo "=== MultiQC ==="
        echo "Started at: $(date)"
        # 精确指定扫描目录，避免纳入历史残留（design.md §5.5）
        mkdir -p "$WORK_DIR/step_10"
        # MultiQC 会把标题中的空格替换为 -，影响输出文件名
        TITLE="PE RNA-Seq Workflow Report"
        apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
          multiqc \
            "$WORK_DIR/step_4" \
            "$WORK_DIR/step_6" \
            "$WORK_DIR/step_7" \
            "$WORK_DIR/step_8" \
            "$WORK_DIR/step_9" \
            --outdir "$WORK_DIR/step_10" \
            --title "$TITLE"

        # 输出校验（标题空格→连字符，文件名为 PE-RNA-Seq-Workflow-Report_multiqc_report.html）
        REPORT="$WORK_DIR/step_10/PE-RNA-Seq-Workflow-Report_multiqc_report.html"
        test -s "$REPORT" || { echo "ERROR: $REPORT missing or empty" >&2; exit 1; }
        echo "Finished at: $(date)"
      env:
        WORK_DIR: ${{ params.work_dir }}
    outputs:
      report:
        pattern: "${{ params.work_dir }}/step_10/PE-RNA-Seq-Workflow-Report_multiqc_report.html"
        type: file
```

- [ ] **Step 9: 迁移 column_join 节点**

找到 column_join 节点（约第 350-386 行），同样的模式：`inputs:\n      script: |` → `script:\n      content: |`，脚本正文每行多缩进 2 空格。

- [ ] **Step 10: 验证 yaml 能被正确解析**

写一个临时验证脚本：

Run:
```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun -e "
import { parseWorkflowYaml } from './packages/workflow-engine/src/parser/yaml-parser.ts';
import { CustomNodeRegistry } from './packages/workflow-engine/src/plugins/registry.ts';
import fs from 'node:fs';

const registry = new CustomNodeRegistry();
// 临时注册 slurm 工具（kind: 'slurm'）供解析校验
registry.register({
  name: 'slurm',
  description: 'fake for parse test',
  inputs: {},
  produces: ['*'],
  kind: 'slurm',
  execute: async () => ({ stdout: '', exit_code: 0 }),
});

const yaml = fs.readFileSync('./workflow-examples/pe-rna-seq-single-sample.yaml', 'utf-8');
const def = parseWorkflowYaml(yaml, undefined, { customRegistry: registry });
console.log('解析成功，节点数:', def.nodes.length);
for (const n of def.nodes) {
  if (n.type === 'custom') {
    console.log('  -', n.id, '| script.content:', n.script?.content?.split('\n')[0]?.trim(), '| env keys:', Object.keys(n.script?.env ?? {}));
  }
}
"
```

Expected: 输出 `解析成功，节点数: 8`（trim_galore/flatten/salmon_quant/rna_star/fastqc/featurecounts/multiqc/column_join 共 8 个节点），每个节点的 script.content 第一行（如 "echo "=== Trim Galore..."）和 env keys（multiqc 显示 `['WORK_DIR']`，其他节点显示 `[]`）

如果出现错误，根据错误信息修正对应节点的缩进或字段名。

- [ ] **Step 11: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add workflow-examples/pe-rna-seq-single-sample.yaml
git commit -m "$(cat <<'EOF'
chore(workflow-examples): 迁移 pe-rna-seq 到新 script 字段

8 个 slurm 节点从 inputs.script 迁移到 script.content，
multiqc 节点演示 script.env 用法（抽出 WORK_DIR 环境变量提升可读性）。

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 全量回归 + precheck

**Files:** 无（仅验证）

- [ ] **Step 1: 运行 workflow-engine 全部测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/ 2>&1 | tail -15`
Expected: PASS — 所有测试通过

- [ ] **Step 2: 运行 precheck（格式化 + import 排序 + tsc + biome）**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck 2>&1 | tail -30`
Expected: PASS（precheck 会自动修复格式和 import 排序）

如果 precheck 失败：
- 格式问题：让 precheck 的 `biome format --write` 自动修复
- import 排序问题：让 precheck 的 `biome check --write --linter-enabled=false` 自动修复
- tsc 错误：根据错误信息修正
- biome 错误：根据错误信息修正（注意不要对 biome-ignore 行做 --write 自动修复）

如果 precheck 自动修复了文件，需要再次 commit：

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git status  # 看哪些文件被自动修复
git add <被修复的文件>
git commit -m "$(cat <<'EOF'
chore: precheck 自动修复格式与 import 排序

Co-authored-by: Claude <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: 再次运行全量测试验证**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/ src/__tests__/ 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 4: 验证 workflow-examples yaml 仍可解析（回归）**

Run:
```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun -e "
import { parseWorkflowYaml } from './packages/workflow-engine/src/parser/yaml-parser.ts';
import { CustomNodeRegistry } from './packages/workflow-engine/src/plugins/registry.ts';
import fs from 'node:fs';

const registry = new CustomNodeRegistry();
registry.register({
  name: 'slurm',
  description: 'fake for parse test',
  inputs: {},
  produces: ['*'],
  kind: 'slurm',
  execute: async () => ({ stdout: '', exit_code: 0 }),
});

const yaml = fs.readFileSync('./workflow-examples/pe-rna-seq-single-sample.yaml', 'utf-8');
const def = parseWorkflowYaml(yaml, undefined, { customRegistry: registry });
console.log('OK 节点数:', def.nodes.length);
"
```
Expected: `OK 节点数: 8`

---

## Self-Review 检查清单

实施完所有 Task 后，对照本清单做最终验证：

**Spec 覆盖率**：
- [ ] §2.1 ScriptDef 类型 → Task 1 Step 1 ✅
- [ ] §2.2 CustomNode.kind → Task 1 Step 2 ✅
- [ ] §2.3 ExecuteContext.script → Task 1 Step 3 ✅
- [ ] §2.4 CustomNodeDef.script → Task 1 Step 4 ✅
- [ ] §3.1 parseScriptConfig → Task 4 Step 3 ✅
- [ ] §3.2 parseNode kind 校验 → Task 4 Step 4 ✅
- [ ] §4.1 resolveNodeInputs script 求值 → Task 5 Step 3 ✅
- [ ] §4.2 custom-executor 透传 → Task 6 Step 3 ✅
- [ ] §5.1 SlurmNode.kind + buildScript → Task 2 Step 3-4 ✅
- [ ] §5.2 generateHeader --export → Task 3 Step 3 ✅
- [ ] §6 tools/slurm.ts inputs = {} → Task 7 Step 1 ✅
- [ ] §7 yaml 迁移 → Task 8 ✅
- [ ] §8 测试策略 → Task 2/3/4/6 新增测试 ✅

**类型一致性**：
- [ ] ScriptDef 类型（slurm-types.ts）与 CustomNodeDef.script 内联类型一致（都是 `{ content: string; env?: Record<string, string> }`）→ Task 1 ✅
- [ ] ExecuteContext.script 内联类型是 `{ content: string; env: Record<string, string> }`（env 求值后必填）→ Task 1 ✅
- [ ] parseScriptConfig 返回 `CustomNodeDef["script"]` 类型 → Task 4 ✅
- [ ] resolveNodeInputs 的 script 分支产出 `{ content: string; env: Record<string, string> }` → Task 5 ✅

**运行时一致性**：
- [ ] yaml-parser 检测到 SlurmNode 子类（kind="slurm"）必填 script → Task 4 ✅
- [ ] 调度器对 script.content 走 resolveTemplate（结果 string）→ Task 5 ✅
- [ ] 调度器对 script.env 每个 value 走 resolveTemplate → Task 5 ✅
- [ ] executor 透传 resolvedInputs.script 到 ExecuteContext → Task 6 ✅
- [ ] SlurmNode.buildScript 默认读 ctx.script.content → Task 2 ✅
- [ ] SlurmNode.generateHeader 在 --error 之后注入 --export=ALL,... → Task 3 ✅

完成所有 Task 后，整个改造闭环：
- 类型层（Task 1）→ 工具层（Task 2/3）→ 解析层（Task 4）→ 调度层（Task 5）→ 执行层（Task 6）→ 应用层（Task 7/8）→ 回归（Task 9）
