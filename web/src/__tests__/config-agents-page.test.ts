import { describe, expect, test } from "bun:test";
import {
  buildAgentPayload,
  buildKnowledgeFormState,
  filterKnowledgeBaseIds,
  getDefaultKnowledgeFormState,
  isValidAgentNameInput,
} from "../lib/agent-utils";

describe("isValidAgentNameInput", () => {
  test("valid name", () => {
    expect(isValidAgentNameInput("my-agent")).toBe(true);
  });

  test("uppercase allowed", () => {
    expect(isValidAgentNameInput("MY-AGENT")).toBe(true);
  });

  test("single char valid", () => {
    expect(isValidAgentNameInput("a")).toBe(true);
  });

  test("double hyphen rejected", () => {
    expect(isValidAgentNameInput("a--b")).toBe(false);
  });

  test("empty rejected", () => {
    expect(isValidAgentNameInput("")).toBe(false);
  });
});

describe("isValidAgentNameInput — Task 5 回归", () => {
  test("带连字符的合法名称", () => {
    expect(isValidAgentNameInput("my-custom-agent")).toBe(true);
  });

  test("纯数字名称", () => {
    expect(isValidAgentNameInput("123")).toBe(true);
  });

  test("64 字符名称仍合法", () => {
    expect(isValidAgentNameInput("a".repeat(64))).toBe(true);
  });

  test("65 字符名称不合法", () => {
    expect(isValidAgentNameInput("a".repeat(65))).toBe(false);
  });

  test("中文名称合法", () => {
    expect(isValidAgentNameInput("会议纪要助手")).toBe(true);
  });

  test("中英混合带连字符合法", () => {
    expect(isValidAgentNameInput("Agent-助手")).toBe(true);
  });

  test("日文名称合法", () => {
    expect(isValidAgentNameInput("エージェント")).toBe(true);
  });
});

describe("Agent knowledge form helpers", () => {
  test("读取 AgentDetail.knowledge 时正确回填 knowledgeBaseIds", () => {
    expect(
      buildKnowledgeFormState({
        knowledge: {
          knowledgeBaseIds: ["kb_a", "kb_b"],
          policy: { searchFirst: false, maxResults: 8 },
        },
      } as any),
    ).toEqual({
      knowledgeBaseIds: ["kb_a", "kb_b"],
      searchFirst: false,
      maxResults: "8",
    });
  });

  test("knowledge 默认值渲染 searchFirst/maxResults", () => {
    expect(getDefaultKnowledgeFormState()).toEqual({
      knowledgeBaseIds: [],
      searchFirst: true,
      maxResults: "5",
    });
  });

  test("保存时提交 payload 包含 knowledge.knowledgeBaseIds 与 policy.maxResults", () => {
    const payload = buildAgentPayload({
      modelId: "model-1",
      prompt: "",
      description: "agent desc",
      knowledge: {
        knowledgeBaseIds: ["kb_a", "kb_b"],
        searchFirst: true,
        maxResults: "7",
      },
    });

    expect(payload.modelId).toBe("model-1");
    expect(payload.description).toBe("agent desc");
    expect(payload.knowledge).toEqual({
      knowledgeBaseIds: ["kb_a", "kb_b"],
      policy: { searchFirst: true, maxResults: 7 },
    });
  });

  test("过滤掉已不存在的知识库 id", () => {
    expect(filterKnowledgeBaseIds(["kb_a", "kb_missing", "kb_b"], [{ id: "kb_a" }, { id: "kb_b" }] as any)).toEqual([
      "kb_a",
      "kb_b",
    ]);
  });
});
