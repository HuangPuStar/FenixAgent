import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DAGRunResult } from "@fenix/workflow-engine";
import { clearAllEngines, getTeamEngine } from "../services/workflow";
import { executeWorkflow } from "../services/workflow/workflow-execute";
import { resetAllStubs, stubDb, stubPgStorageAdapter } from "../test-utils/helpers";

const organizationId = "org-workflow-execute";
const workflowId = "workflow-execute";
const yaml = `schema_version: "1"
name: workflow execute coverage
nodes:
  - id: finish
    type: end`;

let storagePath = "";
let snapshotUpdates = 0;

function workflowRow() {
  return {
    id: workflowId,
    userId: "user-workflow-execute",
    organizationId,
    name: "工作流执行覆盖",
    description: null,
    latestVersion: 2,
    storagePath,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function stubWorkflowDb(): void {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([workflowRow()]) }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => {
          snapshotUpdates += 1;
          return Promise.resolve();
        },
      }),
    }),
  });
}

function runResult(status: DAGRunResult["status"], outputs?: DAGRunResult["outputs"]): DAGRunResult {
  return {
    runId: "run-workflow-execute",
    status,
    summary: {
      run_id: "run-workflow-execute",
      workflow_name: "工作流执行覆盖",
      status,
      started_at: "2026-01-01T00:00:00.000Z",
      node_summary: { total: 1, completed: status === "SUCCESS" ? 1 : 0, failed: 0, running: 0 },
    },
    outputs,
    spawnedInstanceIds: [],
  };
}

beforeEach(async () => {
  resetAllStubs();
  clearAllEngines();
  storagePath = await mkdtemp(join(tmpdir(), "workflow-execute-"));
  await writeFile(join(storagePath, "v2.yaml"), yaml, "utf-8");
  snapshotUpdates = 0;
  stubPgStorageAdapter({});
  stubWorkflowDb();
});

afterEach(async () => {
  mock.restore();
  clearAllEngines();
  resetAllStubs();
  await rm(storagePath, { recursive: true, force: true });
});

describe("workflow-execute 工作流执行真实编排", () => {
  // 同步成功应优先返回调度结果中的 end 节点内存输出，并将触发用户传给引擎。
  test("同步成功优先使用 end 节点内存输出", async () => {
    const engine = getTeamEngine(organizationId);
    const runAsync = spyOn(engine, "runAsync").mockReturnValue({
      runId: "run-workflow-execute",
      result: Promise.resolve(runResult("SUCCESS", { finish: { stdout: "", json: { approved: true }, exit_code: 0 } })),
    });
    const getOutput = spyOn(engine, "getOutput");

    const result = await executeWorkflow(
      organizationId,
      workflowId,
      { inputs: { ticket: "T-1" }, mode: "sync" },
      "user-1",
    );

    expect(result).toEqual(
      expect.objectContaining({
        runId: "run-workflow-execute",
        status: "SUCCESS",
        version: 2,
        output: { approved: true },
      }),
    );
    expect(runAsync).toHaveBeenCalledWith(yaml, { ticket: "T-1" }, { userId: "user-1" });
    expect(getOutput).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(snapshotUpdates).toBe(1);
  });

  // 调度结果未携带输出时，同步接口必须回退读取 end 节点持久化输出。
  test("同步成功在内存输出缺失时读取 end 节点输出", async () => {
    const engine = getTeamEngine(organizationId);
    spyOn(engine, "runAsync").mockReturnValue({
      runId: "run-workflow-execute",
      result: Promise.resolve(runResult("SUCCESS")),
    });
    const getOutput = spyOn(engine, "getOutput").mockResolvedValue({
      stdout: '{"result":"stored"}',
      json: { result: "stored" },
      exit_code: 0,
    });

    const result = await executeWorkflow(organizationId, workflowId, { mode: "sync" });

    expect(result).toEqual(expect.objectContaining({ status: "SUCCESS", output: { result: "stored" } }));
    expect(getOutput).toHaveBeenCalledWith("run-workflow-execute", "finish");
  });

  // 引擎以非 SUCCESS 状态结束时，外部接口应将状态收敛为稳定的 FAILED 响应。
  test("同步执行失败返回统一失败状态", async () => {
    const engine = getTeamEngine(organizationId);
    spyOn(engine, "runAsync").mockReturnValue({
      runId: "run-workflow-execute",
      result: Promise.resolve(runResult("CANCELLED")),
    });

    const result = await executeWorkflow(organizationId, workflowId, { mode: "sync" });

    expect(result).toEqual(
      expect.objectContaining({
        status: "FAILED",
        error: { message: "DAG execution failed with status: CANCELLED" },
      }),
    );
  });

  // 异步模式不得等待 DAG 完成，但仍需返回已解析的实际执行版本。
  test("异步执行立即返回运行标识和实际版本", async () => {
    const engine = getTeamEngine(organizationId);
    const runAsync = spyOn(engine, "runAsync").mockReturnValue({
      runId: "run-workflow-execute",
      result: Promise.resolve(runResult("SUCCESS")),
    });

    await expect(executeWorkflow(organizationId, workflowId, { mode: "async" })).resolves.toEqual({
      runId: "run-workflow-execute",
      version: 2,
    });
    expect(runAsync).toHaveBeenCalledWith(yaml, undefined, { userId: undefined });
  });
});
