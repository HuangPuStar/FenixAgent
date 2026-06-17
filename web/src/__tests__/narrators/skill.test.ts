import { describe, expect, test } from "bun:test";
import { skillNarrator } from "@/components/chat/narrators/skill";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * skillNarrator 单测。
 *
 * 覆盖：match 规则（skill/loadedskill/loaded skill）、verb、description 优先、
 * title 提取 skill 名、兜底逻辑。
 */

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(title: string, description?: string): NarrationContext {
  return {
    tool: {
      id: "t1",
      title,
      status: "complete",
      description,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("skillNarrator", () => {
  // 匹配 skill / loadedskill / loaded skill 三种命名变体，read 不命中
  test("匹配 loaded skill / skill", () => {
    expect(skillNarrator.match("loaded skill")).toBe(true);
    expect(skillNarrator.match("skill")).toBe(true);
    expect(skillNarrator.match("loadedskill")).toBe(true);
    expect(skillNarrator.match("read")).toBe(false);
  });

  // 中文动词"载"——传达"加载技能"语义
  test("verb 是 '载'", () => {
    expect(skillNarrator.verb).toBe("载");
  });

  // 有 description 时优先使用 description（比 title 中的 skill 名更可读）
  test("title 包含 loaded skill 时直接用 description", () => {
    const { title } = skillNarrator.getDisplay(makeCtx("Loaded Skill: commit", "Git 提交助手"));
    expect(title).toBe("Git 提交助手");
  });

  // 无 description 时从 title "Loaded Skill: xxx" 提取 xxx
  test("无 description 时从 title 提取 skill 名", () => {
    const { title } = skillNarrator.getDisplay(makeCtx("Loaded Skill: commit"));
    expect(title).toBe("commit");
  });

  // title 只是 "skill" 时（无冒号），原样返回兜底
  test("title 只是 'skill' 时兜底", () => {
    const { title } = skillNarrator.getDisplay(makeCtx("skill"));
    expect(title).toBe("skill");
  });
});
