import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowEngine } from "../../engine/workflow-engine";
import { createInMemoryStorage } from "../../storage/in-memory-storage";

const YAML = `
name: suspended-cancellation
schema_version: "1"
nodes:
  - id: approval
    type: audit
    display_data:
      message: Approve this run
  - id: after
    type: shell
    depends_on: [approval]
    command: echo unexpected
`;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("审批挂起后的取消终态", () => {
  // 审批挂起时取消应立即写入合法终态快照和事件，并关闭待审批入口。
  test("取消挂起运行立即持久化 CANCELLED", async () => {
    const engine = createWorkflowEngine({ storage: createInMemoryStorage(), hmacSecret: "test-secret" });
    const { runId, result } = engine.runAsync(YAML);
    expect((await result).status).toBe("SUSPENDED");
    const pending = await engine.getPendingApprovals(runId);
    expect(pending).toHaveLength(1);

    await engine.cancel(runId);

    const snapshot = await engine.getRunStatus(runId);
    expect(snapshot?.dag_status).toBe("CANCELLED");
    expect(snapshot?.node_states.approval.status).toBe("CANCELLED");
    expect(snapshot?.node_states.after.status).toBe("PENDING");
    const events = await engine.getEvents(runId);
    expect(events.at(-1)?.type).toBe("dag.cancelled");
    expect(snapshot?.last_event_id).toBe(events.at(-1)?.event_id);
    expect(await engine.getPendingApprovals(runId)).toEqual([]);
    await expect(engine.approveNode(runId, pending[0].nodeId, pending[0].approvalToken)).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    expect(await engine.getEvents(runId)).toHaveLength(events.length);
  });

  // 同一挂起运行的并发取消必须共用一次持久化转换。
  test("并发取消只写入一个终态事件和快照", async () => {
    const storage = createInMemoryStorage();
    const engine = createWorkflowEngine({ storage, hmacSecret: "test-secret" });
    const { runId, result } = engine.runAsync(YAML);
    await result;
    const originalRead = storage.getLatestSnapshot.bind(storage);
    const originalWrite = storage.atomicRunCancel.bind(storage);
    const entered = deferred();
    const resume = deferred();
    let writes = 0;
    storage.getLatestSnapshot = async (requestedRunId) => {
      entered.release();
      await resume.promise;
      return originalRead(requestedRunId);
    };
    storage.atomicRunCancel = async (transition) => {
      writes += 1;
      await originalWrite(transition);
    };

    const first = engine.cancel(runId);
    await entered.promise;
    const second = engine.cancel(runId);
    resume.release();
    await Promise.all([first, second]);

    expect(writes).toBe(1);
    expect((await engine.getEvents(runId)).filter((event) => event.type === "dag.cancelled")).toHaveLength(1);
    expect((await engine.getRunStatus(runId))?.dag_status).toBe("CANCELLED");
  });

  // 审批读到旧挂起快照后若取消抢先，审批不得写事件或启动下游 shell。
  test("取消抢占审批快照读取时拒绝审批且不运行下游", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflow-cancel-"));
    const marker = join(directory, "downstream-ran");
    try {
      const storage = createInMemoryStorage();
      const engine = createWorkflowEngine({ storage, hmacSecret: "test-secret" });
      const yaml = YAML.replace("echo unexpected", `printf touched > ${JSON.stringify(marker)}`);
      const { runId, result } = engine.runAsync(yaml);
      await result;
      const [pending] = await engine.getPendingApprovals(runId);
      const originalRead = storage.getLatestSnapshot.bind(storage);
      const entered = deferred();
      const resume = deferred();
      let pauseNextRead = true;
      storage.getLatestSnapshot = async (requestedRunId) => {
        const snapshot = await originalRead(requestedRunId);
        if (pauseNextRead) {
          pauseNextRead = false;
          entered.release();
          await resume.promise;
        }
        return snapshot;
      };

      const approval = engine.approveNode(runId, pending.nodeId, pending.approvalToken);
      await entered.promise;
      const cancellation = engine.cancel(runId);
      resume.release();
      await expect(approval).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
      await cancellation;

      expect((await engine.getRunStatus(runId))?.dag_status).toBe("CANCELLED");
      expect((await engine.getEvents(runId)).filter((event) => event.type === "audit.approved")).toHaveLength(0);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 原子写入失败后保留可重试的运行，第二次取消只产生一次完整终态。
  test("取消持久化失败后可重试", async () => {
    const storage = createInMemoryStorage();
    const engine = createWorkflowEngine({ storage, hmacSecret: "test-secret" });
    const { runId, result } = engine.runAsync(YAML);
    await result;
    const originalWrite = storage.atomicRunCancel.bind(storage);
    let failOnce = true;
    storage.atomicRunCancel = async (transition) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("storage unavailable");
      }
      await originalWrite(transition);
    };

    await expect(engine.cancel(runId)).rejects.toThrow("storage unavailable");
    expect((await engine.getRunStatus(runId))?.dag_status).toBe("SUSPENDED");
    expect((await engine.getEvents(runId)).filter((event) => event.type === "dag.cancelled")).toHaveLength(0);

    await engine.cancel(runId);
    expect((await engine.getRunStatus(runId))?.dag_status).toBe("CANCELLED");
    expect((await engine.getEvents(runId)).filter((event) => event.type === "dag.cancelled")).toHaveLength(1);
  });

  // 持久化已提交但调用方收到错误时，重试应识别终态并释放活跃运行记录。
  test("取消提交成功但确认失败后重试不重复写入", async () => {
    const storage = createInMemoryStorage();
    const engine = createWorkflowEngine({ storage, hmacSecret: "test-secret" });
    const { runId, result } = engine.runAsync(YAML);
    await result;
    const originalWrite = storage.atomicRunCancel.bind(storage);
    let failAfterCommit = true;
    storage.atomicRunCancel = async (transition) => {
      await originalWrite(transition);
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error("commit acknowledgement lost");
      }
    };

    await expect(engine.cancel(runId)).rejects.toThrow("commit acknowledgement lost");
    await engine.cancel(runId);

    expect((await engine.getRunStatus(runId))?.dag_status).toBe("CANCELLED");
    expect((await engine.getEvents(runId)).filter((event) => event.type === "dag.cancelled")).toHaveLength(1);
    await expect(engine.cancel(runId)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });
});
