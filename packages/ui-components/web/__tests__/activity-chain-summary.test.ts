import { describe, expect, test } from "bun:test";
import { isActivityChainActive, summarizeActivityChain } from "../chat/lib/activity-chain-summary";
import type { ChatRenderItem } from "../chat/lib/chat-render-layout";
import type { AssistantMessageEntry, ToolCallData, ToolCallEntry } from "../chat/types";

/**
 * 活动链折叠投影的纯函数测试。
 *
 * 覆盖折叠标题所需的三类信息：类别计数（按首次出现顺序）、失败/运行态、思考块有无；
 * 以及「运行中展开、完成后折叠」所依赖的 `isActivityChainActive` 判定。
 */

function tool(id: string, kind: ToolCallData["kind"], status: ToolCallData["status"] = "complete"): ToolCallEntry {
  return { type: "tool_call", toolCall: { id, title: id, status, kind } };
}

function group(...entries: ToolCallEntry[]): ChatRenderItem {
  return { type: "tool_group", entries, density: "activity" };
}

function thought(id: string, text: string): ChatRenderItem {
  const entry: AssistantMessageEntry = { type: "assistant_message", id, chunks: [{ type: "thought", text }] };
  return { type: "entry", entry, density: "activity" };
}

type EntryItem = Extract<ChatRenderItem, { type: "entry" }>;

function message(id: string): EntryItem {
  const entry: AssistantMessageEntry = { type: "assistant_message", id, chunks: [{ type: "message", text: "正文" }] };
  return { type: "entry", entry, density: "activity" };
}

describe("活动链摘要", () => {
  // 同类工具必须合并计数，且类别顺序沿用首次出现顺序，避免流式追加时标题跳动。
  test("按首次出现顺序累计工具类别", () => {
    const summary = summarizeActivityChain([
      thought("t1", "先读文件"),
      group(tool("r1", "read-file"), tool("g1", "grep"), tool("r2", "read-directory")),
      group(tool("e1", "edit")),
    ]);

    expect(summary.toolCount).toBe(4);
    expect(summary.categories).toEqual([
      { category: "read", count: 2 },
      { category: "search", count: 1 },
      { category: "edit", count: 1 },
    ]);
    expect(summary.hasThought).toBe(true);
    expect(summary.running).toBe(false);
  });

  // 失败与运行态驱动标题的警示文案；空白思考块不算「思考过」。
  test("统计失败工具与运行态并忽略空白思考", () => {
    const summary = summarizeActivityChain([
      thought("t1", "   "),
      group(tool("b1", "bash", "error"), tool("b2", "bash", "running")),
    ]);

    expect(summary.errorCount).toBe(1);
    expect(summary.running).toBe(true);
    expect(summary.hasThought).toBe(false);
  });

  // 未知 kind 归入通用 tool 类别，避免摘要丢计数。
  test("未知工具类型归入通用类别", () => {
    const summary = summarizeActivityChain([group(tool("u1", undefined), tool("u2", "unknown"))]);

    expect(summary.categories).toEqual([{ category: "tool", count: 2 }]);
  });
});

describe("活动链运行态判定", () => {
  // 只要还有工具未进入终态，活动链就保持展开。
  test("存在运行中或待确认工具时视为运行中", () => {
    expect(isActivityChainActive([group(tool("a", "read-file", "running"))], false)).toBe(true);
    expect(isActivityChainActive([group(tool("a", "read-file", "waiting_for_confirmation"))], false)).toBe(true);
  });

  // 加载中且末项正是会话末条助手消息时，思考仍在继续，不能提前折叠。
  test("加载中且末项为当前会话助手消息时视为运行中", () => {
    const item = message("m1");
    expect(isActivityChainActive([group(tool("a", "read-file")), item], true, item.entry)).toBe(true);
    expect(isActivityChainActive([group(tool("a", "read-file")), item], false, item.entry)).toBe(false);
    expect(isActivityChainActive([group(tool("a", "read-file", "running")), item], false, item.entry)).toBe(true);
  });

  // 加载新回复时旧活动链末项已不是会话末条条目，不能因 isLoading 短暂展开旧链。
  test("加载中但末项不是会话末条条目时不视为运行中", () => {
    const stale = message("m1");
    const latest = message("m2");

    expect(isActivityChainActive([group(tool("a", "read-file")), stale], true, latest.entry)).toBe(false);
    expect(isActivityChainActive([group(tool("a", "read-file")), stale], true)).toBe(false);
  });

  // 工具刚完成、下一个条目尚未到达时本轮仍在加载，链必须保持展开。
  test("加载中且末条条目是本链内的终态工具时视为运行中", () => {
    const completed = tool("a", "read-file");

    expect(isActivityChainActive([thought("t1", "思考"), group(completed)], true, completed)).toBe(true);
    // 末条条目属于别的链时，本链仍按已结束处理。
    expect(isActivityChainActive([thought("t1", "思考"), group(completed)], true, tool("b", "grep"))).toBe(false);
  });
});
