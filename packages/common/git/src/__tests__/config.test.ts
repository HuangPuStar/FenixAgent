import { describe, expect, test } from "bun:test";
import { GitModuleConfigSchema, parseGitModuleConfig } from "../server/config";

/**
 * 连接配置解析的契约测试（方案 §4）。
 *
 * 这一层是**启动期安全边界**：配置文件里只允许出现 `{env:NAME}` 引用，凭据值只能经宿主注入的 secrets
 * 表进入内存，未声明的引用必须当场拒绝，而不是留给 Forgejo 回 401。因此用例除了断言「什么被接受」，
 * 还要断言「错误消息不回显值」与「越界值不被静默夹取」——这两条决定运维能不能在启动期看出配置写错了。
 *
 * 全部用例只传字符串与 secrets 表：`parseGitModuleConfig` 不读文件、不读 env，测试因此不需要夹具文件。
 */

const PROVISION_TOKEN_VALUE = "test-provision-token-value";
const SECRETS: Readonly<Record<string, string>> = {
  AOS_GIT_PROVISION_TOKEN: PROVISION_TOKEN_VALUE,
  AOS_GIT_SERVICE_TOKEN: "test-service-token-value",
};

/** 单个合法连接；用例只覆盖需要变化的字段。 */
function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "primary",
    baseUrl: "https://git.example.com",
    provisionTokenRef: "{env:AOS_GIT_PROVISION_TOKEN}",
    ...overrides,
  };
}

function configText(connections: readonly unknown[]): string {
  return JSON.stringify({ connections });
}

/** 断言解析失败并取回错误（用于检查消息内容），失败时给出比 `toThrow` 更明确的诊断。 */
function rejectionOf(raw: string, secrets: Readonly<Record<string, string>> = SECRETS): Error {
  try {
    parseGitModuleConfig(raw, secrets);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("期望配置被拒绝，但解析成功了");
}

describe("合法配置", () => {
  // 最小合法配置解析出连接坐标与密钥值，并补齐默认超时 15s 与并发上限 16。
  test("parses a minimal connection and fills in defaults", () => {
    const config = parseGitModuleConfig(configText([connection()]), SECRETS);

    expect(config.connections).toHaveLength(1);
    expect(config.connections[0]).toEqual({
      id: "primary",
      baseUrl: "https://git.example.com",
      provisionToken: PROVISION_TOKEN_VALUE,
      requestTimeoutMs: 15_000,
      maxConcurrentRequests: 16,
    });
  });

  // baseUrl 归一化为 origin：尾斜杠与大小写差异不应该影响后续请求 URL 的拼接结果。
  test("normalizes baseUrl to its origin", () => {
    const config = parseGitModuleConfig(
      configText([connection({ baseUrl: "https://Git.Example.COM:8443/" })]),
      SECRETS,
    );

    expect(config.connections[0]?.baseUrl).toBe("https://git.example.com:8443");
  });

  // 显式给出的合法边界值原样保留：上限 120000 ms / 64 不被改写，默认值只在字段缺席时生效。
  test("keeps explicitly configured timeout and concurrency", () => {
    const config = parseGitModuleConfig(
      configText([connection({ requestTimeoutMs: 120_000, maxConcurrentRequests: 64 })]),
      SECRETS,
    );

    expect(config.connections[0]?.requestTimeoutMs).toBe(120_000);
    expect(config.connections[0]?.maxConcurrentRequests).toBe(64);
  });

  // 解析结果携带 secrets 表的副本：宿主后续改动投影对象不得影响模块内 credentialRef 的解析。
  test("copies the secret values instead of aliasing the host projection", () => {
    const mutableSecrets: Record<string, string> = { ...SECRETS };
    const config = parseGitModuleConfig(configText([connection()]), mutableSecrets);

    mutableSecrets.AOS_GIT_PROVISION_TOKEN = "rotated-after-parse";

    expect(config.secretValues.AOS_GIT_PROVISION_TOKEN).toBe(PROVISION_TOKEN_VALUE);
  });

  // 多连接配置各自独立解析：连接之间只共享密钥表，不共享 baseUrl 等参数。
  test("parses multiple connections independently", () => {
    const config = parseGitModuleConfig(
      configText([
        connection(),
        connection({ id: "secondary", baseUrl: "http://git.internal:3210", requestTimeoutMs: 2_000 }),
      ]),
      SECRETS,
    );

    expect(config.connections.map((entry) => entry.id)).toEqual(["primary", "secondary"]);
    expect(config.connections[1]?.baseUrl).toBe("http://git.internal:3210");
    expect(config.connections[1]?.requestTimeoutMs).toBe(2_000);
    expect(config.connections[0]?.requestTimeoutMs).toBe(15_000);
  });
});

describe("配置缺失与形状", () => {
  // 缺 connections 字段 → 拒绝：模块不能以「半个配置」的状态进入运行期。
  test("rejects a config without the connections field", () => {
    expect(() => parseGitModuleConfig("{}", SECRETS)).toThrow(/校验失败/);
  });

  // connections 为空数组 → 拒绝：解析层拒绝空配置，启用与否的语义留给调用方判定。
  test("rejects an empty connections array", () => {
    expect(() => parseGitModuleConfig(configText([]), SECRETS)).toThrow(/未配置任何连接/);
  });

  // 非 JSON 文本 → 拒绝，且消息不回显原文：配置文件里可能被误粘入凭据值，原文不能进启动日志。
  test("rejects malformed JSON without echoing the file content", () => {
    const broken = '{"connections": [{"provisionTokenRef": "leaked-value"';
    const error = rejectionOf(broken);

    expect(error.message).toContain("不是合法 JSON");
    expect(error.message).not.toContain("leaked-value");
  });

  // 未知顶层键 → 拒绝：拼错的键必须当场暴露，而不是被静默忽略成「配置没生效」。
  test("rejects unknown top-level keys", () => {
    expect(() => parseGitModuleConfig('{"connections":[],"extra":1}', SECRETS)).toThrow(/校验失败/);
  });

  // 连接内未知键 → 拒绝：单个连接的拼写错误同样属于启动期配置缺陷。
  test("rejects unknown connection keys", () => {
    expect(() => parseGitModuleConfig(configText([connection({ timeoutMs: 5_000 })]), SECRETS)).toThrow(/校验失败/);
  });
});

describe("baseUrl", () => {
  // 非 http/https、带路径/查询/片段、内嵌凭据或压根不是 URL 的 baseUrl 一律拒绝（只允许 origin）。
  test("rejects baseUrl that is not a bare http(s) origin", () => {
    const invalid = [
      "ftp://git.example.com",
      "git.example.com",
      "https://git.example.com/sub/path",
      "https://git.example.com/api/v1",
      "https://git.example.com?token=1",
      "https://git.example.com#frag",
      "https://user:pass@git.example.com",
    ];

    for (const baseUrl of invalid) {
      const error = rejectionOf(configText([connection({ baseUrl })]));
      expect(error.message).toContain("baseUrl");
    }
  });

  // baseUrl 的错误消息不回显原值：运维可能把带凭据的 URL 写进来，消息会进日志。
  test("does not echo the rejected baseUrl in the error message", () => {
    const error = rejectionOf(configText([connection({ baseUrl: "https://svc:s3cret@git.example.com" })]));

    expect(error.message).not.toContain("s3cret");
    expect(error.message).not.toContain("git.example.com");
  });
});

describe("provisionTokenRef", () => {
  // 明文凭据或非法引用形式 → 拒绝：配置文件里只允许 {env:NAME}，值不得落地。
  test("rejects a plaintext token reference and does not echo it", () => {
    const error = rejectionOf(configText([connection({ provisionTokenRef: "plaintext-token" })]));

    expect(error.message).toContain("{env:NAME}");
    expect(error.message).not.toContain("plaintext-token");
  });

  // 引用宿主未声明的密钥 → 拒绝，消息只含变量名：本模块无权读取的凭据不能因为写错名字而被读走。
  test("rejects a reference to an undeclared secret", () => {
    const error = rejectionOf(configText([connection({ provisionTokenRef: "{env:AOS_GIT_UNKNOWN_TOKEN}" })]));

    expect(error.message).toContain("AOS_GIT_UNKNOWN_TOKEN");
    expect(error.message).not.toContain(PROVISION_TOKEN_VALUE);
  });

  // 已声明但值为空的密钥 → 拒绝：空 token 出站只会变成 Forgejo 401，把「忘配密钥」伪装成远端故障。
  test("rejects a declared secret that has no value", () => {
    const error = rejectionOf(configText([connection()]), { AOS_GIT_PROVISION_TOKEN: "" });

    expect(error.message).toContain("未提供值");
    expect(error.message).toContain("AOS_GIT_PROVISION_TOKEN");
  });
});

describe("连接 id", () => {
  // id 字符集与唯一性都会进绑定表与日志：大写、数字开头、超长与重复都必须当场拒绝。
  test("rejects ids outside the pattern and duplicate ids", () => {
    const invalidIds = ["Primary", "1primary", "primary_with_underscore", `a${"b".repeat(64)}`];

    for (const id of invalidIds) {
      // zod 的字段路径是 `connections.0.id`（数组下标不是括号形式），这里只锁定它指到了哪个字段。
      expect(rejectionOf(configText([connection({ id })])).message).toContain("connections.0.id");
    }

    const duplicated = configText([connection(), connection({ baseUrl: "https://git2.example.com" })]);
    expect(rejectionOf(duplicated).message).toContain("连接 id 重复：primary");
  });
});

describe("默认值与越界值", () => {
  // 越界的 requestTimeoutMs → 拒绝而不是静默夹取：配错的时长必须在启动期暴露，不能悄悄按别的值运行。
  test("rejects out-of-range requestTimeoutMs", () => {
    for (const requestTimeoutMs of [999, 120_001, 15_000.5]) {
      expect(rejectionOf(configText([connection({ requestTimeoutMs })])).message).toContain("requestTimeoutMs");
    }
  });

  // 越界的 maxConcurrentRequests → 拒绝；边界 1 合法（等于串行，但仍是调用方的显式选择）。
  test("rejects out-of-range maxConcurrentRequests and accepts the lower boundary", () => {
    for (const maxConcurrentRequests of [0, 65, -1]) {
      expect(rejectionOf(configText([connection({ maxConcurrentRequests })])).message).toContain(
        "maxConcurrentRequests",
      );
    }

    const config = parseGitModuleConfig(configText([connection({ maxConcurrentRequests: 1 })]), SECRETS);
    expect(config.connections[0]?.maxConcurrentRequests).toBe(1);
  });
});

describe("GitModuleConfigSchema", () => {
  // 宿主二次复核路径：空 connections 与缺省 secretValues 合法（未启用 git 的装配也投影该形状）。
  test("accepts the projection shape of an unconfigured module", () => {
    const parsed = GitModuleConfigSchema.safeParse({ connections: [] });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.secretValues).toEqual({});
  });

  // 解析器产出的配置必须能通过 schema 复核：两条规则的默认值/归一化口径不允许漂移。
  test("accepts the output of parseGitModuleConfig", () => {
    const config = parseGitModuleConfig(configText([connection()]), SECRETS);
    const parsed = GitModuleConfigSchema.safeParse(config);

    expect(parsed.success).toBe(true);
  });

  // schema 与解析器共用 baseUrl 规则：绕过解析器直接投影非法 origin 同样被拒绝。
  test("rejects a non-origin baseUrl in the schema as well", () => {
    const parsed = GitModuleConfigSchema.safeParse({
      connections: [
        {
          id: "primary",
          baseUrl: "https://git.example.com/path",
          provisionToken: PROVISION_TOKEN_VALUE,
          requestTimeoutMs: 15_000,
          maxConcurrentRequests: 16,
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});
