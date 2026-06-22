# Slurm 节点 script 字段独立化 — 从 `inputs.script` 提升为节点级字段

> Design — 演进 [SlurmNode 设计](./2026-06-18-slurm-node-design.md)。
>
> 2026-06-22 · `packages/workflow-engine/` + `tools/` + `workflow-examples/`

---

## 1. 概述

### 1.1 做什么

把 Slurm 节点的脚本内容从 `inputs.script`（一个 input 字段）提升为节点级独立字段 `script.content`，并新增 `script.env` 子字段用于声明作业环境变量。

### 1.2 为什么

当前 `inputs.script` 的设计混淆了两个语义层级：

- **inputs**：上游数据绑定（表达式字符串映射，由调度器求值后注入 `ctx.inputs`），属于「数据流」抽象
- **script**：作业内容（bash 代码 + 环境变量），属于「作业声明」抽象

把 script 塞进 inputs 导致：
1. 语义混淆 — 通用 slurm 工具的 `inputs = { script: ... }` 看起来像「需要一个上游数据叫 script」，但实际上它是节点自包含的脚本声明
2. 无法扩展环境变量 — 想加 `env` 只能再塞一个 `inputs.env`，但 env 是 key-value 映射而非表达式字符串，类型与 `Record<string, string>` inputs 不兼容
3. 与 `slurm:` 字段不对称 — `slurm` 已经是节点级独立字段（partition/cores/...），script 应该享受同等待遇

### 1.3 改造后的字段语义边界

| 字段 | 角色 | 消费者 |
|------|------|--------|
| `slurm` | 作业资源（partition/cores/memory/walltime/modules/...） | `SlurmNode.generateHeader()` |
| `script` | 作业内容（bash 代码 + 环境变量） | `SlurmNode.buildScript()` + `SlurmNode.generateHeader()` |
| `inputs` | 上游数据绑定（表达式字符串，与其他节点一致） | 工具自己（通用 slurm 工具 inputs 为 `{}`） |

### 1.4 改造范围

```
packages/workflow-engine/src/types/dag.ts              # CustomNodeDef 新增 script 字段
packages/workflow-engine/src/plugins/types.ts          # CustomNode 新增 kind; ExecuteContext 新增 script 字段
packages/workflow-engine/src/plugins/slurm-types.ts    # 新增 ScriptDef
packages/workflow-engine/src/parser/yaml-parser.ts     # parseScriptConfig + kind 判断
packages/workflow-engine/src/scheduler/dag-scheduler.ts# resolveNodeInputs 增加 script 求值
packages/workflow-engine/src/plugins/custom-executor.ts# 透传 resolved script 到 ExecuteContext
packages/workflow-engine/src/plugins/slurm-node.ts     # buildScript + generateHeader 改造 + kind 标记
tools/slurm.ts                                          # 删除 inputs.script 声明，inputs 改为 {}
workflow-examples/pe-rna-seq-single-sample.yaml        # 11 节点迁移到新写法
```

**硬切换策略**：不保留 `inputs.script` 旧写法的兼容（用户已同意）。现有 YAML 必须迁移。

---

## 2. 核心类型

### 2.1 `ScriptDef`（新增，`packages/workflow-engine/src/plugins/slurm-types.ts`）

```typescript
/** Slurm 作业脚本声明 — YAML 中 script 字段的结构 */
export interface ScriptDef {
  /** bash 脚本正文，支持 ${{ }} 表达式。不要写 #SBATCH 指令，header 由 generateHeader 生成 */
  content: string;
  /** 额外环境变量，注入到 #SBATCH --export。value 支持 ${{ }} 表达式 */
  env?: Record<string, string>;
}
```

放在 `slurm-types.ts` 而非通用的 `types.ts`，因为 script 仅 SlurmNode 子类消费（见 §1.3 字段语义边界）。

### 2.2 `CustomNode` 新增 `kind` discriminator（`packages/workflow-engine/src/plugins/types.ts`）

```typescript
export interface CustomNode {
  // ... 已有字段不变 ...
  /** 输入字段声明 */
  inputs: Record<string, InputDef>;
  /** 输出字段名列表 */
  produces: string[];

  /**
   * 工具族标记，用于 yaml 解析器判断支持哪些节点级字段。
   * - "default": 普通 CustomNode，不支持 script/slurm 字段
   * - "slurm": SlurmNode 子类，必须声明 script 字段，可选声明 slurm 字段
   * 未来扩展其他基类（DockerNode/K8sNode）时新增枚举值。
   */
  kind?: "default" | "slurm";

  /** 核心执行方法 */
  execute(ctx: ExecuteContext): Promise<NodeOutput>;
  onCleanup?(ctx: ExecuteContext, result: NodeOutput | null, error: Error | null): Promise<void>;
}
```

### 2.3 `ExecuteContext` 新增 `script` 字段（`packages/workflow-engine/src/plugins/types.ts`）

```typescript
export interface ExecuteContext {
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  workDir: string;
  slurm?: Partial<SlurmConfig>;

  /**
   * 已求值的脚本声明（仅 SlurmNode 子类会有值）。
   * 由 dag-scheduler 求值 ${{ }} 表达式后填充：
   * - content: resolveTemplate 结果，始终是 string
   * - env: 遍历每个 value 走 resolveTemplate，结果 Record<string, string>
   * SlurmNode.buildScript/generateHeader 通过此字段读取。
   *
   * 类型上可选（非 Slurm 工具不会注入），但 SlurmNode.buildScript 在入口校验
   * ctx.script.content 必填，运行时报 NODE_FAILED。
   */
  script?: {
    content: string;
    env: Record<string, string>;
  };

  signal: AbortSignal;
  storage: StorageAdapter;
  runId: string;
  nodeId: string;
  foreach?: { item: Record<string, unknown>; index: number };
}
```

### 2.4 `CustomNodeDef` 新增 `script` 字段（`packages/workflow-engine/src/types/dag.ts`）

```typescript
export interface CustomNodeDef extends BaseNodeDef {
  type: "custom";
  tool: string;
  /** 输入绑定，key 对应 CustomNode.inputs 的 key，value 为表达式字符串 */
  inputs?: Record<string, string>;
  /**
   * Slurm 资源声明（仅当 tool 是 SlurmNode 子类时生效）。
   * 字段会注入到 ExecuteContext.slurm，由 SlurmNode 合并到默认 slurmConfig。
   */
  slurm?: {
    partition?: string;
    cores?: number;
    nodes?: number;
    memory?: string;
    walltime?: string;
    modules?: string[];
    jobName?: string;
    extraSBATCH?: string[];
  };
  /**
   * Slurm 脚本声明（仅当 tool 是 SlurmNode 子类时生效）。
   * 由 parseScriptConfig 解析，dag-scheduler 求值 ${{ }} 表达式后注入 ExecuteContext.script。
   * SlurmNode 子类必须声明此字段（parseNode 校验），非 Slurm 工具禁止声明。
   */
  script?: {
    content: string;
    env?: Record<string, string>;
  };
  outputs: Record<string, { pattern: string; type: "file" | "file-list" | "dir" }>;
  foreach?: string;
  maxConcurrent?: number;
  continueOnError?: boolean;
}
```

YAML 层的字段是「未求值的原始表达式字符串」，和 `slurm:` 一样是声明层，求值在调度器。

---

## 3. YAML 解析器改造（`packages/workflow-engine/src/parser/yaml-parser.ts`）

### 3.1 新增 `parseScriptConfig`（对称于现有 `parseSlurmConfig`）

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

### 3.2 `parseNode` 的 `case "custom"` 注入 `script` + `kind` 校验

```typescript
case "custom": {
  // ... 已有的 tool / outputs 校验逻辑不变 ...

  const registry = opts?.customRegistry;
  const toolDef = registry?.get(n.tool);
  // ... 已有的 tool 存在性 / produces 校验 ...

  // 新增：根据 tool kind 判断是否允许/要求 script 和 slurm 字段
  const isSlurmTool = toolDef?.kind === "slurm";

  if (isSlurmTool) {
    // SlurmNode 子类：script 必填
    if (n.script === undefined || n.script === null) {
      throw new WorkflowError(
        `nodes[${index}] (${n.id}): slurm tool '${n.tool}' requires 'script.content'`,
        WorkflowErrorCode.INVALID_YAML,
      );
    }
  } else {
    // 非 SlurmNode 工具：禁止 script 字段，避免用户误用
    if (n.script !== undefined && n.script !== null) {
      throw new WorkflowError(
        `nodes[${index}] (${n.id}): non-slurm tool '${n.tool}' does not support 'script' field`,
        WorkflowErrorCode.INVALID_YAML,
      );
    }
  }

  return {
    ...base,
    type: "custom",
    tool: n.tool as string,
    inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
    slurm: parseSlurmConfig(n.slurm),
    script: parseScriptConfig(n.script, n.id as string),  // 新增
    outputs: parseOutputs(n.outputs),
    foreach: typeof n.foreach === "string" ? n.foreach : undefined,
    maxConcurrent: typeof n.maxConcurrent === "number" ? n.maxConcurrent : undefined,
    continueOnError: typeof n.continueOnError === "boolean" ? n.continueOnError : undefined,
  };
}
```

### 3.3 解析时序

```
YAML 源码
  ↓ yamlParse（core schema）
raw object
  ↓ parseNode（case "custom"）
  ↓   1. 校验 tool/outputs（已有）
  ↓   2. 通过 registry.get(tool) 拿 toolDef
  ↓   3. isSlurmTool = toolDef?.kind === "slurm"
  ↓   4. 若 isSlurmTool：parseScriptConfig 必填 + parseSlurmConfig 可选
  ↓      否则：禁止 script 字段（slurm 字段保留宽容处理，沿用现状）
CustomNodeDef { slurm?: Partial<SlurmConfig>; script?: { content, env }; inputs?: Record<string, string> }
```

---

## 4. 调度器与执行器

### 4.1 `resolveNodeInputs` 新增 script 求值（`packages/workflow-engine/src/scheduler/dag-scheduler.ts`）

```typescript
case "custom": {
  const customNode = node as import("../types/dag").CustomNodeDef;
  const resolved: Record<string, unknown> = {};

  // 已有：inputs 表达式求值（与其他节点语义一致）
  if (customNode.inputs) {
    resolved.inputs = resolveInputs(customNode.inputs, evalContext);
  }

  // 新增：script 求值（仅 SlurmNode 子类会声明 script 字段，解析器已校验）
  if (customNode.script) {
    resolved.script = {
      // content: 走 resolveTemplate（拼接模式，结果始终是 string）
      // 兼容用户在 content 里写纯表达式 ${{ params.x }} 或字符串拼接 ${{ a }}_${{ b }}
      content: resolveTemplate(customNode.script.content, evalContext),
      // env: 遍历每个 value 走 resolveTemplate，统一转 string
      env: customNode.script.env
        ? Object.fromEntries(
            Object.entries(customNode.script.env).map(([k, v]) => [k, resolveTemplate(v, evalContext)]),
          )
        : {},
    };
  }

  return resolved;
}
```

**为什么 `content` 走 `resolveTemplate` 而不是 `resolveInputs`？**

`resolveInputs` 是为 `Record<string, string>` 设计的，每个 value 独立求值，保留原始类型（`${{ params.count }}` 可能返回 number）。但 `script.content` 是单一大段 bash 代码，里面的 `${{ }}` 是字符串拼接，结果必须是 string。`resolveTemplate` 正是为此设计。

**`env` value 也走 `resolveTemplate`**：环境变量在 sbatch --export 里必须是字符串，即使 `${{ params.cores }}` 求值为 number 也要转成字符串。`resolveTemplate` 结果天然是 string，省去显式 `String()` 转换。

### 4.2 `custom-executor.ts` 透传 script 到 `ExecuteContext`

```typescript
// 4. 构建 ExecuteContext
const execCtx: ExecuteContext = {
  inputs: resolvedInputs,
  params: ctx.params,
  secrets: ctx.secrets,
  workDir: (ctx.params.work_dir as string) ?? "/tmp/workflow",
  slurm: customDef.slurm,
  // 新增：透传已求值的 script（仅 SlurmNode 子类会有值）
  script: (ctx.resolvedInputs.script as ExecuteContext["script"]) ?? undefined,
  signal: ctx.signal,
  storage: ctx.storage,
  runId: ctx.runId,
  nodeId: node.id,
};
```

`ctx.resolvedInputs.script` 是 `Record<string, unknown>` 里的一个 key，类型断言到 `ExecuteContext["script"]`。这里没有运行时校验——求值在调度器完成，executor 信任调度器。

### 4.3 错误传播路径

| 失败点 | 异常类型 | 触发位置 | 用户可见信息 |
|--------|---------|----------|-------------|
| `script.content` 表达式语法错误 | `WorkflowError(INVALID_EXPRESSION)` | `resolveTemplate` → `resolveNodeInputs` | 节点 id + 表达式片段 |
| `script.env[K]` 表达式错误 | 同上 | 同上 | key + 表达式片段 |
| `script.content` 求值后为空字符串 | `WorkflowError(NODE_FAILED)` | `SlurmNode.buildScript` | "requires 'script.content' (bash script content)" |
| 工具非 SlurmNode 子类但 YAML 写了 script | `WorkflowError(INVALID_YAML)` | `parseNode` | "non-slurm tool '...' does not support 'script' field" |
| SlurmNode 子类但 YAML 未写 script | `WorkflowError(INVALID_YAML)` | `parseNode` | "slurm tool '...' requires 'script.content'" |

所有错误都通过现有 `WorkflowError` 通道传播，前端在事件流（`node.failed`）和 dry-run 校验阶段都能看到。

### 4.4 foreach 场景

foreach 展开由调度器在 `resolveNodeInputs` 之前完成（每个迭代单元独立调一次 `resolveNodeInputs`），所以 `${{ foreach.item.xxx }}` 表达式在 script.content 里也能正常工作。本设计不需要为 foreach 特殊处理。

---

## 5. SlurmNode 内部改造（`packages/workflow-engine/src/plugins/slurm-node.ts`）

### 5.1 类标记 + `buildScript` 改读路径

```typescript
export abstract class SlurmNode implements CustomNode {
  abstract name: string;
  abstract description: string;
  abstract inputs: Record<string, InputDef>;
  abstract produces: string[];

  // 新增：用于 yaml-parser 判断是否是 SlurmNode 子类
  kind = "slurm" as const;

  slurmConfig: SlurmConfig = { partition: "xahcnormal", cores: 1 };
  pollInterval = 15000;
  maxRetries = 0;
  retryDelay = 30000;
  retryBackoff: "fixed" | "exponential" = "fixed";

  protected sshExecutor: SshExecutor;

  constructor(sshExecutor?: SshExecutor) {
    this.sshExecutor = sshExecutor ?? new BunSshExecutor();
  }

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

  // resolveSlurmConfig / preCleanup? / execute / onCleanup 等其他成员不变
}
```

### 5.2 `generateHeader` 注入 `#SBATCH --export`

新增注入位置：在 `--error` 之后、`extraSBATCH` 之前。理由：
- `--export` 属于 Slurm 作业资源配置，和 `--mem/--time` 同层级
- 放在 extraSBATCH 之前，让用户可以用 extraSBATCH 覆盖（如果他们需要更精细的控制）

```typescript
protected generateHeader(ctx: ExecuteContext): string {
  const config = this.resolveSlurmConfig(ctx);
  const jobName = config.jobName ?? this.name;
  const outDir = `${ctx.workDir}/.slurm`;

  const lines: string[] = [
    "#!/bin/bash",
    `#SBATCH --job-name=${jobName}`,
    `#SBATCH --partition=${config.partition}`,
    "#SBATCH --ntasks=1",
    `#SBATCH --cpus-per-task=${config.cores}`,
  ];

  if (config.nodes && config.nodes > 1) {
    lines.push(`#SBATCH --nodes=${config.nodes}`);
  }
  if (config.memory) {
    lines.push(`#SBATCH --mem=${config.memory}`);
  }
  if (config.walltime) {
    lines.push(`#SBATCH --time=${config.walltime}`);
  }

  lines.push(`#SBATCH --output=${outDir}/${jobName}_%j.out`);
  lines.push(`#SBATCH --error=${outDir}/${jobName}_%j.err`);

  // 新增：注入用户声明的环境变量到 #SBATCH --export
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

  if (config.extraSBATCH && config.extraSBATCH.length > 0) {
    for (const extra of config.extraSBATCH) {
      lines.push(`#SBATCH ${extra}`);
    }
  }

  // modules 作为 module load 命令放在 shebang 之后
  const moduleCmds =
    config.modules && config.modules.length > 0
      ? `${config.modules.map((m) => `module load ${m}`).join("\n")}\n`
      : "";

  return `${lines.join("\n")}\n${moduleCmds}`;
}
```

**关键约束**：
- `ALL` 前缀必须存在，否则 Slurm 丢弃默认环境变量，`module load` / `apptainer` 等会找不到
- env 为空对象或 undefined 时不输出 `--export` 行（保持现状，不污染 header）
- value 中的特殊字符（逗号、等号）不转义：sbatch 对此宽容，但用户写 `KEY=a,b=c` 会被解析为多个 entry。文档提醒，代码层不做转义（YAGNI）

---

## 6. 通用 slurm 工具改造（`tools/slurm.ts`）

```typescript
import type { InputDef } from "@fenix/workflow-engine";
import { SlurmNode } from "@fenix/workflow-engine";

export default class SlurmToolNode extends SlurmNode {
  name = "slurm";
  description = "通用 Slurm HPC 作业执行器：脚本内容由 script.content 注入，资源由 slurm 字段声明";

  // inputs 改为空对象 — 通用 slurm 工具不声明任何 input 字段
  // 脚本内容由节点级 script.content 提供，不再走 inputs 通道
  // YAML 用户如需声明上游数据绑定（用于前端连线），仍可在节点 inputs 里写字段，
  // 但通用工具不消费它们（SlurmNode.buildScript 默认只读 ctx.script.content）
  inputs: Record<string, InputDef> = {};

  produces = ["*"];
}
```

**「硬切换」的精确语义**：不在解析层（parseNode）主动检测旧写法，而是让旧 yaml 走到运行时由 `SlurmNode.buildScript` 自然报错。三层行为：

1. **解析层**：YAML 中 `inputs.script: |` 仍可解析（inputs 允许任意 key，不会报错）
2. **校验层**：`CustomNodeExecutor` 现有校验只检查「工具声明的 inputs 是否都提供了」，不检查「用户提供的额外 inputs」，所以 `inputs.script` 这种额外字段被接受但 ignored
3. **运行时层**：`SlurmNode.buildScript` 发现 `ctx.script` 为 undefined → 抛 NODE_FAILED，错误消息「requires 'script.content'」明确指向迁移目标

这样设计的好处是不需要在解析层维护「检测旧写法」的特殊逻辑（YAGNI），错误消息已经足够引导用户迁移。如果后续发现错误率偏高，可在 SlurmNode.buildScript 的错误消息里加一句「if you are migrating from `inputs.script`, move it to top-level `script.content`」进一步降低迁移摩擦。

---

## 7. YAML 迁移

### 7.1 迁移指引

```
迁移指引（inputs.script → script.content）：
1. 删除节点的 `inputs:` 行
2. 把 `inputs.script: |` 改为 `script:` 顶层字段
3. 在 `script:` 下添加 `content: |` 子字段
4. 脚本正文多缩进 2 空格（嵌入 content 下）
5. 可选：把常用的 ${{ params.xxx }} 抽到 script.env，提升可读性
```

### 7.2 `workflow-examples/pe-rna-seq-single-sample.yaml` 迁移

11 个节点全部机械重构。以 `trim_galore` 为例：

**改造前**：
```yaml
- id: trim_galore
  type: custom
  tool: slurm
  slurm:
    partition: xahcnormal
    cores: 4
  inputs:
    script: |
      echo "=== Trim Galore ==="
      apptainer exec ${{ params.sif }} trim_galore ...
```

**改造后**：
```yaml
- id: trim_galore
  type: custom
  tool: slurm
  slurm:
    partition: xahcnormal
    cores: 4
  script:
    content: |
      echo "=== Trim Galore ==="
      apptainer exec ${{ params.sif }} trim_galore ...
```

### 7.3 `script.env` 用法演示

为了演示 env 的实际价值，迁移时在 `multiqc` 节点改造时额外加上 env，把冗长的 `${{ params.work_dir }}` 抽到环境变量：

```yaml
- id: multiqc
  type: custom
  tool: slurm
  slurm:
    partition: xahcnormal
    cores: 8
    walltime: "01:00:00"
    modules: ["apps/apptainer/1.2.4"]
  script:
    content: |
      echo "=== MultiQC ==="
      mkdir -p "$WORK_DIR/step_10"
      apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
        multiqc \
          "$WORK_DIR/step_4" "$WORK_DIR/step_6" \
          "$WORK_DIR/step_7" "$WORK_DIR/step_8" "$WORK_DIR/step_9" \
          --outdir "$WORK_DIR/step_10" \
          --title "PE RNA-Seq Workflow Report"

      REPORT="$WORK_DIR/step_10/PE-RNA-Seq-Workflow-Report_multiqc_report.html"
      test -s "$REPORT" || { echo "ERROR: $REPORT missing or empty" >&2; exit 1; }
    env:
      WORK_DIR: ${{ params.work_dir }}
  outputs:
    report:
      pattern: "${{ params.work_dir }}/step_10/PE-RNA-Seq-Workflow-Report_multiqc_report.html"
      type: file
```

这样脚本里所有 `${{ params.work_dir }}` 替换为 `$WORK_DIR`，可读性显著提升。

---

## 8. 测试策略

### 8.1 现有测试复用率

现有 `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts` 的 `TestSlurmNode` 测试桩覆写了 `buildScript`，不依赖 `ctx.script`，**100% 复用**。

### 8.2 新增单元测试（`slurm-node.test.ts` 追加）

```typescript
// 默认 buildScript 从 ctx.script.content 读取
describe("SlurmNode.buildScript() default impl", () => {
  test("should return ctx.script.content when set", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const ctx = makeCtx({ script: { content: "echo hello", env: {} } });
    expect(node.buildScript(ctx)).toBe("echo hello");
  });

  test("should throw NODE_FAILED when ctx.script.content missing", async () => {
    class DefaultSlurmNode extends SlurmNode {
      name = "default";
      description = "test";
      inputs = {};
      produces = [];
    }
    const node = new DefaultSlurmNode();
    await expect(async () => node.buildScript(makeCtx())).toThrow(/requires 'script.content'/);
  });
});

// generateHeader 注入 #SBATCH --export
describe("SlurmNode.generateHeader() with env", () => {
  test("should append #SBATCH --export=ALL,... when ctx.script.env has entries", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const ctx = makeCtx({
      script: { content: "echo ok", env: { OMP_NUM_THREADS: "4", WORK_DIR: "/data" } },
    });
    const header = node.testGenerateHeader(ctx);
    expect(header).toContain("#SBATCH --export=ALL,OMP_NUM_THREADS=4,WORK_DIR=/data");
  });

  test("should NOT append #SBATCH --export when env is empty or missing", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const header1 = node.testGenerateHeader(makeCtx());
    const header2 = node.testGenerateHeader(
      makeCtx({ script: { content: "x", env: {} } }),
    );
    expect(header1).not.toContain("#SBATCH --export");
    expect(header2).not.toContain("#SBATCH --export");
  });

  test("should place --export before extraSBATCH", () => {
    const node = new TestSlurmNode({
      partition: "xahcnormal",
      cores: 4,
      extraSBATCH: ["--gres=gpu:1"],
    });
    const ctx = makeCtx({ script: { content: "x", env: { FOO: "bar" } } });
    const header = node.testGenerateHeader(ctx);
    const exportIdx = header.indexOf("#SBATCH --export");
    const extraIdx = header.indexOf("#SBATCH --gres=gpu:1");
    expect(exportIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeLessThan(extraIdx);
  });
});
```

### 8.3 新增解析器测试（`yaml-parser.test.ts` 追加）

```typescript
describe("parseWorkflowYaml custom script field", () => {
  test("should parse script.content + script.env for slurm tool", () => {
    // ... 构造含 script 字段的 YAML，验证解析结果
  });

  test("should require script.content for slurm tool", () => {
    // ... 缺 content → 抛 INVALID_YAML
  });

  test("should reject script field for non-slurm tool", () => {
    // ... 注册非 SlurmNode 工具，YAML 写 script → 抛 INVALID_YAML
  });

  test("should warn and skip non-string env value", () => {
    // ... env 含数字 value → 解析时 warn，结果 env 不含该 key
  });
});
```

### 8.4 新增集成测试（`custom-executor.test.ts` 追加）

验证端到端流程：
- 注册继承 SlurmNode 的测试工具（带 kind = "slurm"）
- 构造含 `script.content` + `script.env` 的 CustomNodeDef
- 验证 executor 把 `resolvedInputs.script` 透传到 `execCtx.script`
- 验证 SlurmNode.execute() 收到正确的 ctx.script

### 8.5 yaml 示例测试

如果有针对 `workflow-examples/pe-rna-seq-single-sample.yaml` 的解析冒烟测试（dry-run），迁移后需要确保仍能通过。

---

## 9. 设计决策

| # | 决策 | 选择 | 原因 |
|---|------|------|------|
| D1 | 兼容旧 `inputs.script` 写法 | 硬切换，不兼容 | 用户明确同意；保留兼容会让 buildScript 维护两条读取路径，复杂度增加 |
| D2 | `script` 字段位置 | 节点级顶层字段（与 `slurm:` 并列） | 语义对称，YAML 可读性好 |
| D3 | env 注入方式 | `#SBATCH --export=ALL,K=V,...` | Slurm 原生机制，作业环境合法可见，srun 内部子进程也能继承 |
| D4 | env 前缀 | `ALL,...` 而非 `K=V` 单独导出 | `ALL` 保证默认环境变量（PATH/HOME/SLURM_*）不丢失，避免 module load 找不到 |
| D5 | `script.content` 表达式求值方式 | `resolveTemplate`（拼接模式） | 脚本是多段 bash 代码，`${{ }}` 是字符串拼接，结果必须 string |
| D6 | `script.env` value 表达式求值方式 | 每个 value 走 `resolveTemplate` | 让动态注入（如 `WORK_DIR: ${{ params.work_dir }}`）可工作 |
| D7 | `script` 字段适用范围 | 仅 SlurmNode 子类 | 防止用户在普通 CustomNode 工具误用；与 `slurm:` 字段对称 |
| D8 | 判断 SlurmNode 子类的方式 | `CustomNode.kind` discriminator | 比 `instanceof` 解耦，未来扩展其他基类（DockerNode/K8sNode）可复用 |
| D9 | 通用 slurm 工具的 inputs | `{}` 空对象 | 不再声明 `script` 字段；保留 inputs 字段语义与其他节点一致，YAML 用户可自由声明用于前端连线 |
| D10 | `--export` 注入位置 | 在 `--error` 之后、`extraSBATCH` 之前 | 让用户可以用 `extraSBATCH` 覆盖（精细控制场景） |
| D11 | env value 特殊字符转义 | 不转义，文档提醒 | YAGNI；sbatch 对逗号/等号宽容，边界情况让用户自己保证 value 简单 |
| D12 | `script` 字段在 `ExecuteContext` 是否必填 | 类型可选 + 运行时校验必填 | 让非 Slurm 工具的类型签名不被影响，SlurmNode 自己在 buildScript 校验 |
| D13 | `slurm` 字段是否也加严格限制（仅 SlurmNode 子类可用） | 保持现状的宽容策略（任何工具都可写） | `slurm` 字段是已有契约，改严格会破坏向后兼容；`script` 是新字段，可以在一开始就立严格约束避免误用。两者不对称是可接受的渐进式收紧 |

---

## 10. 文件结构

```
packages/workflow-engine/src/
├── types/dag.ts                              # CustomNodeDef 新增 script 字段
├── plugins/
│   ├── types.ts                              # CustomNode.kind + ExecuteContext.script
│   ├── slurm-types.ts                        # 新增 ScriptDef
│   ├── slurm-node.ts                         # kind 标记 + buildScript + generateHeader
│   └── custom-executor.ts                    # 透传 script 到 ExecuteContext
├── parser/yaml-parser.ts                     # parseScriptConfig + kind 校验
├── scheduler/dag-scheduler.ts                # resolveNodeInputs 增加 script 求值
└── __tests__/
    └── executor/
        ├── slurm-node.test.ts                # 追加 buildScript / generateHeader 新行为测试
        ├── yaml-parser.test.ts (如存在)      # 追加 script 字段解析测试
        └── custom-executor.test.ts           # 追加 script 透传测试

tools/slurm.ts                                 # inputs 改为 {}

workflow-examples/pe-rna-seq-single-sample.yaml # 11 节点迁移
```

---

## 11. 演进关系

本设计是 [2026-06-18 SlurmNode 设计](./2026-06-18-slurm-node-design.md) 的演进，不替换原设计：

- 原 spec 描述的 SSH/sbatch/sacct 生命周期、状态映射、重试策略、SSH 安全约束等核心机制完全保留
- 本 spec 仅重构 `script` 字段的载体（从 `inputs.script` 提升为节点级 `script.content` + 新增 `script.env`）
- 原 spec 第 5 节「与 CustomNode 的关系」里的 `slurmConfig` 求值决策（D1）保持不变

未来扩展：
- 若需要支持 script 从外部文件加载（如 `script.file: ./trim_galore.sh`），可在 `ScriptDef` 新增 `file` 字段，buildScript 读取文件内容
- 若需要多脚本片段（pre-script/post-script），可在 `ScriptDef` 新增 `pre` / `post` 子字段
- 这些扩展超出本次改造范围，留待未来按需引入
