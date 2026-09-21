import { describe, expect, test } from "bun:test";
import { createLogger, scrubSensitive } from "../index";

/** 命中即整体替换的键名，覆盖 SENSITIVE_KEYS 全部条目。 */
const SENSITIVE_KEY_CASES = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "clientSecret",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "apiKeys",
  "accessKey",
  "secretKey",
  "privateKey",
  "authorization",
  "cookie",
  "setCookie",
  "credentials",
  "connectionString",
  "databaseUrl",
  "dsn",
];

/** 由键名列表构造待脱敏对象，值统一用可识别的明文口令形态。 */
function objectWithKeys(keys: string[], value: string): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value]));
}

describe("logger 日志脱敏 scrubSensitive", () => {
  // 21 个敏感键名必须逐一命中并整体替换为 [Redacted]，保证日志不落密码、token、Cookie 与连接串密钥。
  test("全部敏感键名各自整体替换", () => {
    const input = objectWithKeys(SENSITIVE_KEY_CASES, "super-secret-value");
    const expected = objectWithKeys(SENSITIVE_KEY_CASES, "[Redacted]");

    expect(scrubSensitive(input)).toEqual(expected);
  });

  // 键名归一化（小写并去掉 _ / -）后精确比对，使 api_key、API-KEY、AccessToken 等常见写法命中同一条目。
  test("键名归一化变体命中", () => {
    expect(scrubSensitive({ api_key: "sk-1" })).toEqual({ api_key: "[Redacted]" });
    expect(scrubSensitive({ "API-KEY": "sk-2" })).toEqual({ "API-KEY": "[Redacted]" });
    expect(scrubSensitive({ AccessToken: "at-1" })).toEqual({ AccessToken: "[Redacted]" });
  });

  // 负例：本实现刻意不用子串匹配，否则会抹掉这些合法诊断字段（Token 计数、分词器、吞吐指标都是排障必需信息）。
  test("合法的 token 统计字段不被误伤", () => {
    const diagnostics = {
      maxTokens: 8192,
      tokenCount: 1234,
      promptTokens: 800,
      maxOutputTokens: 4096,
      tokenizer: "cl100k_base",
      tokensPerSecond: 42.5,
    };

    expect(scrubSensitive(diagnostics)).toEqual(diagnostics);
  });

  // 深层嵌套对象内的敏感键同样被替换，避免 provider 配置里的 apiKey 借嵌套绕过脱敏。
  test("嵌套对象内的敏感键被替换", () => {
    const input = { config: { provider: { apiKey: "sk-x", baseUrl: "https://api.example.com" } } };

    expect(scrubSensitive(input)).toEqual({
      config: { provider: { apiKey: "[Redacted]", baseUrl: "https://api.example.com" } },
    });
  });

  // 数组元素按元素递归脱敏，避免批量凭证列表整体漏出。
  test("数组元素内的敏感键被替换", () => {
    expect(scrubSensitive([{ token: "t" }, { name: "ok" }])).toEqual([{ token: "[Redacted]" }, { name: "ok" }]);
  });

  // 连接串口令按值掩码（保留 user 便于定位账号）；键名必须用非敏感名，因为 databaseUrl 这个键名本身就会命中被整体替换。
  test("连接串口令被掩码且保留账号与主机", () => {
    expect(scrubSensitive({ endpoint: "postgres://user:pw@host:5432/db" })).toEqual({
      endpoint: "postgres://user:***@host:5432/db",
    });
  });

  // 无账号形式的连接串只掩口令，保留 scheme 与主机。
  test("无账号连接串只掩口令", () => {
    expect(scrubSensitive({ endpoint: "rediss://:secret@host" })).toEqual({ endpoint: "rediss://:***@host" });
  });

  // 普通 URL 不含 user:pass@ 形态，必须原样保留，否则会破坏日志中的接口地址可读性。
  test("普通 URL 不受掩码影响", () => {
    expect(scrubSensitive({ endpoint: "https://host/path" })).toEqual({ endpoint: "https://host/path" });
  });

  // 敏感键名承载的连接串被整体替换，这正是连接串用例必须改用 endpoint 这类非敏感键名的原因。
  test("敏感键名下的连接串整体替换", () => {
    expect(scrubSensitive({ databaseUrl: "postgres://user:pw@host:5432/db" })).toEqual({
      databaseUrl: "[Redacted]",
    });
  });

  // 环引用替换为 [Circular]，保证 JSON.stringify 不抛错导致整条日志丢失。
  test("环引用替换为 Circular 标记", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(scrubSensitive(cyclic)).toEqual({ self: "[Circular]" });
  });

  // 超过深度上限的子树整体折叠为 [MaxDepth]：脱敏是安全控制必须 fail-closed，
  // 若原样返回，深层敏感值会绕过替换明文落盘；折叠同时保证不爆栈、不抛错。
  test("超深嵌套折叠为标记且不抛错", () => {
    const input = {
      password: "p",
      l1: { l2: { l3: { l4: { l5: { l6: { password: "deep" } } } } } },
    };

    let result: unknown;
    expect(() => {
      result = scrubSensitive(input);
    }).not.toThrow();
    // 浅层敏感键被替换；到达深度上限的子树被整体折叠，深层原文不参与输出。
    expect(result).toEqual({
      password: "[Redacted]",
      l1: { l2: { l3: { l4: { l5: { l6: "[MaxDepth]" } } } } },
    });
    expect(JSON.stringify(result)).not.toContain("deep");
  });

  // 纯函数语义：调用后原对象字段值仍为原文，脱敏只作用于返回的副本，调用方状态不被就地改写。
  test("不就地改写原对象", () => {
    const input = {
      password: "p",
      endpoint: "postgres://user:pw@host",
      nested: { config: { apiKey: "sk-x" } },
      list: [{ token: "t" }],
    };

    scrubSensitive(input);

    expect(input).toEqual({
      password: "p",
      endpoint: "postgres://user:pw@host",
      nested: { config: { apiKey: "sk-x" } },
      list: [{ token: "t" }],
    });
  });

  // 非对象标量原样返回，避免把 null / undefined 变成 "[Redacted]" 之类的伪值污染日志。
  test("标量原样返回", () => {
    expect(scrubSensitive(null)).toBeNull();
    expect(scrubSensitive(undefined)).toBeUndefined();
    expect(scrubSensitive(42)).toBe(42);
    expect(scrubSensitive(false)).toBe(false);
    expect(scrubSensitive("plain")).toBe("plain");
  });

  // 空容器按结构等价返回，不引入多余字段。
  test("空对象与空数组原样返回", () => {
    expect(scrubSensitive({})).toEqual({});
    expect(scrubSensitive([])).toEqual([]);
  });

  // 接线冒烟：测试环境 pino 级别为 silent，无法断言落盘输出，真正的断言在 scrubSensitive 上；
  // 本用例只保证字符串 + 含敏感键对象 + Error 实例混合参数经过 argsToMsg 时不抛错。
  test("createLogger 混合参数调用不抛错", () => {
    const logger = createLogger("scrub-smoke");
    const sensitivePayload = { apiKey: "sk-x", endpoint: "postgres://user:pw@host:5432/db" };

    expect(() => logger.info("provider configured", sensitivePayload, new Error("boom"))).not.toThrow();
    expect(() => logger.warn(sensitivePayload, "retrying")).not.toThrow();
    expect(() => logger.error(new Error("failed"), sensitivePayload)).not.toThrow();
    expect(() => logger.debug("payload", sensitivePayload)).not.toThrow();
    expect(() => logger.log("legacy", sensitivePayload)).not.toThrow();
  });
});
