import { describe, expect, it } from "bun:test";

// ── instance.ts 的 toSpawnedInstance 类型安全 ──
// toSpawnedInstance 从 pluginMetadata ��取 port/pid/token，
// 使用 typeof 守卫而非 as 断言。验证各种边界输入。

// 复现 toSpawnedInstance 内部 meta 读取逻辑的纯函数测试
function extractMeta(meta: Record<string, unknown> | null | undefined) {
  const m = meta ?? {};
  return {
    port: typeof m.port === "number" ? m.port : 0,
    pid: typeof m.pid === "number" ? m.pid : null,
    apiKey: typeof m.token === "string" ? m.token : "",
  };
}

describe("toSpawnedInstance meta 提取", () => {
  // 正常数值
  it("正常 pluginMetadata 返回正确值", () => {
    const result = extractMeta({ port: 8888, pid: 12345, token: "abc123" });
    expect(result).toEqual({ port: 8888, pid: 12345, apiKey: "abc123" });
  });

  // null metadata
  it("null metadata 返回默认值", () => {
    const result = extractMeta(null);
    expect(result).toEqual({ port: 0, pid: null, apiKey: "" });
  });

  // undefined metadata
  it("undefined metadata 返回默认值", () => {
    const result = extractMeta(undefined);
    expect(result).toEqual({ port: 0, pid: null, apiKey: "" });
  });

  // port 为字符串时应返回 0
  it("port 为字符串时返回默认值 0", () => {
    const result = extractMeta({ port: "8888" });
    expect(result.port).toBe(0);
  });

  // pid 为字符串时应返回 null
  it("pid 为字符串时返回 null", () => {
    const result = extractMeta({ pid: "12345" });
    expect(result.pid).toBeNull();
  });

  // token 为数字时应返回空字符串
  it("token 为数字时返回空字符串", () => {
    const result = extractMeta({ token: 12345 });
    expect(result.apiKey).toBe("");
  });

  // port 为 NaN 时
  it("port 为 NaN 时仍返回 NaN（typeof NaN === number）", () => {
    const result = extractMeta({ port: NaN });
    expect(result.port).toBeNaN();
  });

  // port 为 0 时应返回 0（不是默认值）
  it("port 为 0 时返回 0", () => {
    const result = extractMeta({ port: 0 });
    expect(result.port).toBe(0);
  });

  // 空对象
  it("空对象返回所有默认值", () => {
    const result = extractMeta({});
    expect(result).toEqual({ port: 0, pid: null, apiKey: "" });
  });
});

// ── spawnInstanceFromEnvironment 的 agentConfig 字段类型安全 ──

function extractAgentFields(ac: Record<string, unknown> | null) {
  return {
    prompt: typeof ac?.prompt === "string" ? ac.prompt : null,
    model: typeof ac?.model === "string" ? ac.model : null,
  };
}

describe("agentConfig 字段提取", () => {
  it("正常字符串字段", () => {
    const result = extractAgentFields({ prompt: "hello", model: "gpt-4" });
    expect(result).toEqual({ prompt: "hello", model: "gpt-4" });
  });

  it("null ac 返回 null", () => {
    const result = extractAgentFields(null);
    expect(result).toEqual({ prompt: null, model: null });
  });

  it("非字符串 prompt 返回 null", () => {
    const result = extractAgentFields({ prompt: 123, model: true });
    expect(result).toEqual({ prompt: null, model: null });
  });

  it("缺失字段返回 null", () => {
    const result = extractAgentFields({});
    expect(result).toEqual({ prompt: null, model: null });
  });
});
