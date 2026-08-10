// 构建下发渲染 golden 对比（设计 §7：subagent md 渲染契约）。
// renderAgentFileMarkdown 的输出必须能被 gray-matter 原样解析回 AgentFileSpec
// 等价结构（与内置模板解析器共用 frontmatter 语义，防止格式漂移）。

import { describe, expect, test } from "bun:test";
import { type AgentFileSpec, renderAgentFileMarkdown } from "@fenix/plugin-sdk";
import matter from "gray-matter";

describe("renderAgentFileMarkdown 构建下发渲染（设计 §4）", () => {
  // 完整字段 → frontmatter + 正文 round-trip 等价
  test("完整字段渲染后可被 gray-matter 解析回等价结构", () => {
    const spec: AgentFileSpec = {
      name: "Code Reviewer",
      description: "审查代码质量",
      prompt: "你是资深代码审查专家。",
      skills: ["review", "lint"],
      model: "providerA/gpt-4o",
      mode: "subagent",
      temperature: 0.2,
      steps: 10,
    };
    const rendered = renderAgentFileMarkdown(spec);
    const parsed = matter(rendered);
    expect(parsed.data.name).toBe(spec.name);
    expect(parsed.data.description).toBe(spec.description);
    expect(parsed.data.skills).toEqual(spec.skills);
    expect(parsed.data.model).toBe(spec.model);
    expect(parsed.data.mode).toBe(spec.mode);
    expect(parsed.data.temperature).toBe(spec.temperature);
    expect(parsed.data.steps).toBe(spec.steps);
    expect(parsed.content.trim()).toBe(spec.prompt);
  });

  // 缺省字段不写入 frontmatter（与模板解析器 undefined 语义一致）
  test("可选字段缺省时不写入 frontmatter", () => {
    const rendered = renderAgentFileMarkdown({ name: "minimal", prompt: "  body  " });
    expect(rendered).not.toContain("model:");
    expect(rendered).not.toContain("skills:");
    // 正文 trim 规范化（round-trip 稳定）
    expect(rendered).toContain("\nbody\n");
  });

  // 特殊字符（引号/冒号/换行）经 JSON 转义后仍可被解析，防注入
  test("名称含特殊字符时渲染安全可解析", () => {
    const spec: AgentFileSpec = { name: 'a"b:c', prompt: "line1\nline2" };
    const parsed = matter(renderAgentFileMarkdown(spec));
    expect(parsed.data.name).toBe('a"b:c');
    expect(parsed.content.trim()).toBe("line1\nline2");
  });
});
