import { describe, expect, test } from "bun:test";
import { buildUploadUrl } from "../api/fs";
import {
  canManageAgentSharing,
  getAgentAccessBadgeKey,
  getAgentConfigLookupKey,
  getAgentDisplayName,
  getAgentOptionValue,
  isAgentWritable,
} from "../lib/agent-resource-access";
import {
  buildAgentPayload,
  buildKnowledgeFormState,
  filterKnowledgeBaseIds,
  getDefaultKnowledgeFormState,
  isValidAgentNameInput,
} from "../lib/agent-utils";
import { err, ok, unwrapApiResult } from "../lib/api-result";
import { intRangeSchema, nameSchema, optionalFloatSchema, validateWithSchema } from "../lib/form-utils";
import {
  canManageMcpSharing,
  filterWritableMcps,
  getMcpDisplayName,
  getMcpResourceBadgeKey,
} from "../lib/mcp-resource-access";
import { buildModelOptions } from "../lib/model-config-utils";
import { mapSkillOptions, normalizeSkillOptionsPayload } from "../lib/skill-resource-access";
import { mapMcpOptions, mapModelOptions } from "../pages/agent-panel/agent-editor/agent-editor-model";
import type { ModelEntry, ResourceAccess } from "../types/config";

const externalAccess: ResourceAccess = {
  ownership: "external",
  sourceOrganizationId: "org-source",
  sourceOrganizationName: "Source Team",
  resourceUid: "shared-uid",
  resourceKey: "org-source/shared-key",
  manageable: false,
  writable: false,
  publicReadable: true,
};

const sharedModel: ModelEntry = {
  id: "model-uuid",
  modelId: "gpt-shared",
  displayName: "Shared Model",
  provider: "openai",
  providerDisplayName: "OpenAI",
  contextLimit: null,
  outputLimit: null,
  providerResourceAccess: externalAccess,
  providerResourceKey: "org-source/provider-openai",
};

describe("Agent 表单与资源访问纯逻辑", () => {
  // Agent 表单必须排除显式禁用的 MCP，同时保留共享资源的稳定 key 和展示名称。
  test("转换 MCP 选项并过滤禁用资源", () => {
    expect(
      mapMcpOptions([
        { id: "enabled", name: "filesystem", resourceAccess: externalAccess },
        { id: "disabled", name: "legacy", enabled: false },
      ]),
    ).toEqual([
      {
        id: "enabled",
        key: "org-source/shared-key",
        name: "filesystem",
        label: "Source Team/filesystem",
        resourceAccess: externalAccess,
      },
    ]);
  });

  // Agent 表单模型 value 使用模型 UUID，避免与 provider/modelId 格式的配置值混淆。
  test("将共享模型转换为 Agent 表单选项", () => {
    expect(mapModelOptions([sharedModel])).toEqual([{ value: "model-uuid", label: "Source Team/OpenAI/Shared Model" }]);
  });

  // 模型配置选择器须优先使用共享 provider key，保证跨组织同名 provider 不冲突。
  test("构建模型配置查询值时优先共享 provider key", () => {
    expect(buildModelOptions([sharedModel])).toEqual([
      { value: "org-source/provider-openai/gpt-shared", label: "Source Team/OpenAI/Shared Model" },
    ]);
  });

  // 上传 URL 的路径参数需编码，根目录上传仍保留后端路由要求的尾部斜杠。
  test("规范化上传查询路径并编码环境标识", () => {
    expect(buildUploadUrl("env / 1")).toBe("/web/environments/env%20%2F%201/fs/");
    expect(buildUploadUrl("env-1", "/docs/guides")).toBe("/web/environments/env-1/fs/docs/guides");
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

  // Schema 必须将整数文本转换为数值，并对范围错误提供调用方可展示的消息。
  test("按 schema 转换整数并报告范围错误", () => {
    const schema = intRangeSchema({ label: "Results", min: 1, max: 10 });
    expect(schema.parse("08")).toBe(8);
    expect(validateWithSchema(schema, "11")).toEqual(["Results must be between 1 and 10"]);
  });

  // 名称和可选浮点 schema 分别守护 slug 规则与空白数值的缺省语义。
  test("校验名称 schema 和可选浮点 schema", () => {
    expect(nameSchema().safeParse("agent_name").success).toBe(false);
    expect(optionalFloatSchema({ min: 0, max: 1 }).parse("  ")).toBeUndefined();
  });

  // ApiResult 解包应保留成功数据，并将空服务端消息规范化为稳定的兜底错误。
  test("规范化 API 成功与失败结果", () => {
    expect(unwrapApiResult(ok({ id: "agent-1" }))).toEqual({ id: "agent-1" });
    expect(() => unwrapApiResult(err("UPSTREAM_ERROR", "", 502))).toThrow("Unknown API error");
  });

  // 外部 Agent 不可写或管理共享，但所有资源定位和展示必须使用来源组织上下文。
  test("按 Agent 资源权限解析标识、展示和操作能力", () => {
    const agent = { id: "local-id", name: "writer", resourceAccess: externalAccess };
    expect(getAgentOptionValue(agent)).toBe("org-source/shared-key");
    expect(getAgentConfigLookupKey(agent)).toBe("org-source/shared-key");
    expect(getAgentDisplayName(agent)).toBe("Source Team/writer");
    expect(isAgentWritable(agent)).toBe(false);
    expect(canManageAgentSharing(agent)).toBe(false);
    expect(getAgentAccessBadgeKey(agent)).toBe("resource.external");
  });

  // MCP 权限列表只保留可写资源，共享只允许明确 manageable 的资源进入管理入口。
  test("过滤不可写 MCP 并映射来源与权限徽标", () => {
    const writable = { name: "owned" };
    const readOnly = { name: "shared", resourceAccess: externalAccess };
    expect(filterWritableMcps([writable, readOnly])).toEqual([writable]);
    expect(getMcpDisplayName(readOnly)).toBe("Source Team/shared");
    expect(getMcpResourceBadgeKey(readOnly)).toBe("resource.external");
    expect(canManageMcpSharing(readOnly)).toBe(false);
  });

  // Skill 历史包装响应与数组响应均应映射为一致的共享资源展示结构，非法载荷安全降级。
  test("归一化 Skill 选项并处理非法载荷", () => {
    const skills = [{ id: "skill-id", name: "review", description: "Review code", resourceAccess: externalAccess }];
    expect(mapSkillOptions(skills)).toEqual([
      {
        id: "shared-uid",
        key: "org-source/shared-key",
        name: "review",
        label: "Source Team/review",
        description: "Review code",
        resourceAccess: externalAccess,
      },
    ]);
    expect(normalizeSkillOptionsPayload({ skills })).toEqual(mapSkillOptions(skills));
    expect(normalizeSkillOptionsPayload("invalid")).toEqual([]);
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

  // 名称输入允许空格，保持与后端允许的人类可读 Agent 名称契约一致。
  test("Agent 名称允许空格", () => {
    expect(isValidAgentNameInput("agent one")).toBe(true);
  });

  // 名称输入不得包含连续连字符，避免生成空路径段。
  test("Agent 名称拒绝连续连字符", () => {
    expect(isValidAgentNameInput("agent--one")).toBe(false);
  });

  // 名称输入不得超过后端支持的 64 个字符。
  test("Agent 名称拒绝超过长度上限", () => {
    expect(isValidAgentNameInput("a".repeat(65))).toBe(false);
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
      engineType: "opencode",
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

  // Schema 应将非数值结果数转换为可展示的字段错误。
  test("最大结果校验拒绝非整数", () => {
    expect(validateWithSchema(intRangeSchema({ label: "Results", min: 1, max: 10 }), "none")).toEqual([
      "Results must be an integer",
    ]);
  });

  // Schema 应拒绝小于下界的结果数，避免无效检索策略进入 payload。
  test("最大结果校验拒绝低于下界", () => {
    expect(validateWithSchema(intRangeSchema({ label: "Results", min: 1, max: 10 }), "0")).toEqual([
      "Results must be between 1 and 10",
    ]);
  });

  // API 错误应保留服务端错误信息，供表单错误状态直接展示。
  test("API 错误解包保留服务端消息", () => {
    expect(() => unwrapApiResult(err("VALIDATION_ERROR", "Name already exists", 409))).toThrow("Name already exists");
  });
});
