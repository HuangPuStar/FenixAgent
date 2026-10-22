import { describe, expect, test } from "bun:test";
import { createLogger } from "../index";
import { isSensitiveLogKey, sanitizeLogText, sanitizeLogValue } from "../sanitize";

describe("日志字段匹配脱敏回归", () => {
  // payloadBytes 是字节计数诊断，不能因为 payload 前缀被当成正文抹掉。
  test("保留 payloadBytes 诊断计数", () => {
    expect(sanitizeLogValue({ payloadBytes: 123 })).toEqual({ payloadBytes: 123 });
  });

  // payloadType 用于区分协议消息种类，必须保留原值供排查。
  test("保留 payloadType 诊断分型", () => {
    expect(sanitizeLogValue({ payloadType: "session_data" })).toEqual({ payloadType: "session_data" });
  });

  // tokenCount 是调用量计数而不是凭据本身，显式白名单放行以便观测用量。
  test("保留 tokenCount 诊断计数", () => {
    expect(sanitizeLogValue({ tokenCount: 42 })).toEqual({ tokenCount: 42 });
  });

  // 白名单内的其他诊断字段同样保留，不能因包含敏感词段而误伤。
  test("保留 size/count/length/duration 诊断字段", () => {
    const safe = sanitizeLogValue({
      payloadSize: 2048,
      payloadCount: 3,
      payloadLength: 17,
      payloadDurationMs: 12,
      bodySize: 64,
      contentLength: 9,
      queryDurationMs: 4,
      tokenCount: 42,
    });
    expect(safe).toEqual({
      payloadSize: 2048,
      payloadCount: 3,
      payloadLength: 17,
      payloadDurationMs: 12,
      bodySize: 64,
      contentLength: 9,
      queryDurationMs: 4,
      tokenCount: 42,
    });
  });

  // 紧凑写法的诊断字段仍按白名单保留，避免 TOKENCOUNT 等被误伤。
  test("保留紧凑写法的诊断字段", () => {
    const safe = sanitizeLogValue({
      TOKENCOUNT: 42,
      PAYLOADBYTES: 123,
      PAYLOADTYPE: "session_data",
      PAYLOADDURATIONMS: 12,
    });
    expect(safe).toEqual({
      TOKENCOUNT: 42,
      PAYLOADBYTES: 123,
      PAYLOADTYPE: "session_data",
      PAYLOADDURATIONMS: 12,
    });
  });

  // 白名单不能成为绕过通道，真正的凭据与正文字段仍整体脱敏。
  test("敏感字段仍整体脱敏", () => {
    const safe = sanitizeLogValue({
      token: "forbidden-value",
      access_token: "forbidden-value",
      authorization: "forbidden-value",
      cookie: "forbidden-value",
      password: "forbidden-value",
      secret: "forbidden-value",
      connectionString: "forbidden-value",
      dsn: "forbidden-value",
      sql: "forbidden-value",
      body: "forbidden-value",
      prompt: "forbidden-value",
      payload: "forbidden-value",
    }) as Record<string, unknown>;
    for (const value of Object.values(safe)) expect(value).toBe("[REDACTED]");
  });

  // 白名单之外带计数/体积后缀的敏感键仍必须整体脱敏。
  test("敏感词段搭配诊断后缀仍脱敏", () => {
    const safe = sanitizeLogValue({
      tokenBytes: "forbidden-value",
      passwordSize: "forbidden-value",
      secretCount: "forbidden-value",
      apiKeySize: "forbidden-value",
      credentialCount: "forbidden-value",
      authorizationLength: "forbidden-value",
      cookieBytes: "forbidden-value",
      sqlLength: "forbidden-value",
      dsnCount: "forbidden-value",
    }) as Record<string, unknown>;
    for (const value of Object.values(safe)) expect(value).toBe("[REDACTED]");
  });

  // 复数与紧凑拼接变体沿用包含匹配，不能被窄化后的词段判断漏掉。
  test("复数与紧凑拼接变体仍脱敏", () => {
    const safe = sanitizeLogValue({
      prompts: "forbidden-value",
      payloads: "forbidden-value",
      completions: "forbidden-value",
      authorizations: "forbidden-value",
      connectionStrings: "forbidden-value",
      databaseUrls: "forbidden-value",
      apiKeys: "forbidden-value",
      apiKeysSize: "forbidden-value",
      TOKENBYTES: "forbidden-value",
      PASSWORDSIZE: "forbidden-value",
      promptsCount: "forbidden-value",
      bodies: "forbidden-value",
    }) as Record<string, unknown>;
    for (const value of Object.values(safe)) expect(value).toBe("[REDACTED]");
  });

  // 大小写、下划线、连字符与驼峰变体归一后仍判为敏感。
  test("识别大小写与分隔符变体", () => {
    for (const key of [
      "TOKEN",
      "access-token",
      "ACCESS.TOKEN",
      "Set-Cookie",
      "PASSWORD",
      "client-secret",
      "connection-string",
      "DATABASE_URL",
      "X-Api-Key",
      "DBPassword",
      "privateKey",
      "raw_sql",
      "databaseDsn",
    ]) {
      expect(isSensitiveLogKey(key)).toBe(true);
    }
    for (const key of ["payloadBytes", "payloadType", "message", "status", "code"]) {
      expect(isSensitiveLogKey(key)).toBe(false);
    }
  });

  // 嵌套对象与数组按各自字段名处理，诊断字段不会被相邻敏感字段牵连。
  test("嵌套对象与数组逐字段脱敏", () => {
    const safe = sanitizeLogValue({
      diagnostics: { payloadType: "session_data", payloadBytes: 64 },
      messages: [
        { role: "user", prompt: "forbidden-prompt", token: "forbidden-token" },
        { role: "assistant", completion: "forbidden-completion", payloadType: "text" },
      ],
      headers: { authorization: "Bearer forbidden-header" },
    });
    expect(safe).toEqual({
      diagnostics: { payloadType: "session_data", payloadBytes: 64 },
      messages: [
        { role: "user", prompt: "[REDACTED]", token: "[REDACTED]" },
        { role: "assistant", completion: "[REDACTED]", payloadType: "text" },
      ],
      headers: { authorization: "[REDACTED]" },
    });
  });

  // 错误对象只保留类型、消息、堆栈与错误码，自定义 SQL/连接串/密码属性不展开。
  test("错误对象不展开自定义敏感属性", () => {
    const err = new Error("connect failed");
    Object.assign(err, {
      sql: "SELECT * FROM users",
      dsn: "postgres://app:forbidden-password@db:5432/rcs",
      password: "forbidden-password",
      code: "ECONNREFUSED",
    });
    const safe = sanitizeLogValue(err);
    expect(safe).toMatchObject({ type: "Error", message: "connect failed", code: "ECONNREFUSED" });
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("forbidden-password");
    expect(serialized).not.toContain("SELECT");
    expect(serialized).not.toContain("postgres://");
  });

  // 错误消息是自由文本，其中的连接串凭据同样不能借 Error 路径进入日志。
  test("错误消息中的连接串被脱敏", () => {
    const safe = sanitizeLogValue(new Error("dial postgres://app:forbidden-password@db:5432/rcs failed")) as {
      message: string;
    };
    expect(safe.message).not.toContain("forbidden-password");
    expect(safe.message).toContain("[REDACTED_CONNECTION]");
  });

  // 自由文本中的 URL userinfo、查询参数与认证头继续被抹除。
  test("自由文本 URL 凭据与认证头仍脱敏", () => {
    const text = sanitizeLogText(
      "pg postgres://app:pg-secret@db:5432/rcs " +
        "web https://app:web-secret@example.test/path?token=query-secret " +
        "mongo mongodb://app:mongo-secret@mongo:27017/rcs " +
        "auth Authorization: Bearer bearer-secret " +
        "storage AccountKey=account-secret SharedAccessKey=shared-secret " +
        "cookie Cookie: session=cookie-secret",
    );
    for (const secret of [
      "pg-secret",
      "web-secret",
      "query-secret",
      "mongo-secret",
      "bearer-secret",
      "cookie-secret",
      "account-secret",
      "shared-secret",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  // 敏感键下的 {env:RCS_SECRET_*} 引用属于凭据位置，必须整体脱敏。
  test("敏感键下的环境变量引用仍脱敏", () => {
    expect(
      sanitizeLogValue({
        authorization: "{env:RCS_SECRET_MCP}",
        apiKey: "{env:RCS_SECRET_OPENAI_KEY}",
        connectionString: "{env:RCS_SECRET_DATABASE_URL}",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      apiKey: "[REDACTED]",
      connectionString: "[REDACTED]",
    });
  });

  // 密钥型环境变量赋值与明文密钥等价，自由文本中也不能原样输出。
  test("自由文本中的密钥环境变量赋值被脱敏", () => {
    const text = sanitizeLogText("RCS_SECRET_PROVIDER=provider-secret LANGFUSE_SECRET_KEY=langfuse-secret");
    expect(text).not.toContain("provider-secret");
    expect(text).not.toContain("langfuse-secret");
  });

  // 密钥型 {env:*} 引用只保留“曾有引用”的标记，非密钥引用不受影响。
  test("自由文本中的密钥环境变量引用被脱敏", () => {
    expect(sanitizeLogText("provider ref {env:RCS_SECRET_OPENAI_KEY}")).toBe("provider ref [REDACTED_ENV_REF]");
    expect(sanitizeLogText("level {env:LOG_LEVEL}")).toBe("level {env:LOG_LEVEL}");
  });

  // 日志条目端到端保留诊断字段，同时继续抹掉原始 payload 正文。
  test("日志条目保留诊断字段并脱敏正文", () => {
    const entry = createLogger("relay").formatEntry("debug", "Relay → remote session_data", {
      instanceId: "instance-1",
      payloadType: "session_data",
      payloadBytes: 512,
      payload: { method: "session/update" },
    });
    expect(entry).toMatchObject({
      instanceId: "instance-1",
      payloadType: "session_data",
      payloadBytes: 512,
      payload: "[REDACTED]",
    });
  });
});
