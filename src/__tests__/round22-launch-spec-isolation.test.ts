import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import { agentConfigMcp, agentConfigSkill, mcpServer, model, provider } from "../db/schema";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { composeAgentSystemPrompt } from "../services/agent-system-prompt";
import {
  configError,
  configNotFound,
  configSuccess,
  configValidationError,
  isValidResourceName,
  resolveApiKey,
  safeJsonParse,
  safeJsonStringify,
  toKeyHint,
} from "../services/config-utils";
import { buildBasicLaunchSpec, buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const now = new Date("2026-08-19T00:00:00.000Z");
const originalConfig = { ...config };

function rows<T>(value: T[]) {
  return Object.assign(Promise.resolve(value), { limit: async () => value });
}

function agentConfig() {
  return {
    id: "agc_isolated",
    userId: "user_isolated",
    organizationId: "org_isolated",
    name: "隔离助手",
    prompt: "仅处理授权请求",
    modelId: "model_isolated",
    model: null,
    steps: 10,
    mode: "primary",
    permission: null,
    variant: null,
    temperature: null,
    topP: null,
    disable: false,
    hidden: false,
    color: null,
    description: null,
    knowledge: null,
    machineId: null,
    createdAt: now,
    updatedAt: now,
    resourceAccess: {
      ownership: "internal" as const,
      sourceOrganizationId: "org_isolated",
      resourceUid: "agc_isolated",
      resourceKey: "org_isolated/agc_isolated",
      manageable: true,
      writable: true,
      publicReadable: false,
    },
  };
}

function installDb(raw: unknown, enabled = true) {
  const providerRow = {
    id: "provider_isolated",
    userId: "user_isolated",
    organizationId: "org_isolated",
    name: "provider-isolated",
    displayName: "Provider",
    protocol: "openai",
    baseUrl: "https://provider.invalid",
    apiKey: "{env:ROUND22_PROVIDER_KEY}",
    extraOptions: {},
    createdAt: now,
    updatedAt: now,
  };
  const modelRow = {
    id: "model_isolated",
    organizationId: "org_isolated",
    providerId: "provider_isolated",
    modelId: "model-isolated",
    displayName: "Model",
    modalities: ["text"],
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: now,
    updatedAt: now,
  };
  const mcpRow = {
    id: "mcp_isolated",
    organizationId: "org_isolated",
    name: "隔离 MCP",
    enabled,
    type: "custom",
    config: raw,
  };
  stubDb({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === model) return rows([modelRow]);
          if (table === provider) return rows([providerRow]);
          if (table === agentConfigSkill) return rows([]);
          if (table === agentConfigMcp) return rows([{ mcpServerId: "mcp_isolated" }]);
          if (table === mcpServer) return rows([mcpRow]);
          return rows([]);
        },
      }),
    }),
  });
}

async function build(raw: unknown, enabled = true) {
  installDb(raw, enabled);
  return buildLaunchSpec({
    organizationId: "org_isolated",
    userId: "user_isolated",
    environmentId: "env_isolated",
    agentConfig: agentConfig(),
    environmentSecret: "not-asserted",
  });
}

describe("round22 隔离启动规格与输入边界", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig(originalConfig as never);
    setListAgentKnowledgeBindingsById(async () => []);
    delete process.env.ROUND22_PROVIDER_KEY;
  });
  afterEach(() => delete process.env.ROUND22_PROVIDER_KEY);

  // 名称边界拒绝可能造成资源混淆或路径歧义的字符。
  test.each([
    ["中文", "名", true],
    ["数字", "7", true],
    ["空格", "安全 Agent", true],
    ["连字符", "安全-Agent", true],
    ["空", "", false],
    ["前空格", " 安全", false],
    ["尾空格", "安全 ", false],
    ["双连字符", "安全--Agent", false],
    ["下划线", "安全_Agent", false],
    ["斜杠", "安全/Agent", false],
    ["换行", "安全\nAgent", false],
    ["emoji", "安全😀", false],
    ["64字符", "a".repeat(64), true],
    ["65字符", "a".repeat(65), false],
  ])("资源名称%s", (_label, value, expected) => expect(isValidResourceName(value)).toBe(expected));

  // 密钥解析只识别完整 env 引用，避免错误输入被提升为凭据。
  test.each([
    ["空值", undefined, undefined, null],
    ["null", null, undefined, null],
    ["明文", "local-key", undefined, "local-key"],
    ["已配置 env", "{env:ROUND22_KEY}", "resolved", "resolved"],
    ["缺失 env", "{env:ROUND22_MISSING}", undefined, null],
    ["非完整引用", "x{env:ROUND22_KEY}", "resolved", "x{env:ROUND22_KEY}"],
    ["空名称", "{env:}", "resolved", "{env:}"],
  ])("密钥解析%s", (_label, raw, value, expected) => {
    if (value) process.env.ROUND22_KEY = value;
    expect(resolveApiKey(raw)).toBe(expected);
    delete process.env.ROUND22_KEY;
  });

  // 响应包装器保持控制台协议的错误码和零值数据。
  test.each([
    ["成功零值", () => configSuccess(0), { success: true, data: 0 }],
    ["成功空串", () => configSuccess(""), { success: true, data: "" }],
    ["错误省略数据", () => configError("DENY", "拒绝"), { success: false, error: { code: "DENY", message: "拒绝" } }],
    [
      "错误保留 null",
      () => configError("DENY", "拒绝", null),
      { success: false, error: { code: "DENY", message: "拒绝" }, data: null },
    ],
    ["未找到", () => configNotFound("资源"), { success: false, error: { code: "NOT_FOUND", message: "资源" } }],
    [
      "校验错误",
      () => configValidationError("格式错误"),
      { success: false, error: { code: "VALIDATION_ERROR", message: "格式错误" } },
    ],
  ])("配置响应%s", (_label, create, expected) => expect(create()).toEqual(expected));

  // JSON 边界不能抛出，损坏输入必须被收敛为空值。
  test.each([
    ["序列化 null", () => safeJsonStringify(null), undefined],
    ["序列化对象", () => safeJsonStringify({ tenant: "org" }), '{"tenant":"org"}'],
    ["空串", () => safeJsonParse(""), null],
    ["损坏 JSON", () => safeJsonParse("{bad"), null],
    ["对象", () => safeJsonParse<{ tenant: string }>('{"tenant":"org"}'), { tenant: "org" }],
  ])("JSON 输入%s", (_label, execute, expected) => expect(execute()).toEqual(expected));

  // 系统提示词必须替换占位符，并在缺少插槽时安全追加用户要求。
  test.each([
    ["完整模板", "名称={{agentName}} 内容={{userPrompt}}", "隔离助手", " 审计 ", "名称=隔离助手 内容=审计"],
    ["追加用户提示", "名称={{agentName}}", "隔离助手", "审计", "名称=隔离助手\n\n## User Prompt\n审计"],
    ["空用户提示", "名称={{agentName}}", "隔离助手", "  ", "名称=隔离助手"],
    ["无用户提示", "固定规则", "隔离助手", undefined, "固定规则"],
    ["重复名称", "{{agentName}}/{{agentName}}", "隔离助手", undefined, "隔离助手/隔离助手"],
    ["裁剪完整模板", "  {{userPrompt}}  ", "隔离助手", " 内容 ", "内容"],
  ])("系统提示词%s", (_label, template, name, prompt, expected) =>
    expect(composeAgentSystemPrompt(template, name, prompt)).toBe(expected));

  // 合法 MCP 配置经真实 builder 转换，且不会跨组织读取模型。
  test.each([
    ["local", { type: "local", command: ["node", "server.js", 9], environment: { SAFE: "1" }, timeout: 500 }, "stdio"],
    [
      "remote",
      { type: "remote", url: "https://mcp.invalid/tools", headers: { Authorization: "Bearer scoped" } },
      "streamable-http",
    ],
    ["streamable", { type: "streamable-http", url: "https://mcp.invalid/http", timeout: 1000 }, "streamable-http"],
    ["stdio", { type: "stdio", command: "bun", args: ["run", 1, "serve"] }, "stdio"],
  ])("MCP 配置%s", async (_label, raw, type) => {
    process.env.ROUND22_PROVIDER_KEY = "provider-key";
    const spec = await build(raw);
    expect(spec.mcpServers[0]?.type).toBe(type);
    expect(spec.model.apiKey).toBe("provider-key");
    expect(spec.organizationId).toBe("org_isolated");
  });

  // 并发构建共享只读配置时，每个结果都必须保持本组织标识且互不丢失 MCP。
  test("并发构建保持启动规格隔离", async () => {
    process.env.ROUND22_PROVIDER_KEY = "provider-key";
    installDb({ type: "stdio", command: "bun", args: ["run", "safe"] });
    const specs = await Promise.all(
      Array.from({ length: 4 }, () =>
        buildLaunchSpec({
          organizationId: "org_isolated",
          userId: "user_isolated",
          environmentId: "env_isolated",
          agentConfig: agentConfig(),
          environmentSecret: "not-asserted",
        }),
      ),
    );
    expect(specs).toHaveLength(4);
    expect(specs.every((spec) => spec.organizationId === "org_isolated")).toBe(true);
    expect(specs.every((spec) => spec.mcpServers[0]?.type === "stdio")).toBe(true);
  });

  // 非法或禁用 MCP 必须在启动前失败，不能静默丢失工具能力。
  test.each([
    ["空 local", { type: "local", command: [] }],
    ["空 remote", { type: "remote", url: "  " }],
    ["空 stdio", { type: "stdio", command: "" }],
    ["未知类型", { type: "socket", address: "localhost" }],
    ["损坏 JSON", "{broken"],
  ])("拒绝 MCP 配置%s", async (_label, raw) =>
    await expect(build(raw)).rejects.toMatchObject({ code: "INVALID_CONFIG", statusCode: 400 }));

  // 禁用 MCP 即使配置合法也不可注入运行时。
  test("拒绝禁用 MCP", async () =>
    await expect(build({ type: "stdio", command: "bun" }, false)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      statusCode: 400,
    }));

  // 最小启动路径不继承绑定资源，并保留调用方的显式环境变量。
  test.each([
    ["省略环境 ID", undefined],
    ["保留环境 ID", "env_minimal"],
  ])("最小启动规格%s", async (_label, environmentId) => {
    const providerRow = {
      id: "provider_minimal",
      organizationId: "org_isolated",
      name: "provider-minimal",
      protocol: "anthropic",
      baseUrl: "",
      apiKey: null,
      createdAt: now,
    };
    const modelRow = {
      id: "model_minimal",
      organizationId: "org_isolated",
      providerId: "provider_minimal",
      modelId: "claude-isolated",
      modalities: null,
      createdAt: now,
    };
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () =>
              table === provider
                ? Promise.resolve([providerRow])
                : { limit: async () => (table === model ? [modelRow] : []) },
          }),
        }),
      }),
    });
    const spec = await buildBasicLaunchSpec({
      organizationId: "org_isolated",
      userId: "user_isolated",
      environmentId,
      extraEnv: { EXPLICIT: "wins" },
    });
    expect(spec.environmentId).toBe(environmentId);
    expect(spec.env.EXPLICIT).toBe("wins");
    expect(spec.skills).toEqual([]);
    expect(spec.mcpServers).toEqual([]);
  });

  // 密钥提示只能暴露末四位，避免配置页泄露完整凭据。
  test.each([
    ["缺失", undefined, "*******"],
    ["短密钥", "abc", "*******"],
    ["长密钥", "secret-7890", "***7890"],
  ])("密钥提示%s", (_label, key, expected) => expect(toKeyHint(key)).toBe(expected));
});
