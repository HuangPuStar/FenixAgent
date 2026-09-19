import { describe, expect, test } from "bun:test";

import { buildRunSummary } from "../lib/use-workflow-events";
import { dedupEvents, formatEventType, formatMeta } from "../pages/workflow/utils";

function translate(key: string, options?: Record<string, unknown>): string {
  return options ? `${key}:${JSON.stringify(options)}` : key;
}

function workflowEvent(eventId: string, type: "node.started" | "node.failed" = "node.started") {
  return {
    event_id: eventId,
    run_id: "run-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    type,
  };
}

describe("工作流纯逻辑高覆盖边界", () => {
  const eventTypes = [
    ["dag.started", "editor.dag_started"],
    ["dag.completed", "editor.dag_completed"],
    ["dag.cancelled", "editor.dag_cancelled"],
    ["node.started", "editor.node_started"],
    ["node.completed", "editor.node_completed"],
    ["node.failed", "editor.node_failed"],
    ["node.cancelled", "editor.node_cancelled"],
    ["node.retrying", "editor.node_retrying"],
    ["node.skipped", "editor.node_skipped"],
    ["sub_workflow.started", "editor.sub_workflow_started"],
    ["sub_workflow.completed", "editor.sub_workflow_completed"],
    ["loop.iteration_started", "editor.loop_iteration_started"],
    ["loop.iteration_completed", "editor.loop_iteration_completed"],
    ["audit.requested", "editor.audit_requested"],
    ["audit.approved", "editor.audit_approved"],
  ];

  for (const [eventType, expected] of eventTypes) {
    test(`事件类型 ${eventType} 转换为中文界面使用的翻译键`, () => {
      expect(formatEventType(translate, eventType)).toBe(expected);
    });
  }

  const completedMetadata: Array<[Record<string, unknown>, string]> = [
    [{ exit_code: 0 }, "exit=0"],
    [{ exit_code: 1 }, "exit=1"],
    [{ exit_code: -9 }, "exit=-9"],
    [{ output_size: 0 }, "0B"],
    [{ output_size: 1 }, "1B"],
    [{ output_size: 1024 }, "1024B"],
    [{ latency_ms: 0 }, "0ms"],
    [{ latency_ms: 0.49 }, "0ms"],
    [{ latency_ms: 0.5 }, "1ms"],
    [{ latency_ms: 12.49 }, "12ms"],
    [{ latency_ms: 12.5 }, "13ms"],
    [{ exit_code: 0, output_size: 0 }, "exit=0 · 0B"],
    [{ exit_code: 0, latency_ms: 1.5 }, "exit=0 · 2ms"],
    [{ output_size: 1, latency_ms: 1.5 }, "1B · 2ms"],
    [{ exit_code: 0, output_size: 1, latency_ms: 1.5 }, "exit=0 · 1B · 2ms"],
  ];

  for (const [metadata, expected] of completedMetadata) {
    test(`完成事件格式化元数据 ${JSON.stringify(metadata)}`, () => {
      expect(formatMeta(translate, "node.completed", metadata)).toBe(expected);
    });
  }

  const failedMetadata: Array<[Record<string, unknown>, string]> = [
    [{ error: "权限不足" }, "权限不足"],
    [{ error: 404 }, "404"],
    [{ error: false }, "false"],
    [{ error: null }, ""],
    [{}, ""],
  ];
  for (const [metadata, expected] of failedMetadata) {
    test(`失败事件将错误值安全格式化为 ${expected || "空文本"}`, () => {
      expect(formatMeta(translate, "node.failed", metadata)).toBe(expected);
    });
  }

  const startedMetadata: Array<[Record<string, unknown>, string]> = [
    [{ pid: 1 }, "pid=1"],
    [{ pid: -1 }, "pid=-1"],
    [{ pid: "worker-1" }, "pid=worker-1"],
    [{ pid: 0 }, ""],
    [{ pid: "" }, ""],
    [{}, ""],
  ];
  for (const [metadata, expected] of startedMetadata) {
    test(`启动事件处理 PID 边界值 ${JSON.stringify(metadata)}`, () => {
      expect(formatMeta(translate, "node.started", metadata)).toBe(expected);
    });
  }

  const durations: Array<[number, string]> = [
    [0, "0s"],
    [1, "0s"],
    [499, "0s"],
    [500, "1s"],
    [999, "1s"],
    [1_000, "1s"],
    [1_499, "1s"],
    [1_500, "2s"],
    [59_499, "59s"],
    [59_500, "60s"],
    [-1, "0s"],
  ];
  for (const [duration, expected] of durations) {
    test(`DAG 完成事件按秒四舍五入时长 ${duration}ms`, () => {
      expect(formatMeta(translate, "dag.completed", { duration_ms: duration })).toBe(expected);
    });
  }

  const retryMetadata: Array<[Record<string, unknown>]> = [
    [{ attempt: 0, next_delay_ms: 0 }],
    [{ attempt: 1, next_delay_ms: 100 }],
    [{ attempt: 2, next_delay_ms: 500 }],
    [{ attempt: "三", next_delay_ms: "稍后" }],
    [{}],
  ];
  for (const [metadata] of retryMetadata) {
    test(`重试事件保留完整重试元数据 ${JSON.stringify(metadata)}`, () => {
      expect(formatMeta(translate, "node.retrying", metadata)).toBe(
        `editor.retry_meta:${JSON.stringify({ attempt: metadata.attempt, delay: metadata.next_delay_ms })}`,
      );
    });
  }

  const summaries: Array<[string, Record<string, { status: string; exit_code?: number }>, string]> = [
    ["SUCCESS", {}, "Run Succeeded (0/0 completed)"],
    ["CANCELLED", {}, "Cancelled (0/0 completed)"],
    ["RUNNING", {}, "Running (0/0 completed)"],
    ["SUSPENDED", {}, "Awaiting Approval (0/0 completed, waiting: none)"],
    ["FAILED", {}, "Run Failed (0/0 completed, 0 failed)"],
    ["ERROR", {}, "Run Failed (0/0 completed, 0 failed)"],
    ["UNKNOWN", {}, "Running (0/0 completed)"],
    ["SUCCESS", { a: { status: "COMPLETED" } }, "Run Succeeded (1/1 completed)"],
    ["CANCELLED", { a: { status: "COMPLETED" } }, "Cancelled (1/1 completed)"],
    ["SUSPENDED", { a: { status: "RUNNING" } }, "Awaiting Approval (0/1 completed, waiting: a)"],
    ["FAILED", { a: { status: "FAILED" } }, "Run Failed (0/1 completed, 1 failed: a)"],
    ["ERROR", { a: { status: "FAILED" }, b: { status: "FAILED" } }, "Run Failed (0/2 completed, 2 failed: a, b)"],
    ["RUNNING", { a: { status: "COMPLETED" }, b: { status: "PENDING" } }, "Running (1/2 completed)"],
  ];
  for (const [dagStatus, nodeStates, expected] of summaries) {
    test(`运行摘要格式化状态 ${dagStatus}`, () => {
      expect(buildRunSummary({ dag_status: dagStatus, node_states: nodeStates })).toBe(expected);
    });
  }

  for (let count = 1; count <= 20; count++) {
    test(`去重保留 ${count} 个不同事件且不修改输入数组`, () => {
      const events = Array.from({ length: count }, (_, index) => workflowEvent(`event-${index}`));
      const snapshot = [...events];

      expect(dedupEvents(events)).toEqual(events);
      expect(events).toEqual(snapshot);
      expect(events).not.toBe(snapshot);
    });
  }

  for (let count = 1; count <= 15; count++) {
    test(`去重丢弃第 ${count} 个重复事件并保留首次对象`, () => {
      const first = workflowEvent(`same-${count}`);
      const duplicate = workflowEvent(`same-${count}`, "node.failed");
      const trailing = workflowEvent(`tail-${count}`);
      const events = [first, duplicate, trailing];

      const result = dedupEvents(events);

      expect(result).toEqual([first, trailing]);
      expect(result[0]).toBe(first);
      expect(events).toEqual([first, duplicate, trailing]);
    });
  }

  const unknownTypes = ["", "node.unknown", "DAG.STARTED", " audit.approved", "audit.approved "];
  for (const eventType of unknownTypes) {
    test(`未知事件类型 ${JSON.stringify(eventType)} 原样返回`, () => {
      expect(formatEventType(translate, eventType)).toBe(eventType);
    });
  }
});
