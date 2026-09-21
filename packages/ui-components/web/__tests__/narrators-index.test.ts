import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { narrate } from "../chat/narrators";
import type { ToolCallData } from "../chat/types";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * narrate() 中央入口测试。
 *
 * 用真实的 i18n 实例（绑定到包内 `uiComponents` 命名空间的 `chat.toolNarrator` 子树）
 * + 真实 fallback narrator，覆盖：状态归一化、副标题模板、状态词、徽章优先级、
 * 错误提取、detail 字段。
 *
 * 注意：makeTool 固定写入 `kind: "unknown"`，注册表未命中任何专用 narrator 即走 fallback，
 * 所以测试用 "SomeUnknownTool" 触发兜底。
 *
 * 来源：`packages/agent-runtime/web/__tests__/narrators-index.test.ts` 逐字迁移，
 * 仅改写导入路径（narrate / 类型改指包内 `../chat/**`），并把 i18n 从宿主
 * `zh/toolNarrator.json` 换成包内 `locales/zh/uiComponents.json` 的 `chat.toolNarrator` 子树。
 *
 * 语言沿用 zh：本文件的用例名、中文注释与断言都锚在中文文案（"调用工具" / "正在" /
 * "已取消" / "失败"）上，且 narrator 的 verb、helpers 的兜底文案本身也硬编码中文；
 * 包内 en 字典的 `common.subtitleRunning` / `common.status.*` 不含这些字样，
 * 换成 en 会让"进行时模板（含'正在'）"等用例失去原意。
 */

// 初始化测试用 i18n 实例（绑定到包内 uiComponents 命名空间，使用中文字典）
// 不使用 initReactI18next —— 测试不依赖 React context，直接用 i18next 原生 API 即可
const i18n = createInstance();
void i18n.init({
  resources: { zh: { [UI_COMPONENTS_NS]: zh } },
  lng: "zh",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
});

const t = i18n.getFixedT("zh", UI_COMPONENTS_NS);

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
  // 未匹配任何专用 narrator 时走 fallback，title 句子应明确表达工具调用。
  test("未匹配工具走 fallback，verb 为'调用工具'", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "complete", undefined, t);
    expect(result.title).toContain("调用工具");
  });

  // fallback 的路径型 detail 应压缩为末级名称，完整参数仍可在详情弹窗查看。
  test("fallback 压缩路径型 detail", () => {
    const tool = makeTool({ rawInput: { path: "/Users/konghayao/code/pazhou/remote-control-server" } });
    const result = narrate(tool, "complete", undefined, t);
    expect(result.subtitle).toBe("remote-control-server");
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

  // error 状态优先用后端脱敏的 publicError.message，rawOutput 仅作缺失时兜底
  test("error 状态优先展示 publicError.message", () => {
    const tool = makeTool({
      title: "SomeUnknownTool",
      status: "error",
      publicError: {
        type: "ACTION.FAILED",
        id: "err_00000000000000000000000000000001",
        message: "The action failed.",
      },
      rawOutput: { isError: true, content: [{ type: "text", text: "raw stderr" }] },
    });
    const result = narrate(tool, "error", undefined, t);
    expect(result.errorDetail).toBe("The action failed.");
    expect(result.errorDetail).not.toContain("raw stderr");
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
