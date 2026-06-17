import { expect, test } from "bun:test";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { DAGEvent, DAGSnapshot, NodeOutput } from "../../types/execution";

// 辅助：创建测试事件
function makeEvent(overrides: Partial<DAGEvent> & Pick<DAGEvent, "event_id" | "run_id">): DAGEvent {
  return {
    timestamp: new Date().toISOString(),
    type: "node.started",
    ...overrides,
  };
}

// 辅助：创建测试快照
function makeSnapshot(overrides: Partial<DAGSnapshot> & Pick<DAGSnapshot, "snapshot_id" | "run_id">): DAGSnapshot {
  return {
    last_event_id: "evt_0",
    timestamp: new Date().toISOString(),
    node_states: {},
    dag_status: "RUNNING",
    ...overrides,
  };
}

// 辅助：创建测试输出
function makeOutput(): NodeOutput {
  return { stdout: "done", exit_code: 0 };
}

// ---------- appendEvent / getEvents ----------

// 追加事件后可查询到
test("appendEvent 后 getEvents 返回事件", async () => {
  const s = createInMemoryStorage();
  const evt = makeEvent({ event_id: "e1", run_id: "run_1" });
  await s.appendEvent(evt);
  const result = await s.getEvents("run_1");
  expect(result).toHaveLength(1);
  expect(result[0].event_id).toBe("e1");
});

// getEvents 按 nodeId 过滤
test("getEvents 按 nodeId 过滤", async () => {
  const s = createInMemoryStorage();
  await s.appendEvent(makeEvent({ event_id: "e1", run_id: "r1", node_id: "n1" }));
  await s.appendEvent(makeEvent({ event_id: "e2", run_id: "r1", node_id: "n2" }));
  await s.appendEvent(makeEvent({ event_id: "e3", run_id: "r1", node_id: "n1" }));

  const result = await s.getEvents("r1", { nodeId: "n1" });
  expect(result).toHaveLength(2);
  expect(result.map((e) => e.event_id)).toEqual(["e1", "e3"]);
});

// getEvents 按 types 过滤
test("getEvents 按 types 过滤", async () => {
  const s = createInMemoryStorage();
  await s.appendEvent(makeEvent({ event_id: "e1", run_id: "r1", type: "node.started" }));
  await s.appendEvent(makeEvent({ event_id: "e2", run_id: "r1", type: "node.completed" }));
  await s.appendEvent(makeEvent({ event_id: "e3", run_id: "r1", type: "node.started" }));

  const result = await s.getEvents("r1", { types: ["node.completed"] });
  expect(result).toHaveLength(1);
  expect(result[0].event_id).toBe("e2");
});

// getEvents 按 afterEventId 过滤
test("getEvents 按 afterEventId 过滤", async () => {
  const s = createInMemoryStorage();
  await s.appendEvent(makeEvent({ event_id: "e1", run_id: "r1" }));
  await s.appendEvent(makeEvent({ event_id: "e2", run_id: "r1" }));
  await s.appendEvent(makeEvent({ event_id: "e3", run_id: "r1" }));

  const result = await s.getEvents("r1", { afterEventId: "e1" });
  expect(result).toHaveLength(2);
  expect(result.map((e) => e.event_id)).toEqual(["e2", "e3"]);
});

// getEvents 组合过滤：nodeId + types
test("getEvents 组合过滤 nodeId + types", async () => {
  const s = createInMemoryStorage();
  await s.appendEvent(makeEvent({ event_id: "e1", run_id: "r1", node_id: "n1", type: "node.started" }));
  await s.appendEvent(makeEvent({ event_id: "e2", run_id: "r1", node_id: "n1", type: "node.completed" }));
  await s.appendEvent(makeEvent({ event_id: "e3", run_id: "r1", node_id: "n2", type: "node.completed" }));

  const result = await s.getEvents("r1", { nodeId: "n1", types: ["node.completed"] });
  expect(result).toHaveLength(1);
  expect(result[0].event_id).toBe("e2");
});

// getEvents 不存在的 runId 返回空数组
test("getEvents 不存在的 runId 返回空数组", async () => {
  const s = createInMemoryStorage();
  const result = await s.getEvents("nonexistent");
  expect(result).toEqual([]);
});

// ---------- 快照 ----------

// createSnapshot + getLatestSnapshot
test("createSnapshot 后 getLatestSnapshot 返回最新快照", async () => {
  const s = createInMemoryStorage();
  const snap1 = makeSnapshot({ snapshot_id: "s1", run_id: "r1", dag_status: "RUNNING" });
  const snap2 = makeSnapshot({ snapshot_id: "s2", run_id: "r1", dag_status: "SUCCESS" });
  await s.createSnapshot(snap1);
  await s.createSnapshot(snap2);

  const latest = await s.getLatestSnapshot("r1");
  expect(latest?.snapshot_id).toBe("s2");
  expect(latest?.dag_status).toBe("SUCCESS");
});

// getLatestSnapshot 不存在返回 null
test("getLatestSnapshot 不存在返回 null", async () => {
  const s = createInMemoryStorage();
  const result = await s.getLatestSnapshot("nonexistent");
  expect(result).toBeNull();
});

// ---------- 节点输出 ----------

// setOutput + getOutput
test("setOutput 后 getOutput 返回正确值", async () => {
  const s = createInMemoryStorage();
  const output: NodeOutput = { stdout: "hello", exit_code: 0, json: { key: "val" } };
  await s.setOutput("r1", "n1", output);

  const result = await s.getOutput("r1", "n1");
  expect(result).toEqual(output);
});

// getOutput 不存在返回 null
test("getOutput 不存在返回 null", async () => {
  const s = createInMemoryStorage();
  const result = await s.getOutput("r1", "n1");
  expect(result).toBeNull();
});

// ---------- 运行查询 ----------

// listRuns + getRunStatus
test("listRuns 返回所有运行摘要", async () => {
  const s = createInMemoryStorage();
  // listRuns 内部读取 runSummaries map，但该 map 只通过 atomicNodeComplete 间接写入
  const result = await s.listRuns({ page: 1, pageSize: 20 });
  expect(result).toEqual({ items: [], total: 0 });
});

// getRunStatus 不存在返回 null
test("getRunStatus 不存在返回 null", async () => {
  const s = createInMemoryStorage();
  const result = await s.getRunStatus("nonexistent");
  expect(result).toBeNull();
});

// ---------- atomicNodeComplete ----------

// atomicNodeComplete 同时写入 output、snapshot、event
test("atomicNodeComplete 写入 output + snapshot + event", async () => {
  const s = createInMemoryStorage();
  const output: NodeOutput = { stdout: "result", exit_code: 0 };
  const snapshot = makeSnapshot({
    snapshot_id: "snap_1",
    run_id: "r1",
    last_event_id: "evt_1",
    dag_status: "RUNNING",
    node_states: { n1: { status: "COMPLETED", exit_code: 0 } },
  });
  const event = makeEvent({
    event_id: "evt_1",
    run_id: "r1",
    node_id: "n1",
    type: "node.completed",
  });

  await s.atomicNodeComplete({ output, snapshot, event });

  // 验证 output
  const out = await s.getOutput("r1", "n1");
  expect(out).toEqual(output);

  // 验证 snapshot
  const snap = await s.getLatestSnapshot("r1");
  expect(snap?.snapshot_id).toBe("snap_1");

  // 验证 event
  const evts = await s.getEvents("r1");
  expect(evts).toHaveLength(1);
  expect(evts[0].event_id).toBe("evt_1");
});

// atomicNodeComplete 多次调用，快照和事件都追加
test("atomicNodeComplete 多次调用正确追加", async () => {
  const s = createInMemoryStorage();

  await s.atomicNodeComplete({
    output: { stdout: "a", exit_code: 0 },
    snapshot: makeSnapshot({ snapshot_id: "s1", run_id: "r1" }),
    event: makeEvent({ event_id: "e1", run_id: "r1", node_id: "n1" }),
  });
  await s.atomicNodeComplete({
    output: { stdout: "b", exit_code: 0 },
    snapshot: makeSnapshot({ snapshot_id: "s2", run_id: "r1" }),
    event: makeEvent({ event_id: "e2", run_id: "r1", node_id: "n2" }),
  });

  const latestSnap = await s.getLatestSnapshot("r1");
  expect(latestSnap?.snapshot_id).toBe("s2");

  const evts = await s.getEvents("r1");
  expect(evts).toHaveLength(2);

  const out1 = await s.getOutput("r1", "n1");
  expect(out1?.stdout).toBe("a");
  const out2 = await s.getOutput("r1", "n2");
  expect(out2?.stdout).toBe("b");
});

// ---------- deleteRun ----------

// deleteRun 清理所有关联数据
test("deleteRun 清理所有关联数据", async () => {
  const s = createInMemoryStorage();

  // 先写入数据
  await s.appendEvent(makeEvent({ event_id: "e1", run_id: "r1", node_id: "n1" }));
  await s.createSnapshot(makeSnapshot({ snapshot_id: "s1", run_id: "r1" }));
  await s.setOutput("r1", "n1", makeOutput());
  await s.atomicNodeComplete({
    output: { stdout: "atomic", exit_code: 0 },
    snapshot: makeSnapshot({ snapshot_id: "s2", run_id: "r1" }),
    event: makeEvent({ event_id: "e2", run_id: "r1", node_id: "n1", type: "node.completed" }),
  });

  // 确认数据存在
  expect(await s.getEvents("r1")).toHaveLength(2);
  expect(await s.getLatestSnapshot("r1")).not.toBeNull();
  expect(await s.getOutput("r1", "n1")).not.toBeNull();

  // 删除
  await s.deleteRun("r1");

  // 验证全部清理
  expect(await s.getEvents("r1")).toEqual([]);
  expect(await s.getLatestSnapshot("r1")).toBeNull();
  expect(await s.getOutput("r1", "n1")).toBeNull();
});

// deleteRun 不存在的 runId 不报错
test("deleteRun 不存在的 runId 不报错", async () => {
  const s = createInMemoryStorage();
  await expect(s.deleteRun("nonexistent")).resolves.toBeUndefined();
});

// ---------- 隔离性 ----------

// 不同 runId 数据隔离
test("不同 runId 数据隔离", async () => {
  const s = createInMemoryStorage();
  await s.appendEvent(makeEvent({ event_id: "e1", run_id: "r1" }));
  await s.appendEvent(makeEvent({ event_id: "e2", run_id: "r2" }));

  expect(await s.getEvents("r1")).toHaveLength(1);
  expect(await s.getEvents("r2")).toHaveLength(1);
  expect(await s.getEvents("r1", { afterEventId: "e1" })).toEqual([]);
});
