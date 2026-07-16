import { afterEach, describe, expect, test } from "bun:test";

/** 模拟 CCB Hindsight 环境变量注入逻辑（提取为独立函数便于测试） */
function buildCcbHindsightEnv(
  processedExtra: Record<string, unknown> | null,
  hindsightUrl: string | undefined,
  bankId: string | null,
  apiToken: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (
    processedExtra &&
    Array.isArray(processedExtra.plugin) &&
    (processedExtra.plugin as Array<[string, unknown]>).some(([name]) => name === "@konghayao/opencode-hindsight")
  ) {
    if (hindsightUrl) {
      env.HINDSIGHT_API_URL = hindsightUrl;
      env.HINDSIGHT_LLM_PROVIDER = "claude-code";
      if (bankId) env.HINDSIGHT_BANK_ID = bankId;
      if (apiToken) env.HINDSIGHT_API_TOKEN = apiToken;
    }
  }
  return env;
}

describe("launch-spec-builder CCB Hindsight env", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  // 有 Hindsight 插件 + HINDSIGHT_MCP_URL → 注入 HINDSIGHT_* 环境变量
  test("extra.plugin 包含 hindsight 时注入所有 HINDSIGHT_* 环境变量", () => {
    const processedExtra = {
      plugin: [["@konghayao/opencode-hindsight", { autoRecall: true }]],
    };
    const env = buildCcbHindsightEnv(processedExtra, "http://hindsight:9999", "bank-123", "token-abc");
    expect(env.HINDSIGHT_API_URL).toBe("http://hindsight:9999");
    expect(env.HINDSIGHT_LLM_PROVIDER).toBe("claude-code");
    expect(env.HINDSIGHT_BANK_ID).toBe("bank-123");
    expect(env.HINDSIGHT_API_TOKEN).toBe("token-abc");
  });

  // 无 Hindsight 插件 → 不注入任何环境变量
  test("extra.plugin 不含 hindsight 时不注入环境变量", () => {
    const processedExtra = {
      plugin: [["some-other-plugin", {}]],
    };
    const env = buildCcbHindsightEnv(processedExtra, "http://hindsight:9999", "bank-123", "token-abc");
    expect(Object.keys(env)).toHaveLength(0);
  });

  // HINDSIGHT_MCP_URL 未配置 → 即使有插件也不注入
  test("HINDSIGHT_MCP_URL 未配置时不注入环境变量", () => {
    const processedExtra = {
      plugin: [["@konghayao/opencode-hindsight", {}]],
    };
    const env = buildCcbHindsightEnv(processedExtra, undefined, "bank-123", "token-abc");
    expect(Object.keys(env)).toHaveLength(0);
  });

  // processedExtra 为 null → 不注入
  test("processedExtra 为 null 时不注入环境变量", () => {
    const env = buildCcbHindsightEnv(null, "http://hindsight:9999", "bank-123", "token-abc");
    expect(Object.keys(env)).toHaveLength(0);
  });

  // 无 API_TOKEN 时仅注入三个变量
  test("无 HINDSIGHT_API_TOKEN 时仅注入 API_URL、LLM_PROVIDER、BANK_ID", () => {
    const processedExtra = {
      plugin: [["@konghayao/opencode-hindsight", {}]],
    };
    const env = buildCcbHindsightEnv(processedExtra, "http://hindsight:9999", "bank-123", undefined);
    expect(env.HINDSIGHT_API_URL).toBe("http://hindsight:9999");
    expect(env.HINDSIGHT_LLM_PROVIDER).toBe("claude-code");
    expect(env.HINDSIGHT_BANK_ID).toBe("bank-123");
    expect(env.HINDSIGHT_API_TOKEN).toBeUndefined();
  });

  // 空 plugin 数组 → 不注入
  test("extra.plugin 为空数组时不注入", () => {
    const processedExtra = { plugin: [] };
    const env = buildCcbHindsightEnv(processedExtra, "http://hindsight:9999", "bank-123", "token-abc");
    expect(Object.keys(env)).toHaveLength(0);
  });
});
