/**
 * SlurmNode 单元测试 — generateHeader / execute / retry / mapSlurmState。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mapSlurmState, type SlurmConfig, SlurmNode } from "../../plugins/slurm-node";
import type { ExecuteContext, InputDef } from "../../plugins/types";
import { FakeSshExecutor } from "./fake-ssh-executor";

/** 最小 concrete SlurmNode — 用于测试 */
class TestSlurmNode extends SlurmNode {
  name = "test_node";
  description = "Test slurm node";
  inputs: Record<string, InputDef> = {};
  produces: string[] = ["output"];
  slurmConfig: SlurmConfig;

  private _buildScript?: (ctx: ExecuteContext) => string;

  constructor(
    slurmConfig: SlurmConfig,
    sshExecutor?: FakeSshExecutor,
    buildScriptFn?: (ctx: ExecuteContext) => string,
  ) {
    super(sshExecutor);
    this.slurmConfig = slurmConfig;
    if (buildScriptFn) this._buildScript = buildScriptFn;
  }

  buildScript(ctx: ExecuteContext): string {
    return this._buildScript ? this._buildScript(ctx) : "echo hello";
  }

  /** 暴露 protected 方法供测试 */
  testGenerateHeader(ctx: ExecuteContext): string {
    return this.generateHeader(ctx);
  }

  testComputeRetryDelay(attempt: number): number {
    return this.computeRetryDelay(attempt);
  }
}

/** 构造最小 ExecuteContext，覆盖 SlurmNode 所需字段 */
function makeCtx(overrides?: Partial<ExecuteContext>): ExecuteContext {
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

// ── generateHeader 测试 ──

describe("SlurmNode.generateHeader()", () => {
  test("should generate correct header with minimal config", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const header = node.testGenerateHeader(makeCtx());

    expect(header).toContain("#SBATCH --job-name=test_node");
    expect(header).toContain("#SBATCH --partition=xahcnormal");
    expect(header).toContain("#SBATCH --ntasks=1");
    expect(header).toContain("#SBATCH --cpus-per-task=4");
    expect(header).toContain("#SBATCH --output=/test/work/.slurm/test_node_%j.out");
    expect(header).toContain("#SBATCH --error=/test/work/.slurm/test_node_%j.err");
  });

  test("should always include --ntasks=1 regardless of config", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 32 });
    const header = node.testGenerateHeader(makeCtx());
    expect(header).toContain("#SBATCH --ntasks=1");
  });

  test("should always include --cpus-per-task from config", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 16 });
    const header = node.testGenerateHeader(makeCtx());
    expect(header).toContain("#SBATCH --cpus-per-task=16");
  });

  test("should include optional fields when set", () => {
    const node = new TestSlurmNode({
      partition: "xahcnormal",
      cores: 8,
      memory: "100G",
      walltime: "04:00:00",
      nodes: 2,
      jobName: "my_star_job",
    });
    const header = node.testGenerateHeader(makeCtx());

    expect(header).toContain("#SBATCH --mem=100G");
    expect(header).toContain("#SBATCH --time=04:00:00");
    expect(header).toContain("#SBATCH --nodes=2");
    expect(header).toContain("#SBATCH --job-name=my_star_job");
  });

  test("should append extraSBATCH directives at end", () => {
    const node = new TestSlurmNode({
      partition: "xahcnormal",
      cores: 4,
      extraSBATCH: ["--gres=gpu:1", "--account=project123"],
    });
    const header = node.testGenerateHeader(makeCtx());

    expect(header).toContain("#SBATCH --gres=gpu:1");
    expect(header).toContain("#SBATCH --account=project123");
  });

  test("should use ctx.workDir for output paths", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    const ctx = makeCtx({ workDir: "/data/project123" });
    const header = node.testGenerateHeader(ctx);

    expect(header).toContain("/data/project123/.slurm/");
  });
});

// ── execute() 正常流程测试 ──

describe("SlurmNode.execute()", () => {
  test("should execute full sbatch lifecycle and return NodeOutput", async () => {
    const fakeSsh = new FakeSshExecutor();

    fakeSsh.mockCommand(/mkdir -p/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 58616438", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sacct -j 58616438/, { stdout: "58616438|COMPLETED|0:0", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.out/, { stdout: '{"result":"ok"}', stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.err/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;

    const output = await node.execute(makeCtx());
    expect(output.exit_code).toBe(0);
    expect(output.json).toEqual({ result: "ok" });
  });

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

    const node = new CleanupTestNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    await node.execute(makeCtx());
    expect(cleanupLog.length).toBe(1);
  });

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

    const node = new CleanupTestNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    const output = await node.execute(makeCtx());
    expect(output.exit_code).toBe(0);
  });

  test("should throw when sbatch output cannot be parsed", async () => {
    const fakeSsh = new FakeSshExecutor();
    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Error: partition not found", stderr: "", exitCode: 1 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    await expect(node.execute(makeCtx())).rejects.toThrow(/Failed to parse job ID/);
  });
});

// ── 重试逻辑测试 ──

describe("SlurmNode retry logic", () => {
  test("should retry on FAILED and succeed on second attempt", async () => {
    const fakeSsh = new FakeSshExecutor();
    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });

    // sbatch: 用回调计数器，第一/二次返回不同 jobId
    let sbatchCallCount = 0;
    fakeSsh.mockCommand(/sbatch/, (cmd) => {
      sbatchCallCount++;
      const jobId = sbatchCallCount === 1 ? "300" : "301";
      return { stdout: `Submitted batch job ${jobId}`, stderr: "", exitCode: 0 };
    });

    // sacct: 第一次返回 FAILED (job 300), 第二次返回 COMPLETED (job 301)
    let sacctCallCount = 0;
    fakeSsh.mockCommand(/sacct/, (cmd) => {
      sacctCallCount++;
      if (sacctCallCount === 1) {
        return { stdout: "300|FAILED|1:0", stderr: "", exitCode: 0 };
      }
      return { stdout: "301|COMPLETED|0:0", stderr: "", exitCode: 0 };
    });

    fakeSsh.mockCommand(/cat .*\.out/, { stdout: "success", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.err/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 2;
    node.retryDelay = 10;

    const output = await node.execute(makeCtx());
    expect(output.stdout).toContain("success");
  });

  test("should throw after exhausting all retries", async () => {
    const fakeSsh = new FakeSshExecutor();
    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    // 3 次 sbatch 提交（首次 + 2 次重试）
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 400", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 401", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 402", stderr: "", exitCode: 0 });
    // sacct 始终返回 FAILED
    fakeSsh.mockCommand(/sacct/, { stdout: "XXX|FAILED|1:0", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.out/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.err/, { stdout: "error msg", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 2;
    node.retryDelay = 10;

    await expect(node.execute(makeCtx())).rejects.toThrow(/after 2 retries/);
  });

  test("should not retry on OUT_OF_MEMORY", async () => {
    const fakeSsh = new FakeSshExecutor();
    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 500", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sacct/, { stdout: "500|OUT_OF_MEMORY|0:125", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 3;
    node.retryDelay = 10;

    await expect(node.execute(makeCtx())).rejects.toThrow(/ran out of memory/);
  });

  test("should retry on NODE_FAIL", async () => {
    const fakeSsh = new FakeSshExecutor();
    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });

    let sbatchCallCount = 0;
    fakeSsh.mockCommand(/sbatch/, (cmd) => {
      sbatchCallCount++;
      const jobId = sbatchCallCount === 1 ? "600" : "601";
      return { stdout: `Submitted batch job ${jobId}`, stderr: "", exitCode: 0 };
    });

    let sacctCallCount = 0;
    fakeSsh.mockCommand(/sacct/, (cmd) => {
      sacctCallCount++;
      if (sacctCallCount === 1) {
        return { stdout: "600|NODE_FAIL|0:0", stderr: "", exitCode: 0 };
      }
      return { stdout: "601|COMPLETED|0:0", stderr: "", exitCode: 0 };
    });

    fakeSsh.mockCommand(/cat .*\.out/, { stdout: "recovered", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.err/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 1;
    node.retryDelay = 10;

    const output = await node.execute(makeCtx());
    expect(output.stdout).toContain("recovered");
  });

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

    await expect(node.execute(makeCtx())).rejects.toThrow(/was cancelled/);
  });

  // 回归测试：非终态（PENDING/RUNNING）不得被误判为 FAILED。
  // 修复前 pollJob 用 `mappedState ?? "FAILED"`，导致任何还在运行的作业都立即抛错，
  // 错误消息形如 "failed with state FAILED (exit null)"，而 sacct 实际是 RUNNING。
  test("should keep polling on non-terminal states (RUNNING/PENDING) instead of failing", async () => {
    const fakeSsh = new FakeSshExecutor();
    fakeSsh.mockCommand(/mkdir/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat >/, { stdout: "", stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/sbatch/, { stdout: "Submitted batch job 800", stderr: "", exitCode: 0 });

    let sacctCallCount = 0;
    fakeSsh.mockCommand(/sacct/, () => {
      sacctCallCount++;
      if (sacctCallCount === 1) return { stdout: "800|PENDING|0:0", stderr: "", exitCode: 0 };
      if (sacctCallCount === 2) return { stdout: "800|RUNNING|0:0", stderr: "", exitCode: 0 };
      return { stdout: "800|COMPLETED|0:0", stderr: "", exitCode: 0 };
    });

    fakeSsh.mockCommand(/cat .*\.out/, { stdout: '{"result":"ok"}', stderr: "", exitCode: 0 });
    fakeSsh.mockCommand(/cat .*\.err/, { stdout: "", stderr: "", exitCode: 0 });

    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 }, fakeSsh);
    node.pollInterval = 10;
    node.maxRetries = 0; // 即使不重试，也应该等待 PENDING/RUNNING 完成

    const output = await node.execute(makeCtx());
    expect(sacctCallCount).toBe(3); // 必须 3 次：PENDING → RUNNING → COMPLETED
    expect(output.exit_code).toBe(0);
  });
});

// ── computeRetryDelay 测试 ──

describe("SlurmNode.computeRetryDelay()", () => {
  test("should return constant delay in fixed mode", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    node.retryDelay = 30000;
    node.retryBackoff = "fixed";
    expect(node.testComputeRetryDelay(1)).toBe(30000);
    expect(node.testComputeRetryDelay(2)).toBe(30000);
    expect(node.testComputeRetryDelay(3)).toBe(30000);
  });

  test("should double delay in exponential mode", () => {
    const node = new TestSlurmNode({ partition: "xahcnormal", cores: 4 });
    node.retryDelay = 30000;
    node.retryBackoff = "exponential";
    expect(node.testComputeRetryDelay(1)).toBe(30000);
    expect(node.testComputeRetryDelay(2)).toBe(60000);
    expect(node.testComputeRetryDelay(3)).toBe(120000);
    expect(node.testComputeRetryDelay(4)).toBe(240000);
  });
});

// ── mapSlurmState 测试 ──

describe("mapSlurmState()", () => {
  test("should return null for PENDING (non-terminal)", () => {
    expect(mapSlurmState("PENDING", null)).toBeNull();
  });
  test("should return null for RUNNING (non-terminal)", () => {
    expect(mapSlurmState("RUNNING", null)).toBeNull();
  });
  test("should return null for CONFIGURING (non-terminal)", () => {
    expect(mapSlurmState("CONFIGURING", null)).toBeNull();
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
  test("should return FAILED for unknown terminal state (safe default)", () => {
    expect(mapSlurmState("UNKNOWN_STATE", null)).toBe("FAILED");
  });
  test("should return null for COMPLETING (non-terminal)", () => {
    expect(mapSlurmState("COMPLETING", null)).toBeNull();
  });
  test("should map OUT_OF_ME+ to OUT_OF_MEMORY", () => {
    expect(mapSlurmState("OUT_OF_ME+", null)).toBe("OUT_OF_MEMORY");
  });
});
