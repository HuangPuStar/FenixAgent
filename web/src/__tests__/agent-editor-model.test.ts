import { describe, expect, test } from "bun:test";
import {
  agentDetailToEditorValues,
  agentEditorSchema,
  buildAgentEditorPayload,
  createAgentEditorDefaults,
  filterValidKnowledgeIds,
  mergeSelectedOptions,
} from "../pages/agent-panel/agent-editor/agent-editor-model";
import type { AgentDetail } from "../types/config";

const detail: AgentDetail = {
  id: "agent-1",
  name: "writer",
  builtIn: false,
  model: null,
  modelId: "model-1",
  prompt: "old prompt",
  description: "old description",
  extra: { feature: true },
  knowledge: null,
  skillIds: ["skill-hidden"],
  mcpIds: [],
  siteAppIds: ["site-hidden"],
  agentNode: {},
  enableMemory: true,
  resourceAccess: {
    ownership: "internal",
    sourceOrganizationId: "org-1",
    resourceUid: "agent-1",
    resourceKey: "org-1/writer",
    writable: true,
    manageable: true,
    publicReadable: false,
  },
};

describe("Agent 编辑器表单模型", () => {
  // 编辑详情必须完整转换为独立草稿，避免上一位 Agent 的字段残留。
  test("从详情构建完整编辑草稿", () => {
    expect(agentDetailToEditorValues(detail)).toEqual({
      name: "writer",
      modelId: "model-1",
      prompt: "old prompt",
      description: "old description",
      skillIds: ["skill-hidden"],
      mcpIds: [],
      siteAppIds: ["site-hidden"],
      knowledgeBaseIds: [],
      defaultNamespaces: "",
      searchFirst: true,
      maxResults: "5",
      agentNode: { kind: "default" },
      enableMemory: true,
      publicReadable: false,
      extra: '{\n  "feature": true\n}',
    });
  });

  // knowledge.policy.defaultNamespaces 必须从详情回填并按行提交，保存不能静默丢失。
  test("完整往返默认命名空间", () => {
    const values = agentDetailToEditorValues({
      ...detail,
      knowledge: {
        knowledgeBaseIds: ["kb-1"],
        policy: { searchFirst: false, maxResults: 8, defaultNamespaces: ["docs", "team/private"] },
      },
    });
    expect(values.defaultNamespaces).toBe("docs\nteam/private");
    expect(buildAgentEditorPayload(values, "edit")).toMatchObject({
      knowledge: { policy: { defaultNamespaces: ["docs", "team/private"] } },
    });
  });

  // 编辑态清空模型、Prompt、描述和 extra 必须显式发送 null，真正清除服务端旧值。
  test("更新 payload 保留显式清空语义", () => {
    const values = { ...createAgentEditorDefaults("writer"), prompt: "", description: "", modelId: "", extra: "" };
    expect(buildAgentEditorPayload(values, "edit")).toMatchObject({
      modelId: null,
      prompt: null,
      description: null,
      extra: null,
    });
  });

  // 创建态空可选字段应被省略，保持当前创建 API 契约。
  test("创建 payload 省略空可选字段", () => {
    const payload = buildAgentEditorPayload(createAgentEditorDefaults("writer"), "create");
    expect("modelId" in payload).toBe(false);
    expect("prompt" in payload).toBe(false);
    expect("description" in payload).toBe(false);
    expect("extra" in payload).toBe(false);
  });

  // maxResults 必须是 1–20 的十进制整数，不能接受小数或科学计数法。
  test("拒绝非整数知识库检索条数", () => {
    const base = createAgentEditorDefaults();
    expect(agentEditorSchema.safeParse({ ...base, maxResults: "1.5" }).success).toBe(false);
    expect(agentEditorSchema.safeParse({ ...base, maxResults: "1e2" }).success).toBe(false);
    expect(agentEditorSchema.safeParse({ ...base, maxResults: "20" }).success).toBe(true);
  });

  // extra 只接受 JSON object，数组和标量不得越过前端校验后再由后端拒绝。
  test("扩展配置仅接受 JSON object", () => {
    const base = createAgentEditorDefaults();
    expect(agentEditorSchema.safeParse({ ...base, extra: "[]" }).success).toBe(false);
    expect(agentEditorSchema.safeParse({ ...base, extra: '"text"' }).success).toBe(false);
    expect(agentEditorSchema.safeParse({ ...base, extra: '{"ok":true}' }).success).toBe(true);
  });

  // 已绑定但不可见的共享资源必须补入选项并标记不可用，不能静默解绑。
  test("合并已选不可见资源", () => {
    expect(
      mergeSelectedOptions([{ id: "visible", label: "Visible" }], [{ id: "hidden", label: "Source/Hidden" }]),
    ).toEqual([
      { id: "visible", label: "Visible" },
      { id: "hidden", label: "Source/Hidden", unavailable: true },
    ]);
  });

  // 保存只信任最新可访问列表；relatedResources 中历史可见的绑定不应被当作仍有效。
  test("仅保留最新可访问的知识库 ID", () => {
    expect(filterValidKnowledgeIds(["kb-current", "kb-history"], [{ id: "kb-current" }])).toEqual(["kb-current"]);
  });
});
