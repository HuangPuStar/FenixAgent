/**
 * SecretsResolver 测试 — 密钥解析与脱敏
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretsResolver } from "../../secrets/secrets-resolver";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";

// ---------- 辅助工具 ----------

/** 创建临时目录 */
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "secrets-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  // 清理测试环境变量
  delete process.env.WF_TEST_SECRET_1;
  delete process.env.WF_TEST_SECRET_2;
  delete process.env.WF_TEST_SECRET_3;
});

/** 创建 .env 文件并返回路径 */
function writeEnvFile(content: string): string {
  const envPath = join(tempDir, ".env");
  writeFileSync(envPath, content, "utf-8");
  return envPath;
}

// ========== resolve 测试 ==========

describe("SecretsResolver.resolve", () => {
  // 从系统环境变量解析
  test("从系统环境变量解析密钥", async () => {
    process.env.WF_TEST_SECRET_1 = "sys-value-1";
    const resolver = new SecretsResolver();
    const result = await resolver.resolve(["WF_TEST_SECRET_1"]);

    expect(result).toEqual({ WF_TEST_SECRET_1: "sys-value-1" });
  });

  // 从 .env 文件解析
  test("从 .env 文件解析密钥", async () => {
    const envPath = writeEnvFile("MY_API_KEY=file-value-123");
    const resolver = new SecretsResolver({ envFile: envPath });
    const result = await resolver.resolve(["MY_API_KEY"]);

    expect(result).toEqual({ MY_API_KEY: "file-value-123" });
  });

  // 优先级：系统环境变量 > .env 文件
  test("系统环境变量优先于 .env 文件", async () => {
    process.env.WF_TEST_SECRET_2 = "from-system";
    const envPath = writeEnvFile("WF_TEST_SECRET_2=from-file");
    const resolver = new SecretsResolver({ envFile: envPath });
    const result = await resolver.resolve(["WF_TEST_SECRET_2"]);

    expect(result).toEqual({ WF_TEST_SECRET_2: "from-system" });
  });

  // 密钥不存在 → 抛出 SECRET_NOT_FOUND 错误
  test("密钥不存在时抛出 SECRET_NOT_FOUND", async () => {
    const resolver = new SecretsResolver();

    try {
      await resolver.resolve(["NONEXISTENT_SECRET_KEY"]);
      expect.unreachable("应该抛出 WorkflowError");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).code).toBe(WorkflowErrorCode.SECRET_NOT_FOUND);
      expect((err as WorkflowError).message).toContain("NONEXISTENT_SECRET_KEY");
      expect((err as WorkflowError).details).toEqual({ key: "NONEXISTENT_SECRET_KEY" });
    }
  });

  // 多个密钥混合来源
  test("多个密钥混合来源解析", async () => {
    process.env.WF_TEST_SECRET_1 = "sys-val";
    const envPath = writeEnvFile("FILE_KEY=file-val");
    const resolver = new SecretsResolver({ envFile: envPath });
    const result = await resolver.resolve(["WF_TEST_SECRET_1", "FILE_KEY"]);

    expect(result).toEqual({ WF_TEST_SECRET_1: "sys-val", FILE_KEY: "file-val" });
  });

  // 部分密钥缺失 → 抛错
  test("部分密钥缺失时抛出错误", async () => {
    process.env.WF_TEST_SECRET_1 = "exists";
    const resolver = new SecretsResolver();

    try {
      await resolver.resolve(["WF_TEST_SECRET_1", "MISSING_KEY"]);
      expect.unreachable("应该抛出 WorkflowError");
    } catch (err) {
      expect((err as WorkflowError).code).toBe(WorkflowErrorCode.SECRET_NOT_FOUND);
      expect((err as WorkflowError).details?.key).toBe("MISSING_KEY");
    }
  });
});

// ========== .env 文件解析测试 ==========

describe(".env 文件解析", () => {
  // 注释和空行处理
  test("跳过注释行和空行", async () => {
    const envPath = writeEnvFile(`
# 这是注释
KEY1=value1

KEY2=value2
# 另一个注释
`);
    const resolver = new SecretsResolver({ envFile: envPath });
    const result = await resolver.resolve(["KEY1", "KEY2"]);

    expect(result).toEqual({ KEY1: "value1", KEY2: "value2" });
  });

  // 双引号包裹的值
  test("去除双引号包裹的值", async () => {
    const envPath = writeEnvFile('QUOTED="hello world"');
    const resolver = new SecretsResolver({ envFile: envPath });
    const result = await resolver.resolve(["QUOTED"]);

    expect(result).toEqual({ QUOTED: "hello world" });
  });

  // 值中包含等号
  test("值中包含等号时正确解析", async () => {
    const envPath = writeEnvFile("CONN_STR=postgres://user:pass@host:5432/db?option=val");
    const resolver = new SecretsResolver({ envFile: envPath });
    const result = await resolver.resolve(["CONN_STR"]);

    expect(result).toEqual({ CONN_STR: "postgres://user:pass@host:5432/db?option=val" });
  });

  // .env 文件不存在 → 回退到系统环境变量
  test(".env 文件不存在时回退到系统环境变量", async () => {
    process.env.WF_TEST_SECRET_3 = "from-env";
    const resolver = new SecretsResolver({ envFile: "/nonexistent/path/.env" });
    const result = await resolver.resolve(["WF_TEST_SECRET_3"]);

    expect(result).toEqual({ WF_TEST_SECRET_3: "from-env" });
  });

  // 无 envFile 配置 → 仅从系统环境变量
  test("未配置 envFile 时仅从系统环境变量读取", async () => {
    process.env.WF_TEST_SECRET_1 = "sys-only";
    const resolver = new SecretsResolver();
    const result = await resolver.resolve(["WF_TEST_SECRET_1"]);

    expect(result).toEqual({ WF_TEST_SECRET_1: "sys-only" });
  });

  // 无效行（无等号）跳过
  test("无等号的无效行被跳过", async () => {
    const envPath = writeEnvFile("VALID_KEY=valid_value\nINVALID_LINE_NO_EQUALS\nANOTHER_KEY=another_val");
    const resolver = new SecretsResolver({ envFile: envPath });
    const result = await resolver.resolve(["VALID_KEY", "ANOTHER_KEY"]);

    expect(result).toEqual({ VALID_KEY: "valid_value", ANOTHER_KEY: "another_val" });
  });
});

// ========== redactSecrets 测试 ==========

describe("SecretsResolver.redactSecrets", () => {
  // 简单字符串替换
  test("简单字符串值精确匹配替换", () => {
    const resolver = new SecretsResolver();
    const metadata = { token: "abc123", name: "test" };
    const secrets = { API_KEY: "abc123" };

    const result = resolver.redactSecrets(metadata, secrets);

    expect(result).toEqual({ token: "***", name: "test" });
  });

  // 嵌套对象值替换
  test("递归处理嵌套对象", () => {
    const resolver = new SecretsResolver();
    const metadata = {
      level1: {
        level2: {
          password: "secret-pw",
          visible: "public",
        },
      },
    };
    const secrets = { DB_PASSWORD: "secret-pw" };

    const result = resolver.redactSecrets(metadata, secrets);

    expect(result).toEqual({
      level1: {
        level2: {
          password: "***",
          visible: "public",
        },
      },
    });
  });

  // 数组值替换
  test("递归处理数组中的字符串", () => {
    const resolver = new SecretsResolver();
    const metadata = {
      args: ["--key", "super-secret", "--other"],
      headers: { auth: "bearer-token-xyz" },
    };
    const secrets = { AUTH_TOKEN: "super-secret", API_KEY: "bearer-token-xyz" };

    const result = resolver.redactSecrets(metadata, secrets);

    expect(result).toEqual({
      args: ["--key", "***", "--other"],
      headers: { auth: "***" },
    });
  });

  // 非字符串值保持不变
  test("非字符串值原样保留", () => {
    const resolver = new SecretsResolver();
    const metadata = {
      count: 42,
      enabled: true,
      value: null,
      ratio: 3.14,
    };
    const secrets = { ANY_KEY: "any-value" };

    const result = resolver.redactSecrets(metadata, secrets);

    expect(result).toEqual({
      count: 42,
      enabled: true,
      value: null,
      ratio: 3.14,
    });
  });

  // 不修改输入对象
  test("不修改原始输入对象", () => {
    const resolver = new SecretsResolver();
    const metadata = { password: "my-secret", name: "original" };
    const secrets = { PW: "my-secret" };

    const result = resolver.redactSecrets(metadata, secrets);

    // 原对象不变
    expect(metadata).toEqual({ password: "my-secret", name: "original" });
    // 返回新对象
    expect(result).not.toBe(metadata);
    expect(result).toEqual({ password: "***", name: "original" });
  });

  // 子串不替换（精确匹配）
  test("子串不替换，仅精确匹配", () => {
    const resolver = new SecretsResolver();
    const metadata = {
      url: "https://api.example.com/path?token=abc123&other=1",
      token: "abc123",
    };
    const secrets = { TOKEN: "abc123" };

    const result = resolver.redactSecrets(metadata, secrets);

    // url 中的 abc123 是子串，不应替换
    expect(result).toEqual({
      url: "https://api.example.com/path?token=abc123&other=1",
      token: "***",
    });
  });

  // 空密钥集合 → 原样返回
  test("空密钥集合时原样返回", () => {
    const resolver = new SecretsResolver();
    const metadata = { key: "value" };

    const result = resolver.redactSecrets(metadata, {});

    expect(result).toEqual({ key: "value" });
  });

  // 空元数据 → 返回空对象
  test("空元数据返回空对象", () => {
    const resolver = new SecretsResolver();

    const result = resolver.redactSecrets({}, { KEY: "val" });

    expect(result).toEqual({});
  });
});
