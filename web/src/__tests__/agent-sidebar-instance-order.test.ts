import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { orderInstancesByRunningStatus } from "../pages/agent-panel/AgentSidebarTree";
import type { EnvironmentInstance } from "../types";

function instance(instanceUid: string, status: EnvironmentInstance["status"]): EnvironmentInstance {
  return { instanceUid, name: instanceUid, status, createdAt: "2026-09-01T00:00:00.000Z" };
}

describe("Agent sidebar Instance 排序", () => {
  // 运行中的绿色实例必须稳定排在非运行实例之前。
  test("绿色实例在前且组内保持原顺序", () => {
    const instances = [
      instance("stopped-a", "stopped"),
      instance("running-a", "running"),
      instance("unknown-a", "unknown"),
      instance("running-b", "running"),
      instance("starting-a", "starting"),
    ];

    expect(orderInstancesByRunningStatus(instances).map((item) => item.instanceUid)).toEqual([
      "running-a",
      "running-b",
      "stopped-a",
      "unknown-a",
      "starting-a",
    ]);
  });

  // 排序不得原地修改 API 返回数组，避免轮询缓存和其他消费者观察到隐式重排。
  test("不修改输入数组", () => {
    const instances = [instance("stopped-a", "stopped"), instance("running-a", "running")];

    orderInstancesByRunningStatus(instances);

    expect(instances.map((item) => item.instanceUid)).toEqual(["stopped-a", "running-a"]);
  });
});

// 智能体区域上边框必须装配为垂直可拖动分隔线。
test("智能体区域使用可拖动上边框调整高度", () => {
  const source = readFileSync(resolve(import.meta.dir, "../pages/agent-panel/AgentSidebar.tsx"), "utf8");
  const handleIndex = source.indexOf('className="agent-sidebar-tree-resize-handle"');
  const treeIndex = source.indexOf('className="agent-sidebar-tree-wrap h-full min-h-0 overflow-hidden"');

  expect(source).toContain('<ResizablePanelGroup orientation="vertical" className="agent-sidebar-sections">');
  expect(source.match(/<ResizablePanel /g)).toHaveLength(2);
  expect(handleIndex).toBeGreaterThan(0);
  expect(treeIndex).toBeGreaterThan(handleIndex);
  expect(source).toContain('aria-label={tSidebar("resizeAgentArea")}');
});
