import { describe, expect, test } from "bun:test";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { narrate } from "@/components/chat/narrators";
import zhToolNarrator from "@/src/i18n/locales/zh/toolNarrator.json";
import type { ToolCallData } from "@/src/lib/types";

/**
 * narrate() 中央入口测试。
 *
 * 用真实的 i18n 实例（绑定到 toolNarrator 命名空间）+ 真实 fallback narrator，
 * 覆盖：状态归一化、副标题模板、状态词、徽章优先级、错误提取、detail 字段。
 *
 * 注意：此测试运行时注册表里只有 fallback narrator
 * （其他专用 narrator 在后续 task 加入），所以测试用 "SomeUnknownTool" 触发兜底。
 */

// 初始化测试用 i18n 实例（绑定到 toolNarrator 命名空间，使用中文 JSON）
i18n.use(initReactI18next).init({
  resources: { zh: { toolNarrator: zhToolNarrator } },
  lng: "zh",
  ns: ["toolNarrator"],
  defaultNS: "toolNarrator",
  interpolation: { escapeValue: false },
});

const t = i18n.getFixedT("zh", "toolNarrator");

// 构造工具调用数据，默认是 complete 状态的 unknown 工具（走 fallback narrator）
function makeTool(overrides: Partial<ToolCallData> = {}): ToolCallData {
  return {
    id: "test-id",
    title: "UnknownTool",
    status: "complete",
    kind: "unknown",
    ...overrides,
  };
}

describe("narrate 中央入口", () => {
  // 未匹配任何专用 narrator 时走 fallback，title 句子里的动词应该是"使用"
  test("未匹配工具走 fallback，verb 为'使用'", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "complete", undefined, t);
    expect(result.title).toContain("使用");
  });

  // complete 状态 title 不应包含进行时前缀"正在"
  test("complete 状态 title 用过去时模板", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "complete", undefined, t);
    expect(result.title).not.toContain("正在");
  });

  // running 状态 title 应该带"正在"前缀
  test("running 状态 title 用进行时模板（含'正在'）", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "running", undefined, t);
    expect(result.title).toContain("正在");
  });

  // rejected 状态应归一化为 canceled，状态词显示"已取消"
  test("rejected 状态归一化为 canceled", () => {
    const tool = makeTool({ title: "SomeUnknownTool", status: "rejected" });
    const result = narrate(tool, "rejected", undefined, t);
    expect(result.statusLabel).toBe("已取消");
  });

  // complete 状态 + elapsedMs 应生成耗时徽章
  test("complete 状态有耗时徽章", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "complete", 1500, t);
    expect(result.badge?.text).toBe("1.5s");
  });

  // running 状态即使有 elapsedMs 也不显示徽章（任务还在跑，时间无意义）
  test("running 状态无耗时徽章", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "running", 1500, t);
    expect(result.badge).toBeUndefined();
  });

  // error 状态从 rawOutput 提取错误信息，状态词显示"失败"
  test("error 状态从 rawOutput 提取 errorDetail", () => {
    const tool = makeTool({
      title: "SomeUnknownTool",
      status: "error",
      rawOutput: { isError: true, content: [{ type: "text", text: "File not found" }] },
    });
    const result = narrate(tool, "error", undefined, t);
    expect(result.errorDetail).toBe("File not found");
    expect(result.statusLabel).toBe("失败");
  });

  // detail 字段需保留 rawInput / rawOutput 供 Dialog 展示
  test("detail 字段保留原始 rawInput 和 rawOutput", () => {
    const rawInput = { foo: "bar" };
    const rawOutput = { baz: "qux" };
    const tool = makeTool({ title: "SomeUnknownTool", rawInput, rawOutput });
    const result = narrate(tool, "complete", undefined, t);
    expect(result.detail.rawInput).toEqual(rawInput);
    expect(result.detail.rawOutput).toEqual(rawOutput);
  });

  // 5 种归一化状态都应该返回非空 statusLabel
  test("所有状态都有 statusLabel", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const statuses = ["running", "complete", "error", "waiting_for_confirmation", "canceled"] as const;
    for (const status of statuses) {
      const result = narrate(tool, status, undefined, t);
      expect(typeof result.statusLabel).toBe("string");
      expect(result.statusLabel.length).toBeGreaterThan(0);
    }
  });
});
