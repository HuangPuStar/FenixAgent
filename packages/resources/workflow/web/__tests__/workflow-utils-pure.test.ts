import { describe, expect, test } from "bun:test";
import type { DAGEvent } from "../api/workflow-engine";
import { DAG_STATUS_CFG, dedupEvents, formatEventType, formatMeta, relativeTime } from "../pages/workflow/utils";

function event(eventId: string): DAGEvent {
  return {
    event_id: eventId,
    run_id: "run-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "node.started",
  };
}

function translate(key: string, options?: Record<string, unknown>): string {
  return options ? `${key}:${JSON.stringify(options)}` : key;
}

describe("workflow utils", () => {
  // 工作流事件流可能因重连重复投递，应按 event_id 保留首次出现的事件及原始顺序。
  test("dedupEvents 按 event_id 去重并保留首次事件", () => {
    const first = event("evt-1");
    const duplicate = { ...event("evt-1"), type: "node.failed" as const };
    const second = event("evt-2");

    expect(dedupEvents([first, duplicate, second])).toEqual([first, second]);
    expect(dedupEvents([])).toEqual([]);
  });

  // 状态配置应覆盖所有已声明的 DAG 状态，供页面在未知状态前保持显式映射边界。
  test("DAG_STATUS_CFG 为全部工作流状态提供展示配置", () => {
    expect(Object.keys(DAG_STATUS_CFG).sort()).toEqual([
      "CANCELLED",
      "ERROR",
      "FAILED",
      "PENDING",
      "RUNNING",
      "SUCCESS",
      "SUSPENDED",
    ]);
    expect(DAG_STATUS_CFG.SUCCESS).toEqual({ color: "#22c55e", bg: "#f0fdf4", labelKey: "editor.dag_status_success" });
  });

  // 相对时间应处理缺失、未来以及分钟/小时/天等阈值，超过一周回退为日期字符串。
  test("relativeTime 根据时间差选择正确的展示粒度", () => {
    const now = Date.now();
    const isoBefore = (milliseconds: number) => new Date(now - milliseconds).toISOString();
    const future = new Date(now + 1_000).toISOString();

    expect(relativeTime(translate)).toBe("--");
    expect(relativeTime(translate, future)).toBe("runs.relative_now");
    expect(relativeTime(translate, isoBefore(30_000))).toBe("runs.relative_now");
    expect(relativeTime(translate, isoBefore(2 * 60_000))).toBe('runs.relative_minutes:{"count":2}');
    expect(relativeTime(translate, isoBefore(3 * 3_600_000))).toBe('runs.relative_hours:{"count":3}');
    expect(relativeTime(translate, isoBefore(4 * 86_400_000))).toBe('runs.relative_days:{"count":4}');
    expect(relativeTime(translate, isoBefore(8 * 86_400_000))).toBe(
      new Date(isoBefore(8 * 86_400_000)).toLocaleDateString(),
    );
  });

  // 已知事件应通过 i18n key 转换，未知事件必须保留原值避免丢失诊断信息。
  test("formatEventType 转换已知事件并保留未知事件", () => {
    expect(formatEventType(translate, "node.retrying")).toBe("editor.node_retrying");
    expect(formatEventType(translate, "custom.diagnostic")).toBe("custom.diagnostic");
  });

  // 事件元数据应按事件语义格式化，并在可选字段缺失或未知事件时返回空文本。
  test("formatMeta 处理完成、失败、重试、启动和 DAG 完成分支", () => {
    expect(formatMeta(translate, "node.completed", { exit_code: 0, output_size: 128, latency_ms: 12.6 })).toBe(
      "exit=0 · 128B · 13ms",
    );
    expect(formatMeta(translate, "node.completed", {})).toBe("");
    expect(formatMeta(translate, "node.failed", { error: new Error("internal") })).toBe("Error: internal");
    expect(formatMeta(translate, "node.failed", {})).toBe("");
    expect(formatMeta(translate, "node.retrying", { attempt: 2, next_delay_ms: 500 })).toBe(
      'editor.retry_meta:{"attempt":2,"delay":500}',
    );
    expect(formatMeta(translate, "node.started", { pid: 42 })).toBe("pid=42");
    expect(formatMeta(translate, "node.started", { pid: 0 })).toBe("");
    expect(formatMeta(translate, "dag.completed", { duration_ms: 1_550 })).toBe("2s");
    expect(formatMeta(translate, "dag.completed", {})).toBe("");
    expect(formatMeta(translate, "audit.approved", { approver: "user-1" })).toBe("");
  });
});
