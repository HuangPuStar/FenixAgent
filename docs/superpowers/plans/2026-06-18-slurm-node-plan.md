# SlurmNode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `SlurmNode` abstract class that implements `CustomNode` and encapsulates SSH + sbatch + sacct lifecycle for HPC job execution.

**Pre-requisite:** Design 1 (`CustomNode`, `ExecuteContext`, `InputDef` types) already implemented in `packages/workflow-engine/src/plugins/types.ts`.

**Architecture:** `SlurmNode` is an abstract class implementing `CustomNode`. It exposes two abstract methods for subclasses (`buildScript`, `slurmConfig`), one optional hook (`preCleanup`), and encapsulates all Slurm interaction in private methods (`generateHeader`, `sshUpload`, `sbatch`, `pollJob`, `collectOutput`). SSH interaction is abstracted behind `SshExecutor` interface for testability.

**Tech Stack:** TypeScript, Bun test, Bun.spawn for SSH, no external npm packages.

---

### Task 1: Create types file (SlurmConfig, SshExecutor, JobResult)

**Files:**
- Create: `packages/workflow-engine/src/plugins/slurm-types.ts`

- [ ] **Step 1: Write types file**

```typescript
/**
 * SlurmNode 核心类型定义 — SlurmConfig, SshExecutor, JobResult。
 */

/** Slurm 作业资源声明 */
export interface SlurmConfig {
  /** Slurm 队列/分区名 */
  partition: string;

  /** CPU 核数（--cpus-per-task） */
  cores: number;

  /** 计算节点数，默认 1 */
  nodes?: number;

  /** 内存，如 "100G"。不设则用队列默认 */
  memory?: string;

  /** 最大运行时间，如 "04:00:00"。不设则用队列默认 */
  walltime?: string;

  /** module load 列表，如 ["apps/apptainer/1.2.4"] */
  modules?: string[];

  /** 作业名覆盖，默认使用 CustomNode.name */
  jobName?: string;

  /** 额外 #SBATCH 指令（如 --gres=gpu:1），原样追加 */
  extraSBATCH?: string[];
}

/** SSH 执行器接口 — 生产用 BunSshExecutor，测试可注入 fake */
export interface SshExecutor {
  exec(
    host: string,
    command: string,
    opts?: {
      cwd?: string;
      timeout?: number;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** sacct 轮询结果 */
export interface JobResult {
  jobId: string;
  state: "COMPLETED" | "FAILED" | "TIMEOUT" | "NODE_FAIL" | "OUT_OF_MEMORY" | "CANCELLED";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/workflow-engine && bun run typecheck 2>&1 | grep -v "error TS"
```

Expected: No new type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/plugins/slurm-types.ts
git commit -m "feat(workflow-engine): add SlurmConfig, SshExecutor, JobResult types"
```

---

### Task 2: Create FakeSshExecutor test utility

**Files:**
- Create: `packages/workflow-engine/src/__tests__/executor/fake-ssh-executor.ts`

- [ ] **Step 1: Write FakeSshExecutor**

```typescript
/**
 * Fake SSH 执行器 — 按正则匹配命令并返回预设响应。
 * 用于 SlurmNode 单元测试，无需真实 SSH 连接。
 */

import type { SshExecutor } from "../../plugins/slurm-types";

interface MockResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class FakeSshExecutor implements SshExecutor {
  private responses: Array<{ pattern: RegExp; response: MockResponse | ((command: string) => MockResponse) }> = [];

  /** 预设命令响应。按注册顺序匹配，首次命中即返回。支持静态值或回调函数 */
  mockCommand(
    pattern: RegExp,
    response: MockResponse | ((command: string) => MockResponse),
  ): void {
    this.responses.push({ pattern, response });
  }

  /** 清空所有预设 */
  reset(): void {
    this.responses = [];
  }

  async exec(
    host: string,
    command: string,
    _opts?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    for (const { pattern, response } of this.responses) {
      if (pattern.test(command)) {
        return typeof response === "function" ? response(command) : response;
      }
    }
    throw new Error(`Unmocked SSH command: ${command}`);
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/workflow-engine && bun run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/__tests__/executor/fake-ssh-executor.ts
git commit -m "test(workflow-engine): add FakeSshExecutor for SlurmNode testing"
```

---

### Task 3: Write tests for SlurmNode.generateHeader()

**Files:**
- Create: `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`

- [ ] **Step 1: Write generateHeader tests**

```typescript
/**
 * SlurmNode 单元测试 — generateHeader / execute / preCleanup / retry。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExecuteContext } from "../../plugins/types";
import type { SlurmConfig } from "../../plugins/slurm-types";

// ── 最小化的 SlurmNode concrete class 用于测试 generateHeader ──

class TestSlurmNode {
  slurmConfig: SlurmConfig;

  constructor(slurmConfig: SlurmConfig) {
    this.slurmConfig = slurmConfig;
  }

  /** 复制 SlurmNode.generateHeader() 逻辑，供单元测试直接调用 */
  generateHeader(ctx: ExecuteContext): string {
    const config = this.slurmConfig;
    const jobName = config.jobName ?? "test_node";
    const outDir = `${ctx.workDir}/.slurm`;

    const lines: string[] = [
      "#!/bin/bash",
      `#SBATCH --job-name=${jobName}`,
      `#SBATCH --partition=${config.partition}`,
      `#SBATCH --ntasks=1`,
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

    if (config.modules && config.modules.length > 0) {
      // modules 不在 header 中，在 script body 中作为 "module load" 命令
    }

    if (config.extraSBATCH && config.extraSBATCH.length > 0) {
      for (const extra of config.extraSBATCH) {
        lines.push(`#SBATCH ${extra}`);
      }
    }

    return lines.join("\n") + "\n";
  }
}

// ── 辅助：最小 ExecuteContext ──

function makeCtx(overrides?: Partial<ExecuteContext>): ExecuteContext {
  return {
    inputs: {},
    params: {},
    secrets: {},
    workDir: "/test/work",
    signal: new AbortController().signal,
    storage: null as unknown as ExecuteContext["storage"],
    runId: "run-001",
    nodeId: "node-001",
    foreach: undefined,
    ...overrides,
  };
}

// ── 测试 ──

describe("SlurmNode.generateHeader()", () => {
  // 基础 header 输出验证
  test("should generate correct header with minimal config", () => {
    const node = new TestSlurmNode({
      partition: "xahcnormal",
      cores: 4,
    });
    const ctx = makeCtx();

    const header = node.generateHeader(ctx);

    expect(header).toContain("#SBATCH --job-name=test_node");
    expect(header).toContain("#SBATCH --partition=xahcnormal");
    expect(header).toContain("#SBATCH --ntasks=1");
    expect(header).toContain("#SBATCH --cpus-per-task=4");
    expect(header).toContain("#SBATCH --output=/test/work/.slurm/test_node_%j.out");
    expect(header).toContain("#SBATCH --error=/test/work/.slurm/test_node_%j.err");
  });

  // --ntasks=1 必须始终存在
  test("should always include --ntasks=1", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 32 });
    const header = node.generateHeader(makeCtx());
    expect(header).toContain("#SBATCH --ntasks=1");
  });

  // --cpus-per-task 必须始终存在
  test("should always include --cpus-per-task", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 16 });
    const header = node.generateHeader(makeCtx());
    expect(header).toContain("#SBATCH --cpus-per-task=16");
  });

  // 可选字段测试
  test("should include optional fields when set", () => {
    const node = new TestSlurmNode({
      partition: "xahcnormal",
      cores: 8,
      memory: "100G",
      walltime: "04:00:00",
      nodes: 2,
      jobName: "my_star_job",
    });
    const header = node.generateHeader(makeCtx());

    expect(header).toContain("#SBATCH --mem=100G");
    expect(header).toContain("#SBATCH --time=04:00:00");
    expect(header).toContain("#SBATCH --nodes=2");
    expect(header).toContain("#SBATCH --job-name=my_star_job");
  });

  // extraSBATCH 追加测试
  test("should append extraSBATCH directives", () => {
    const node = new TestSlurmNode({
      partition: "xahcnormal",
      cores: 4,
      extraSBATCH: ["--gres=gpu:1", "--account=project123"],
    });
    const header = node.generateHeader(makeCtx());

    expect(header).toContain("#SBATCH --gres=gpu:1");
    expect(header).toContain("#SBATCH --account=project123");
  });

  // extraSBATCH 追加在末尾
  test("should place extraSBATCH after standard directives", () => {
    const node = new TestSlurmNode({
      partition: "xahcnormal",
      cores: 4,
      extraSBATCH: ["--gres=gpu:1"],
    });
    const header = node.generateHeader(makeCtx());

    const outputIdx = header.indexOf("#SBATCH --output=");
    const gresIdx = header.indexOf("#SBATCH --gres=gpu:1");
    expect(gresIdx).toBeGreaterThan(outputIdx);
  });

  // workDir 动态拼接
  test("should use ctx.workDir for output paths", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const ctx = makeCtx({ workDir: "/data/project123" });
    const header = node.generateHeader(ctx);

    expect(header).toContain("/data/project123/.slurm/");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/workflow-engine && bun test src/__tests__/executor/slurm-node.test.ts
```

Expected: 0 passing (no SlurmNode module to import yet — the `TestSlurmNode` is defined inline).

Wait — `TestSlurmNode` is defined in the test file itself, so tests should pass immediately. Let me adjust: the TestSlurmNode in the test IS the implementation-under-test for generateHeader.

```bash
cd packages/workflow-engine && bun test src/__tests__/executor/slurm-node.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts
git commit -m "test(workflow-engine): add generateHeader unit tests for SlurmNode"
```

---

### Task 4: Write test for SlurmNode.execute() normal flow (FakeSshExecutor)

**Note:** We build `slurm-node.ts` incrementally. First, extract `generateHeader` logic to the real file.

**Files:**
- Create: `packages/workflow-engine/src/plugins/slurm-node.ts`
- Modify: `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`

- [ ] **Step 1: Write minimal SlurmNode with generateHeader only**

```typescript
/**
 * SlurmNode — 基于 CustomNode 的 Slurm HPC 作业执行器。
 *
 * 封装 SSH + sbatch + sacct 完整生命周期。
 * 子类只需覆写 buildScript(ctx) 返回具体 bash 命令。
 */

import type { ExecuteContext, CustomNode, InputDef } from "./types";
import type { SlurmConfig, SshExecutor, JobResult } from "./slurm-types";
import type { NodeOutput } from "../types/execution";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";

/** SlurmNode abstract class — 子类必须实现 name, description, inputs, produces, slurmConfig, buildScript */
export abstract class SlurmNode implements CustomNode {
  abstract name: string;
  abstract description: string;
  abstract inputs: Record<string, InputDef>;
  abstract produces: string[];

  abstract slurmConfig: SlurmConfig;

  pollInterval: number = 15000;
  maxRetries: number = 0;
  retryDelay: number = 30000;
  retryBackoff: "fixed" | "exponential" = "fixed";

  protected sshExecutor: SshExecutor;

  constructor(sshExecutor?: SshExecutor) {
    this.sshExecutor = sshExecutor ?? new BunSshExecutor();
  }

  abstract buildScript(ctx: ExecuteContext): string;

  preCleanup?(ctx: ExecuteContext): string;

  async execute(ctx: ExecuteContext): Promise<NodeOutput> {
    // 1. preCleanup
    const cleanupCmd = this.preCleanup?.(ctx);
    if (cleanupCmd) {
      try {
        const host = String(ctx.params.cluster_host ?? "localhost");
        await this.sshExecutor.exec(host, cleanupCmd);
      } catch (err) {
        console.warn(`[SlurmNode] preCleanup failed for ${this.name}:`, err);
      }
    }

    // 2. 生成 .slurm 脚本
    const userScript = this.buildScript(ctx);
    const header = this.generateHeader(ctx);
    const slurmScript = header + "\nset -euo pipefail\n" + userScript;

    // 3. SSH 上传
    const host = String(ctx.params.cluster_host ?? "localhost");
    const remotePath = `${ctx.workDir}/.slurm/${ctx.runId}_${ctx.nodeId}.slurm`;
    await this.sshUpload(host, ctx.workDir, slurmScript, remotePath);

    // 4. sbatch 提交
    let jobId = await this.sbatch(host, remotePath);

    // 5. sacct 轮询（带重试）
    let attempt = 0;
    let result: JobResult;
    while (true) {
      result = await this.pollJob(host, ctx.workDir, jobId);

      if (result.state === "COMPLETED") break;

      if (result.state === "CANCELLED") {
        throw new WorkflowError(
          `Slurm job ${jobId} was cancelled`,
          WorkflowErrorCode.NODE_FAILED,
          { node_id: ctx.nodeId, slurm_job_id: jobId },
        );
      }

      // OUT_OF_MEMORY 不重试
      if (result.state === "OUT_OF_MEMORY") {
        throw new WorkflowError(
          `Slurm job ${jobId} ran out of memory`,
          WorkflowErrorCode.NODE_FAILED,
          { node_id: ctx.nodeId, slurm_job_id: jobId },
        );
      }

      // 其他终端失败：按重试策略
      if (result.state === "FAILED" || result.state === "TIMEOUT" || result.state === "NODE_FAIL") {
        if (attempt < this.maxRetries) {
          attempt++;
          const delay = this.computeRetryDelay(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          jobId = await this.sbatch(host, remotePath);
          continue;
        }
        throw new WorkflowError(
          `Slurm job ${jobId} failed with state ${result.state} (exit ${result.exitCode}) after ${attempt} retries`,
          WorkflowErrorCode.NODE_FAILED,
          { node_id: ctx.nodeId, slurm_job_id: jobId, exit_code: result.exitCode },
        );
      }

      // PENDING / RUNNING → 继续轮询
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }

    // 6. 收集输出
    return this.collectOutput(result);
  }

  async onCleanup(
    _ctx: ExecuteContext,
    _result: NodeOutput | null,
    _error: Error | null,
  ): Promise<void> {
    // 默认无操作，子类可覆写
  }

  // ── Private ──

  private generateHeader(ctx: ExecuteContext): string {
    const config = this.slurmConfig;
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

    if (config.extraSBATCH && config.extraSBATCH.length > 0) {
      for (const extra of config.extraSBATCH) {
        lines.push(`#SBATCH ${extra}`);
      }
    }

    const moduleCmds =
      config.modules && config.modules.length > 0
        ? config.modules.map((m) => `module load ${m}`).join("\n") + "\n"
        : "";

    return lines.join("\n") + "\n" + moduleCmds;
  }

  private async sshUpload(
    host: string,
    workDir: string,
    script: string,
    remotePath: string,
  ): Promise<void> {
    await this.sshExecutor.exec(host, `mkdir -p ${workDir}/.slurm`);
    // 通过 stdin 管道写入 .slurm 文件
    await this.sshExecutor.exec(host, `cat > ${remotePath} << 'SLURM_EOF'\n${script}\nSLURM_EOF`);
  }

  private async sbatch(host: string, remotePath: string): Promise<string> {
    const { stdout } = await this.sshExecutor.exec(host, `sbatch ${remotePath}`);
    const match = stdout.match(/Submitted batch job (\d+)/);
    if (!match) {
      throw new WorkflowError(
        `Failed to parse job ID from sbatch output: ${stdout}`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }
    return match[1];
  }

  private async pollJob(
    host: string,
    workDir: string,
    jobId: string,
  ): Promise<JobResult> {
    const jobName = this.slurmConfig.jobName ?? this.name;

    // 1. sacct 查询状态
    const sacctCmd = `sacct -j ${jobId} --format=JobID,State,ExitCode --noheader --parsable2`;
    const { stdout: sacctOut } = await this.sshExecutor.exec(host, sacctCmd);

    const lines = sacctOut.trim().split("\n").filter((l) => l);
    const mainJob = lines[0];
    if (!mainJob) {
      return {
        jobId,
        state: "FAILED" as const,
        exitCode: null,
        stdout: "",
        stderr: `sacct returned no data for job ${jobId}`,
      };
    }

    const parts = mainJob.split("|");
    const slurmState = parts[1] ?? "";
    const exitCodeStr = parts[2] ?? "";
    const exitCode = exitCodeStr && exitCodeStr !== "" ? parseInt(exitCodeStr) : null;

    // 2. 映射状态
    const mappedState = mapSlurmState(slurmState, exitCode);

    // 3. 如果是终态，收集输出文件
    let stdout = "";
    let stderr = "";
    if (mappedState !== null) {
      const outPath = `${workDir}/.slurm/${jobName}_${jobId}`;
      try {
        const outResult = await this.sshExecutor.exec(host, `cat ${outPath}.out`);
        stdout = outResult.stdout;
      } catch {
        stdout = "(failed to read stdout)";
      }
      try {
        const errResult = await this.sshExecutor.exec(host, `cat ${outPath}.err`);
        stderr = errResult.stdout;
      } catch {
        stderr = "(failed to read stderr)";
      }
    }

    return { jobId, state: mappedState ?? "FAILED", exitCode, stdout, stderr };
  }

  private collectOutput(result: JobResult): NodeOutput {
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      // not JSON
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      json,
      exit_code: result.exitCode ?? 0,
      size: Buffer.byteLength(result.stdout),
    };
  }

  /** 计算重试延迟。protected 以便子类和测试访问。 */
  protected computeRetryDelay(attempt: number): number {
    if (this.retryBackoff === "exponential") {
      return this.retryDelay * Math.pow(2, attempt - 1);
    }
    return this.retryDelay;
  }
}

// ── 辅助函数 ──

/**
 * 将 sacct State 映射到 JobResult.state。
 * 返回 null 表示非终态（PENDING/RUNNING），调用方应继续轮询。
 */
function mapSlurmState(
  slurmState: string,
  exitCode: number | null,
): JobResult["state"] | null {
  const upper = slurmState.toUpperCase();

  // 非终态 — 继续轮询
  if (upper === "PENDING" || upper === "CONFIGURING" || upper === "REQUEUED") {
    return null;
  }
  if (upper === "RUNNING" || upper === "COMPLETING" || upper === "SUSPENDED") {
    return null;
  }

  // COMPLETED — 按 exitCode 区分成功/失败
  if (upper === "COMPLETED") {
    return exitCode === 0 ? "COMPLETED" : "FAILED";
  }

  // 明确映射
  if (upper === "TIMEOUT" || upper === "DEADLINE") return "TIMEOUT";
  if (upper === "NODE_FAIL") return "NODE_FAIL";
  if (upper === "OUT_OF_MEMORY" || upper === "OUT_OF_ME+") return "OUT_OF_MEMORY";
  if (upper === "CANCELLED" || upper === "CANCELLED+") return "CANCELLED";

  // 其他失败状态
  if (upper === "FAILED" || upper === "BOOT_FAIL" || upper === "PREEMPTED" || upper === "REVOKED") {
    return "FAILED";
  }

  // 兜底：未知终态 → FAILED
  return "FAILED";
}

// ── BunSshExecutor (此处声明，Task N 中测试) ──

/** 基于 Bun.spawn 的 SSH 执行器生产实现 */
export class BunSshExecutor implements SshExecutor {
  async exec(
    host: string,
    command: string,
    _opts?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["/usr/bin/ssh", "-o", "BatchMode=yes", host, command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode };
  }
}
```

- [ ] **Step 2: Update test file — replace inline TestSlurmNode with real SlurmNode**

In `slurm-node.test.ts`, replace the `TestSlurmNode` class with a concrete test subclass:

```typescript
// 在 slurm-node.test.ts 中，替换 TestSlurmNode 为:

import { SlurmNode, type SlurmConfig } from "../../plugins/slurm-node";
import type { ExecuteContext, InputDef } from "../../plugins/types";
import { FakeSshExecutor } from "./fake-ssh-executor";

/** 最小 concrete SlurmNode — 用于测试 generateHeader 和 execute */
class TestSlurmNode extends SlurmNode {
  name = "test_node";
  description = "Test slurm node";
  inputs: Record<string, InputDef> = {};
  produces: string[] = ["output"];

  constructor(
    slurmConfig: SlurmConfig,
    sshExecutor?: FakeSshExecutor,
    buildScriptFn?: (ctx: ExecuteContext) => string,
  ) {
    super(sshExecutor);
    this.slurmConfig = slurmConfig;
    if (buildScriptFn) this._buildScript = buildScriptFn;
  }

  private _buildScript?: (ctx: ExecuteContext) => string;

  buildScript(ctx: ExecuteContext): string {
    return this._buildScript ? this._buildScript(ctx) : "echo hello";
  }
}
```

- [ ] **Step 3: Run generateHeader tests against real SlurmNode**

```bash
cd packages/workflow-engine && bun test src/__tests__/executor/slurm-node.test.ts
```

Expected: 6 tests PASS（generateHeader tests）。

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/plugins/slurm-node.ts packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts
git commit -m "feat(workflow-engine): add SlurmNode class with generateHeader and execute lifecycle"
```

---

### Task 5: Write tests for SlurmNode.execute() normal flow

**Files:**
- Modify: `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`

- [ ] **Step 1: Add execute() normal flow test to test file**

Append the following after the existing `generateHeader` describe block:

```typescript
describe("SlurmNode.execute()", () => {
  // 完整正常流程测试
  test("should execute full sbatch lifecycle and return NodeOutput", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/mkdir -p/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat > .* << 'SLURM_EOF'/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch .*\.slurm/, {
      stdout: "Submitted batch job 58616438",
      stderr: "",
      exitCode: 0,
    });

    // 第一次 sacct: RUNNING（非终态 → 继续轮询）
    fakeSsh.mockCommand(/sacct -j 58616438/, {
      stdout: "58616438|RUNNING|0:0",
      stderr: "",
      exitCode: 0,
    });

    // 第二次 sacct: COMPLETED（终态）
    fakeSsh.mockCommand(/sacct -j 58616438/, {
      stdout: "58616438|COMPLETED|0:0",
      stderr: "",
      exitCode: 0,
    });

    // cat stdout
    fakeSsh.mockCommand(/cat .*test_node_58616438\.out/, {
      stdout: '{"result": "ok"}',
      stderr: "",
      exitCode: 0,
    });

    // cat stderr
    fakeSsh.mockCommand(/cat .*test_node_58616438\.err/, {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const node = new TestSlurmNode(
      { partition: "xahcnormal", cores: 4 },
      fakeSsh,
      (ctx) => `echo "processing ${ctx.inputs.sample_id ?? "unknown"}"`,
    );
    node.pollInterval = 10; // 加速测试

    const ctx = makeSlurmCtx({ inputs: { sample_id: "SRR001" } });

    const output = await node.execute(ctx);

    expect(output.exit_code).toBe(0);
    expect(output.json).toEqual({ result: "ok" });
  });

  // preCleanup 调用测试
  test("should call preCleanup before sbatch", async () => {
    const fakeSsh = new FakeSshExecutor();
    const cleanupLog: string[] = [];

    fakeSsh.mockCommand(/rm -rf/, (cmd) => {
      cleanupLog.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    fakeSsh.mockCommand(/mkdir -p/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 100", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sacct/, { stdout: "100|COMPLETED|0:0", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.out/, { stdout: "ok", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.err/, { stdout: "", stderr: "", exitCode: 0 });

    class CleanupTestNode extends TestSlurmNode {
      preCleanup(ctx: ExecuteContext): string {
        return `rm -rf ${ctx.workDir}/tmp`;
      }
    }

    const node = new CleanupTestNode(
      { partition: "xahcnormal", cores: 4 },
      fakeSsh,
    );
    node.pollInterval = 10;

    await node.execute(makeSlurmCtx());

    expect(cleanupLog.length).toBe(1);
  });

  // preCleanup 失败不阻塞主流程
  test("should not block main flow when preCleanup fails", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/rm -rf/, { stdout: "", stderr: "permission denied", exitCode: 1 });
    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 200", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sacct/, { stdout: "200|COMPLETED|0:0", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.out/, { stdout: "ok", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.err/, { stdout: "", stderr: "", exitCode: 0 });

    class CleanupTestNode extends TestSlurmNode {
      preCleanup(): string {
        return "rm -rf /bad/path";
      }
    }

    const node = new CleanupTestNode(
      { partition: "xahcnormal", cores: 4 },
      fakeSsh,
    );
    node.pollInterval = 10;

    // 不应抛异常
    const output = await node.execute(makeSlurmCtx());
    expect(output.exit_code).toBe(0);
  });

  // sbatch 解析失败
  test("should throw when sbatch output cannot be parsed", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, {
      stdout: "Error: partition not found",
      stderr: "",
      exitCode: 1,
    });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);

    await expect(node.execute(makeSlurmCtx())).rejects.toThrow(/Failed to parse job ID/);
  });
});

// ── 辅助 ──

function makeSlurmCtx(overrides?: Partial<ExecuteContext>): ExecuteContext {
  return {
    inputs: {},
    params: { cluster_host: "test-cluster" },
    secrets: {},
    workDir: "/test/work",
    signal: new AbortController().signal,
    storage: null as unknown as ExecuteContext["storage"],
    runId: "run-001",
    nodeId: "node-001",
    foreach: undefined,
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests**

```bash
cd packages/workflow-engine && bun test src/__tests__/executor/slurm-node.test.ts
```

Expected: 10 tests PASS (6 from Task 3 + 4 new).

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts
git commit -m "test(workflow-engine): add SlurmNode.execute() normal flow tests"
```

---

### Task 6: Write tests for retry logic

**Files:**
- Modify: `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`

- [ ] **Step 1: Add retry tests**

Append after the existing describe blocks:

```typescript
describe("SlurmNode retry logic", () => {
  // 重试：第一次 FAILED → 第二次 COMPLETED
  test("should retry on FAILED and succeed on second attempt", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });

    // 第一次 sbatch → job 300
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 300", stderr: "", exitCode: 0 });

    // 第一次 sacct → FAILED
    fakeSsh.mockCommand(/sacct -j 300/, { stdout: "300|FAILED|1:0", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*300\.out/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*300\.err/, { stdout: "command not found", stderr: "", exitCode: 0 });

    // 第二次 sbatch → job 301（重试）
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 301", stderr: "", exitCode: 0 });

    // 第二次 sacct → COMPLETED
    fakeSsh.mockCommand(/sacct -j 301/, { stdout: "301|COMPLETED|0:0", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*301\.out/, { stdout: "success", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*301\.err/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 2;
    node.retryDelay = 10; // 加速测试

    const output = await node.execute(makeSlurmCtx());
    expect(output.stdout).toBe("success");
  });

  // 重试耗尽后抛异常
  test("should throw after exhausting retries", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });

    // 3 次 sbatch 都失败（maxRetries = 2，共 3 次尝试）
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 400", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 401", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 402", stderr: "", exitCode: 0 });

    fakeSsh.mockCommand(/sacct -j 400/, {
      stdout: "400|FAILED|1:0", stderr: "", exitCode: 0,
    });
    fakeSsh.mockCommand(/sacct -j 401/, {
      stdout: "401|FAILED|1:0", stderr: "", exitCode: 0,
    });
    fakeSsh.mockCommand(/sacct -j 402/, {
      stdout: "402|FAILED|1:0", stderr: "", exitCode: 0,
    });

    fakeSsh.mockCommand(/cat .*\.out/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.err/, { stdout: "error", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 2;
    node.retryDelay = 10;

    await expect(node.execute(makeSlurmCtx())).rejects.toThrow(/after 2 retries/);
  });

  // OUT_OF_MEMORY 不重试
  test("should not retry on OUT_OF_MEMORY", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 500", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sacct/, { stdout: "500|OUT_OF_MEMORY|0:125", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 3; // 即使有重试次数也不重试
    node.retryDelay = 10;

    await expect(node.execute(makeSlurmCtx())).rejects.toThrow(/ran out of memory/);
  });

  // NODE_FAIL 可重试
  test("should retry on NODE_FAIL", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });

    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 600", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 601", stderr: "", exitCode: 0 });

    fakeSsh.mockCommand(/sacct -j 600/, {
      stdout: "600|NODE_FAIL|0:0", stderr: "", exitCode: 0,
    });
    fakeSsh.mockCommand(/sacct -j 601/, {
      stdout: "601|COMPLETED|0:0", stderr: "", exitCode: 0,
    });

    fakeSsh.mockCommand(/cat .*600\.out/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*600\.err/, { stdout: "node failure", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*601\.out/, { stdout: "recovered", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*601\.err/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 1;
    node.retryDelay = 10;

    const output = await node.execute(makeSlurmCtx());
    expect(output.stdout).toBe("recovered");
  });

  // CANCELLED 立即抛异常
  test("should throw immediately on CANCELLED", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 700", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sacct/, { stdout: "700|CANCELLED|0:0", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 3;

    await expect(node.execute(makeSlurmCtx())).rejects.toThrow(/was cancelled/);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/workflow-engine && bun test src/__tests__/executor/slurm-node.test.ts
```

Expected: 15 tests PASS (6 + 4 + 5).

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts
git commit -m "test(workflow-engine): add SlurmNode retry logic tests"
```

---

### Task 7: Write test for computeRetryDelay

**Files:**
- Modify: `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`

- [ ] **Step 1: Add computeRetryDelay test**

```typescript
describe("SlurmNode.computeRetryDelay()", () => {
  // fixed 模式
  test("should return constant delay in fixed mode", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    node.retryDelay = 30000;
    node.retryBackoff = "fixed";

    expect(node.testComputeRetryDelay(1)).toBe(30000);
    expect(node.testComputeRetryDelay(2)).toBe(30000);
    expect(node.testComputeRetryDelay(3)).toBe(30000);
  });

  // exponential 模式
  test("should double delay in exponential mode", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    node.retryDelay = 30000;
    node.retryBackoff = "exponential";

    expect(node.testComputeRetryDelay(1)).toBe(30000);   // 30s
    expect(node.testComputeRetryDelay(2)).toBe(60000);    // 60s
    expect(node.testComputeRetryDelay(3)).toBe(120000);   // 120s
    expect(node.testComputeRetryDelay(4)).toBe(240000);   // 240s
  });
});
```

**Note:** `computeRetryDelay` is private in the current design. Either make it `protected` for testing, or test it indirectly through retry timing. For unit testing, make it `package-private` by removing the `private` keyword or expose via a test-only subclass:

```typescript
// 在 TestSlurmNode 中添加暴露方法:
computeRetryDelay(attempt: number): number {
  // 调用父类的同名方法（改为 protected）
  return (this as any).computeRetryDelayInternal(attempt);
}
```

Actually, the simpler approach: make `computeRetryDelay` `protected` instead of `private` in the spec:

```typescript
// In slurm-node.ts, change:
// private computeRetryDelay(attempt: number): number {
protected computeRetryDelay(attempt: number): number {
```

**Note:** `computeRetryDelay` is protected in `SlurmNode`. `TestSlurmNode` inherits it and tests access it via a public test-exposure method.

Update `TestSlurmNode` class to expose computeRetryDelay:

```typescript
class TestSlurmNode extends SlurmNode {
  // ... existing fields ...

  /** 暴露 protected 方法供测试 */
  testComputeRetryDelay(attempt: number): number {
    return this.computeRetryDelay(attempt);
  }
}
```

- [ ] **Step 2: Run tests**

```bash
cd packages/workflow-engine && bun test src/__tests__/executor/slurm-node.test.ts
```

Expected: 17 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts packages/workflow-engine/src/plugins/slurm-node.ts
git commit -m "test(workflow-engine): add computeRetryDelay tests; make method protected"
```

---

### Task 8: Write test for mapSlurmState

**Files:**
- Modify: `packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts`

- [ ] **Step 1: Add mapSlurmState test**

Export `mapSlurmState` from `slurm-node.ts`:

```typescript
// In slurm-node.ts, change:
// function mapSlurmState(...) { → export function mapSlurmState(...) {
```

Then add test:

```typescript
import { mapSlurmState } from "../../plugins/slurm-node";

describe("mapSlurmState()", () => {
  test("should return null for PENDING", () => {
    expect(mapSlurmState("PENDING", null)).toBeNull();
  });

  test("should return null for RUNNING", () => {
    expect(mapSlurmState("RUNNING", null)).toBeNull();
  });

  test("should return COMPLETED for COMPLETED with exit 0", () => {
    expect(mapSlurmState("COMPLETED", 0)).toBe("COMPLETED");
  });

  test("should return FAILED for COMPLETED with exit 1", () => {
    expect(mapSlurmState("COMPLETED", 1)).toBe("FAILED");
  });

  test("should return TIMEOUT for TIMEOUT", () => {
    expect(mapSlurmState("TIMEOUT", null)).toBe("TIMEOUT");
  });

  test("should return NODE_FAIL for NODE_FAIL", () => {
    expect(mapSlurmState("NODE_FAIL", null)).toBe("NODE_FAIL");
  });

  test("should return OUT_OF_MEMORY for OUT_OF_MEMORY", () => {
    expect(mapSlurmState("OUT_OF_MEMORY", null)).toBe("OUT_OF_MEMORY");
  });

  test("should return CANCELLED for CANCELLED", () => {
    expect(mapSlurmState("CANCELLED", null)).toBe("CANCELLED");
  });

  test("should return FAILED for BOOT_FAIL", () => {
    expect(mapSlurmState("BOOT_FAIL", null)).toBe("FAILED");
  });

  test("should return FAILED for unknown terminal state", () => {
    expect(mapSlurmState("UNKNOWN_STATE", null)).toBe("FAILED");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/workflow-engine && bun test src/__tests__/executor/slurm-node.test.ts
```

Expected: 27 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/__tests__/executor/slurm-node.test.ts packages/workflow-engine/src/plugins/slurm-node.ts
git commit -m "test(workflow-engine): add mapSlurmState unit tests"
```

---

### Task 9: Export from plugins barrel

**Files:**
- Create: `packages/workflow-engine/src/plugins/index.ts`
- Modify: `packages/workflow-engine/src/index.ts`

- [ ] **Step 1: Create plugins barrel**

```typescript
/**
 * plugins/ — 自定义节点插件系统导出。
 */

// Design 1 types (assumed already exist)
export type { CustomNode, InputDef, ExecuteContext } from "./types";

// Design 2 types
export type { SlurmConfig, SshExecutor, JobResult } from "./slurm-types";

// Design 2 classes
export { SlurmNode, BunSshExecutor, mapSlurmState } from "./slurm-node";
```

- [ ] **Step 2: Add plugins exports to main index.ts**

```typescript
// In packages/workflow-engine/src/index.ts, append:
export type { CustomNode, ExecuteContext, InputDef, SlurmConfig, SshExecutor, JobResult } from "./plugins";
export { SlurmNode, BunSshExecutor, mapSlurmState } from "./plugins";
```

- [ ] **Step 3: Verify typecheck**

```bash
cd packages/workflow-engine && bun run typecheck
```

Expected: No new errors.

- [ ] **Step 4: Run full test suite**

```bash
cd packages/workflow-engine && bun test
```

Expected: All tests pass (existing + 27 new).

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/plugins/index.ts packages/workflow-engine/src/index.ts
git commit -m "feat(workflow-engine): export SlurmNode and related types from plugins barrel"
```

---

### Task 10: Run full precheck

- [ ] **Step 1: Run precheck from project root**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

Expected: biome format + import sort + tsc + biome check all pass.

- [ ] **Step 2: Fix any issues, commit**

```bash
git commit -m "chore: precheck fixes for SlurmNode implementation"
```

---

## Plan Summary

| Task | File | Action | Tests Covered |
|------|------|--------|--------------|
| 1 | `plugins/slurm-types.ts` | Create | — |
| 2 | `__tests__/executor/fake-ssh-executor.ts` | Create | — |
| 3 | `slurm-node.test.ts` | Create + Test | generateHeader (6 tests) |
| 4 | `plugins/slurm-node.ts` | Create | — |
| 5 | `slurm-node.test.ts` | Modify | execute normal flow (4 tests) |
| 6 | `slurm-node.test.ts` | Modify | retry logic (5 tests) |
| 7 | `slurm-node.test.ts` + `slurm-node.ts` | Modify | computeRetryDelay (2 tests) |
| 8 | `slurm-node.test.ts` + `slurm-node.ts` | Modify | mapSlurmState (10 tests) |
| 9 | `plugins/index.ts` + `index.ts` | Create + Modify | — |
| 10 | project root | Verify | precheck |
