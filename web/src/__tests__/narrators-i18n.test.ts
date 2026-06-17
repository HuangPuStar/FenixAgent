import { describe, expect, test } from "bun:test";
import en from "@/src/i18n/locales/en/toolNarrator.json";
import zh from "@/src/i18n/locales/zh/toolNarrator.json";

/**
 * toolNarrator i18n 完整性测试。
 *
 * 校验中英文 JSON 都包含必要的 key，避免 narrator 运行时
 * 因缺失 key 而 fallback 到 raw key。重点保证：
 * - common.status.* 5 个状态词双语言全覆盖
 * - common.subtitle / subtitleRunning 副标题模板存在
 * - 5 个工具特有徽章 scope 双语同步
 */

const REQUIRED_STATUS_KEYS = ["running", "complete", "error", "waiting_for_confirmation", "canceled"] as const;

describe("toolNarrator i18n 完整性", () => {
  // 中文版必须覆盖所有 5 个状态词
  test("中文版包含所有 common.status.* key", () => {
    for (const key of REQUIRED_STATUS_KEYS) {
      expect(zh.common.status as Record<string, string>).toHaveProperty(key);
    }
  });

  // 英文版必须覆盖所有 5 个状态词
  test("英文版包含所有 common.status.* key", () => {
    for (const key of REQUIRED_STATUS_KEYS) {
      expect(en.common.status as Record<string, string>).toHaveProperty(key);
    }
  });

  // 副标题模板双语言都必须存在
  test("中英文都有 common.subtitle 和 common.subtitleRunning", () => {
    expect(zh.common).toHaveProperty("subtitle");
    expect(zh.common).toHaveProperty("subtitleRunning");
    expect(en.common).toHaveProperty("subtitle");
    expect(en.common).toHaveProperty("subtitleRunning");
  });

  // 副标题模板必须包含 verb 和 object 占位符（保证 narrate() 拼接成功）
  test("subtitle 模板包含 {{verb}} 和 {{object}} 占位符", () => {
    expect(zh.common.subtitle).toContain("{{verb}}");
    expect(zh.common.subtitle).toContain("{{object}}");
    expect(en.common.subtitle).toContain("{{verb}}");
    expect(en.common.subtitle).toContain("{{object}}");
  });

  // 进行时副标题模板必须包含 object 占位符
  test("subtitleRunning 模板包含 {{object}} 占位符", () => {
    expect(zh.common.subtitleRunning).toContain("{{object}}");
    expect(en.common.subtitleRunning).toContain("{{object}}");
  });

  // 行号区间和路径后缀的双语插值模板必须存在
  test("中英文都有 common.lineRange 和 common.inPath", () => {
    expect(zh.common).toHaveProperty("lineRange");
    expect(zh.common).toHaveProperty("inPath");
    expect(en.common).toHaveProperty("lineRange");
    expect(en.common).toHaveProperty("inPath");
  });

  // 5 个工具徽章 scope 必须双语言同步（edit / grep / glob / webSearch / todo）
  test("工具特有徽章 key 双语同步", () => {
    const badgeScopes = ["edit", "grep", "glob", "webSearch", "todo"];
    for (const scope of badgeScopes) {
      expect(zh).toHaveProperty(scope);
      expect(en).toHaveProperty(scope);
    }
  });
});
