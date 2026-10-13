// web/__tests__/agent-form-dialog-pure-logic.test.ts
// 从宿主 `apps/web/src/__tests__/` 迁入（CE 阶段 2 任务 1.6 T12）：本文件守护的纯逻辑实现全部归本包
// （`lib/agent-utils`、`lib/agent-resource-access`）或本包编辑器直接消费的兄弟包浏览器出口
// （model-management 的模型选项、mcp / skill 的授权与展示），留在宿主只能经包出口取用，等于让包内
// 实现被应用壳测试守护。
//
// 迁入时按 owner 拆开去重（§7.31 的裁定）：源文件 30 条用例里
//   - 18 条迁入本文件，各自带本包既有用例没有覆盖的断言；
//   - 5 条与本包既有用例等价而删除——`mapMcpOptions` / `mapModelOptions` 的选项映射已被
//     `agent-form-dialog-round54-pure` / `-bulk-pure-options` / `-options-boundaries` 覆盖，
//     Agent 名称的空格 / 连续连字符 / 长度上限已被 `agent-utils` 与 `config-agents-page` 覆盖；
//   - 7 条守护宿主自有的 `api/fs`（`buildUploadUrl`）、`lib/api-result`、`lib/form-utils`，owner 不在本包，
//     留在宿主：其中 6 条与 `fs-upload-url` / `form-utils` / `api-result-utils` 等价而删除，唯一未覆盖的
//     「空服务端消息兜底」并入 `apps/web/src/__tests__/api-result-utils.test.ts`。

import { describe, expect, test } from "bun:test";
import { buildModelOptions } from "@fenix/model-management/web";
import {
  canManageMcpSharing,
  filterWritableMcps,
  getMcpDisplayName,
  getMcpResourceBadgeKey,
  type McpResourceLike,
} from "@fenix/resource-mcp/web";
import {
  canWriteSkill,
  getSkillResourceBadgeKey,
  isExternalSkill,
  mapSkillOptions,
  normalizeSkillOptionsPayload,
} from "@fenix/resource-skill/web";
import type { McpServerInfo, ModelEntry, SkillInfo } from "@fenix/web-runtime/types/config";
import {
  canManageAgentSharing,
  getAgentAccessBadgeKey,
  getAgentConfigLookupKey,
  getAgentDisplayName,
  isAgentWritable,
} from "../lib/agent-resource-access";
import {
  buildAgentPayload,
  buildKnowledgeFormState,
  filterKnowledgeBaseIds,
  getDefaultKnowledgeFormState,
  isValidAgentNameInput,
} from "../lib/agent-utils";

/** 共享来源 Agent 的 `/web` 详情视图字段：归属其他组织且只有读动作。 */
function sharedAgentFields() {
  return {
    scope: { organizationId: "org-source", visibility: "public" as const },
    access: { actions: ["read" as const] },
    organizationName: "Source Team",
  };
}

/** 共享来源 MCP 的 `/web` 视图字段：归属其他组织且只有读动作。 */
function sharedMcpFields(overrides: Partial<McpServerInfo> = {}): Partial<McpServerInfo> {
  return {
    scope: { organizationId: "org-source", visibility: "public" },
    access: { actions: ["read"] },
    organizationName: "Source Team",
    ...overrides,
  };
}

/** 共享来源 Skill 的 `/web` 视图字段：归属其他组织且只有读动作。 */
function sharedSkillFields(overrides: Partial<SkillInfo> = {}): Partial<SkillInfo> {
  return {
    scope: { organizationId: "org-source", visibility: "public" },
    access: { actions: ["read"] },
    organizationName: "Source Team",
    ...overrides,
  };
}

const sharedModel: ModelEntry = {
  id: "model-uuid",
  modelId: "gpt-shared",
  displayName: "Shared Model",
  provider: "openai",
  providerId: "provider-openai",
  providerDisplayName: "OpenAI",
  contextLimit: null,
  outputLimit: null,
  scope: { organizationId: "org-source", visibility: "public" },
  access: { actions: ["read"] },
  organizationName: "Source Team",
};

describe("Agent 表单与资源访问纯逻辑", () => {
  // 模型配置选择器须优先使用共享 Provider 资源键，保证跨组织同名 provider 不冲突。
  test("构建模型配置查询值时优先共享 Provider 资源键", () => {
    expect(buildModelOptions([sharedModel])).toEqual([
      { value: "org-source/provider-openai/gpt-shared", label: "Source Team/OpenAI/Shared Model" },
    ]);
  });

  // 知识库编辑回填在后端无配置时应使用安全默认值，避免空表单产生无效策略。
  test("为缺失知识库配置生成默认表单状态", () => {
    expect(getDefaultKnowledgeFormState()).toEqual({ knowledgeBaseIds: [], searchFirst: true, maxResults: "5" });
    expect(buildKnowledgeFormState({ knowledge: null })).toEqual({
      knowledgeBaseIds: [],
      searchFirst: true,
      maxResults: "5",
    });
  });

  // 保存时空字符串不应透传为配置字段，知识库策略仍必须保留显式数值和引擎类型。
  test("构建 Agent 保存 payload 并归一化空字段", () => {
    expect(
      buildAgentPayload({
        modelId: "",
        prompt: "",
        description: "",
        engineType: "claude-code",
        knowledge: { knowledgeBaseIds: ["kb-1"], searchFirst: false, maxResults: "12" },
      }),
    ).toEqual({
      modelId: undefined,
      prompt: undefined,
      description: undefined,
      engineType: "claude-code",
      knowledge: { knowledgeBaseIds: ["kb-1"], policy: { searchFirst: false, maxResults: 12 } },
    });
  });

  // 已删除或无权访问的知识库 ID 必须在提交前剔除，防止向后端发送失效关联。
  test("过滤不在当前可见列表中的知识库", () => {
    expect(filterKnowledgeBaseIds(["kb-a", "kb-missing", "kb-a"], [{ id: "kb-a" }, { id: "kb-b" }])).toEqual([
      "kb-a",
      "kb-a",
    ]);
  });

  // Agent 名称校验允许多语言字母和单连字符，但拒绝分隔符边界错误。
  test("校验多语言 Agent 名称与连字符边界", () => {
    expect(isValidAgentNameInput("会议-Agent-2")).toBe(true);
    expect(isValidAgentNameInput("-agent")).toBe(false);
    expect(isValidAgentNameInput("agent-")).toBe(false);
  });

  // 外部 Agent 不可写或管理共享，但所有资源定位和展示必须使用来源组织上下文。
  test("按 Agent 资源权限解析标识、展示和操作能力", () => {
    const agent = { id: "local-id", name: "writer", ...sharedAgentFields() };
    expect(getAgentConfigLookupKey(agent)).toBe("org-source/local-id");
    expect(getAgentConfigLookupKey({ name: "writer" })).toBe("writer");
    expect(getAgentDisplayName(agent)).toBe("Source Team/writer");
    expect(isAgentWritable(agent)).toBe(false);
    expect(canManageAgentSharing(agent)).toBe(false);
    expect(getAgentAccessBadgeKey(agent, "org-current")).toBe("resource.external");
    expect(getAgentAccessBadgeKey(agent)).toBe("resource.public");
  });

  // MCP 权限列表只保留带 update 动作的资源，只读共享资源不得进入编辑与管理入口。
  test("过滤不可写 MCP 并映射来源与权限徽标", () => {
    const writable: McpResourceLike = { name: "owned", access: { actions: ["read", "update"] } };
    const readOnly = { name: "shared", ...sharedMcpFields() };
    expect(filterWritableMcps([writable, readOnly])).toEqual([writable]);
    expect(getMcpDisplayName(readOnly)).toBe("Source Team/shared");
    expect(getMcpResourceBadgeKey(readOnly, "org-current")).toBe("resource.external");
    expect(canManageMcpSharing(readOnly)).toBe(false);
  });

  // Skill 历史包装响应与数组响应均应映射为一致的共享资源展示结构，非法载荷安全降级。
  test("归一化 Skill 选项并处理非法载荷", () => {
    const skills = [{ id: "skill-id", name: "review", description: "Review code", ...sharedSkillFields() }];
    expect(mapSkillOptions(skills)).toEqual([
      {
        id: "skill-id",
        key: "org-source/skill-id",
        name: "review",
        label: "Source Team/review",
        description: "Review code",
        scope: { organizationId: "org-source", visibility: "public" },
        organizationName: "Source Team",
      },
    ]);
    expect(normalizeSkillOptionsPayload({ skills })).toEqual(mapSkillOptions(skills));
    expect(normalizeSkillOptionsPayload("invalid")).toEqual([]);
  });

  // Skill 授权判断基于 scope 与 access.actions：外部组织资源只读，缺失动作时保守降级。
  test("按授权视图判定 Skill 归属与写权限", () => {
    const shared = { id: "skill-id", name: "review", ...sharedSkillFields() };
    expect(isExternalSkill(shared, "org-current")).toBe(true);
    expect(isExternalSkill(shared)).toBe(false);
    expect(canWriteSkill(shared)).toBe(false);
    expect(getSkillResourceBadgeKey(shared, "org-current")).toBe("resource.external");
    expect(canWriteSkill({ name: "own", scope: { organizationId: "org-current", visibility: "private" } })).toBe(false);
    expect(canWriteSkill({ name: "own", access: { actions: ["read", "update"] } })).toBe(true);
  });

  // 每次打开创建表单均须生成独立的默认知识库状态，避免上一次编辑残留选择。
  test("知识库默认状态使用独立数组", () => {
    const first = getDefaultKnowledgeFormState();
    const second = getDefaultKnowledgeFormState();
    first.knowledgeBaseIds.push("kb-stale");
    expect(second).toEqual({ knowledgeBaseIds: [], searchFirst: true, maxResults: "5" });
  });

  // 编辑数据只提供知识库时，其余策略字段必须回填为创建表单默认值。
  test("知识库编辑状态补齐缺失策略", () => {
    expect(buildKnowledgeFormState({ knowledge: { knowledgeBaseIds: ["kb-1"] } })).toEqual({
      knowledgeBaseIds: ["kb-1"],
      searchFirst: true,
      maxResults: "5",
    });
  });

  // 编辑数据只提供搜索策略时，不得凭空创建知识库关联。
  test("知识库编辑状态保留空关联", () => {
    expect(
      buildKnowledgeFormState({ knowledge: { knowledgeBaseIds: [], policy: { searchFirst: false, maxResults: 3 } } }),
    ).toEqual({
      knowledgeBaseIds: [],
      searchFirst: false,
      maxResults: "3",
    });
  });

  // 数值零是显式策略值，回填时不能被默认最大结果数覆盖。
  test("知识库编辑状态保留零最大结果", () => {
    expect(buildKnowledgeFormState({ knowledge: { knowledgeBaseIds: [], policy: { maxResults: 0 } } })).toEqual({
      knowledgeBaseIds: [],
      searchFirst: true,
      maxResults: "0",
    });
  });

  // 无可见知识库时，提交前必须清空所有过期关联。
  test("空知识库选项过滤全部已选项", () => {
    expect(filterKnowledgeBaseIds(["kb-1", "kb-2"], [])).toEqual([]);
  });

  // 过滤逻辑必须保留当前可见选项的选择顺序，保证 payload 稳定。
  test("知识库过滤保留有效选择顺序", () => {
    expect(filterKnowledgeBaseIds(["kb-2", "missing", "kb-1"], [{ id: "kb-1" }, { id: "kb-2" }])).toEqual([
      "kb-2",
      "kb-1",
    ]);
  });

  // 名称输入允许单个 Unicode 字母，支持创建国际化 Agent 名称。
  test("Agent 名称允许单个 Unicode 字母", () => {
    expect(isValidAgentNameInput("智")).toBe(true);
  });

  // 创建 payload 必须保留非空字段和默认 engineType，供未选择运行引擎的表单提交。
  test("Agent payload 使用默认引擎并保留非空字段", () => {
    expect(
      buildAgentPayload({
        modelId: "model-1",
        prompt: "You are helpful",
        description: "Assistant",
        knowledge: { knowledgeBaseIds: [], searchFirst: true, maxResults: "5" },
      }),
    ).toEqual({
      modelId: "model-1",
      prompt: "You are helpful",
      description: "Assistant",
      engineType: "peri",
      knowledge: { knowledgeBaseIds: [], policy: { searchFirst: true, maxResults: 5 } },
    });
  });

  // 空最大结果输入按表单默认值序列化，防止向 API 传递 NaN。
  test("Agent payload 为空最大结果使用默认值", () => {
    expect(
      buildAgentPayload({
        modelId: "model-1",
        prompt: "prompt",
        description: "description",
        knowledge: { knowledgeBaseIds: ["kb-1"], searchFirst: false, maxResults: "" },
      }).knowledge.policy,
    ).toEqual({ searchFirst: false, maxResults: 5 });
  });
});
