import { describe, expect, test } from "bun:test";

const { buildRunSummary } = await import("../lib/use-workflow-events");

describe("buildRunSummary", () => {
  test("返回 null 当 dag_status 为 PENDING 且无节点状态", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "PENDING",
      node_states: {},
    };
    expect(buildRunSummary(snap)).toBeNull();
  });

  test("返回运行中摘要", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "RUNNING",
      node_states: {
        shell_1: { status: "COMPLETED" },
        python_1: { status: "COMPLETED" },
        agent_1: { status: "RUNNING" },
        audit_1: { status: "PENDING" },
      },
    };
    const result = buildRunSummary(snap);
    expect(result).toContain("2/4");
    expect(result).toContain("运行中");
  });

  test("返回运行成功摘要", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "SUCCESS",
      node_states: {
        shell_1: { status: "COMPLETED" },
        python_1: { status: "COMPLETED" },
      },
    };
    const result = buildRunSummary(snap);
    expect(result).toContain("成功");
    expect(result).toContain("2/2");
  });

  test("返回失败摘要，包含失败节点", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "FAILED",
      node_states: {
        shell_1: { status: "COMPLETED" },
        python_1: { status: "FAILED", exit_code: 1 },
        agent_1: { status: "CANCELLED" },
      },
    };
    const result = buildRunSummary(snap);
    expect(result).toContain("失败");
    expect(result).toContain("python_1");
  });

  test("返回等待审批摘要", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "SUSPENDED",
      node_states: {
        shell_1: { status: "COMPLETED" },
        audit_1: { status: "RUNNING" },
      },
    };
    const result = buildRunSummary(snap);
    expect(result).toContain("等待审批");
    expect(result).toContain("audit_1");
  });
});
