import { describe, expect, test } from "bun:test";
import {
  buildAgentPayload,
  buildKnowledgeFormState,
  buildSubagentFormData,
  DEFAULT_AGENT_MODE,
  filterKnowledgeBaseIds,
  getDefaultKnowledgeFormState,
  getFullAgentColumnKeys,
  isValidAgentNameInput,
  isValidStepsInput,
} from "../lib/agent-utils";

describe("DEFAULT_AGENT_MODE", () => {
  test("新建 Agent 默认模式为 primary", () => {
    expect(DEFAULT_AGENT_MODE).toBe("primary");
  });
});

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

describe("isValidStepsInput", () => {
  test("valid steps", () => {
    expect(isValidStepsInput("50")).toBe(true);
  });

  test("zero rejected", () => {
    expect(isValidStepsInput("0")).toBe(false);
  });

  test("over 200 rejected", () => {
    expect(isValidStepsInput("201")).toBe(false);
  });

  test("non-number rejected", () => {
    expect(isValidStepsInput("abc")).toBe(false);
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

describe("isValidStepsInput — Task 5 回归", () => {
  test("边界值 1", () => {
    expect(isValidStepsInput("1")).toBe(true);
  });

  test("边界值 200", () => {
    expect(isValidStepsInput("200")).toBe(true);
  });

  test("负数", () => {
    expect(isValidStepsInput("-1")).toBe(false);
  });

  test("小数被 parseInt 截断为整数", () => {
    // parseInt("1.5") = 1, 所以 isValidStepsInput("1.5") = true
    expect(isValidStepsInput("1.5")).toBe(true);
  });
});

describe("getFullAgentColumnKeys", () => {
  test("返回正确的 5 个列 key", () => {
    const keys = getFullAgentColumnKeys();
    expect(keys).toEqual(["name", "builtIn", "model", "mode", "default"]);
  });

  test("不包含 description", () => {
    const keys = getFullAgentColumnKeys();
    expect(keys).not.toContain("description");
  });
});

describe("buildSubagentFormData", () => {
  test("基本构建", () => {
    const data = buildSubagentFormData({
      name: "my-sub",
      modelId: "model-1",
      description: "test desc",
      prompt: "do something",
      steps: "50",
      disable: false,
    });
    expect(data).toEqual({
      mode: "subagent",
      modelId: "model-1",
      steps: 50,
      prompt: "do something",
      description: "test desc",
      disable: false,
    });
  });

  test("空字符串转 undefined", () => {
    const data = buildSubagentFormData({
      name: "my-sub",
      modelId: "",
      description: "",
      prompt: "",
      steps: "30",
      disable: false,
    });
    expect(data.modelId).toBeUndefined();
    expect(data.prompt).toBeUndefined();
    expect(data.description).toBeUndefined();
  });

  test("steps 解析为数字", () => {
    const data = buildSubagentFormData({
      name: "my-sub",
      modelId: "gpt-4",
      description: "",
      prompt: "",
      steps: "100",
      disable: false,
    });
    expect(data.steps).toBe(100);
  });

  test("disable 透传", () => {
    const data = buildSubagentFormData({
      name: "my-sub",
      modelId: "gpt-4",
      description: "",
      prompt: "",
      steps: "50",
      disable: true,
    });
    expect(data.disable).toBe(true);
  });

  test("不含高级字段", () => {
    const data = buildSubagentFormData({
      name: "my-sub",
      modelId: "gpt-4",
      description: "",
      prompt: "",
      steps: "50",
      disable: false,
    });
    expect(data).not.toHaveProperty("variant");
    expect(data).not.toHaveProperty("temperature");
    expect(data).not.toHaveProperty("top_p");
    expect(data).not.toHaveProperty("color");
    expect(data).not.toHaveProperty("hidden");
    expect(data).not.toHaveProperty("permission");
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
      mode: "primary",
      steps: "50",
      prompt: "",
      description: "",
      variant: "",
      temperature: "",
      topP: "",
      color: "",
      hidden: false,
      disable: false,
      permission: null,
      knowledge: {
        knowledgeBaseIds: ["kb_a", "kb_b"],
        searchFirst: true,
        maxResults: "7",
      },
    });

    expect(payload.modelId).toBe("model-1");
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
