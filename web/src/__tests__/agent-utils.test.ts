import { describe, expect, test } from "bun:test";
import { isValidAgentNameInput } from "../lib/agent-utils";

describe("Agent 名称输入校验", () => {
  // 名称中的普通空格是展示语义的一部分，创建 Agent 时必须允许提交。
  test("允许内部空格", () => {
    expect(isValidAgentNameInput("销售 助手")).toBe(true);
  });

  // 空白或首尾带空格的名称会造成显示与查询语义不一致，仍应拒绝。
  test.each(["", "   ", " 助手", "助手 "])("拒绝无效空白边界：%p", (name) => {
    expect(isValidAgentNameInput(name)).toBe(false);
  });

  // 服务端资源命名仍禁止连续连字符，前端必须保持相同约束。
  test("拒绝连续连字符", () => {
    expect(isValidAgentNameInput("销售--助手")).toBe(false);
  });
});
