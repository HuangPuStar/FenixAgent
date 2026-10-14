import * as z from "zod/v4";

/**
 * 公共 Git 连接配置的解析：`AOS_GIT_CONFIG_FILE` 的文件内容 → {@link GitModuleConfig}。
 *
 * 纯函数、不读文件、不读 env：文件路径与密钥值都由宿主（`apps/server` 的模块配置投影）传入，本包只在
 * 装配期解析一次结果。这样包内不出现第二份环境解析（两处默认值分歧无法在启动期暴露），也把「配置文件
 * 内容」与「读文件的动作」拆开——单元测试直接传字符串即可覆盖全部规则，不必造文件与 env。
 *
 * 安全口径（方案 §4）：
 * - 配置文件里只允许出现**密钥引用**（`{env:NAME}`），凭据值只经宿主注入的 secrets 表进入内存；
 * - 引用的 NAME 必须已由宿主注入，未声明的引用当场拒绝，而不是留给 Forgejo 401；
 * - 错误消息允许出现字段路径与变量名，**禁止**回显 baseUrl 与任何密钥值——baseUrl 可能被误写成内嵌
 *   用户名/口令的 URL，JSON 解析失败的原文可能带上文件片段（见 {@link parseConfigJson}）。
 */

/** 连接 id 的字符集：id 会进日志与绑定表，限定小写字母/数字/连字符以避免大小写与转义歧义。 */
const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** 密钥引用语法 `{env:NAME}`；NAME 只允许常规环境变量字符集，`{env:}` 之类的空引用不成立。 */
const ENV_REF_PATTERN = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const MIN_MAX_CONCURRENT_REQUESTS = 1;
const MAX_MAX_CONCURRENT_REQUESTS = 64;

/** 一个已解析完毕的连接；构造适配器所需的全部参数都在这里，运行期不再回读配置文件。 */
export interface GitConnectionConfig {
  /** 连接 ID（配置文件里的 `connections[].id`），绑定表与日志用它关联。 */
  readonly id: string;
  /** 归一化后的 origin（http/https 且无路径、查询、片段与内嵌凭据）；请求 URL 一律以此为基准拼接。 */
  readonly baseUrl: string;
  /**
   * 初始化凭据的**值**（配置文件里的 `{env:NAME}` 引用已由本函数解析）。
   *
   * 只用于建仓库、建 Webhook 等装配期动作；日常读写走绑定记录的 `credentialRef`，两者刻意分开，
   * 避免受限业务路径拿到能创建仓库的凭据。
   */
  readonly provisionToken: string;
  /** 单次 Forgejo 请求超时（毫秒）。 */
  readonly requestTimeoutMs: number;
  /** 单连接并发请求上限。 */
  readonly maxConcurrentRequests: number;
}

/** 宿主投影给 Git 模块的完整配置。 */
export interface GitModuleConfig {
  /** 已启用的连接；空数组表示未配置（未启用 git 的装配也会投影空数组，语义由调用方判定）。 */
  readonly connections: readonly GitConnectionConfig[];
  /**
   * 宿主注入的密钥值表，只含 Git manifest 已声明的 secret 键。
   *
   * 绑定记录的 `credentialRef`（同样是 `{env:NAME}`）在**运行期**靠它解析成日常凭据值，因此不能只在
   * 解析函数里用完即弃。密钥值只驻留进程内存：禁止进日志、错误消息与任何响应。
   */
  readonly secretValues: Readonly<Record<string, string>>;
}

/**
 * 配置文件里的单个连接（原始形状，只在解析阶段存在）。
 *
 * 默认值在这一层补齐；越界值一律**拒绝而不是夹取**：部署配置写错时应在启动期失败，静默夹取会让
 * 「配了 1000 ms 却按 120000 ms 跑」这类偏差没人察觉。
 */
const rawConnectionSchema = z.strictObject({
  id: z.string().regex(CONNECTION_ID_PATTERN, "连接 id 必须匹配 ^[a-z][a-z0-9-]{0,63}$"),
  baseUrl: z.string().min(1, "baseUrl 不能为空"),
  provisionTokenRef: z.string().min(1, "provisionTokenRef 不能为空"),
  requestTimeoutMs: z
    .number()
    .int()
    .min(MIN_REQUEST_TIMEOUT_MS, `requestTimeoutMs 不能小于 ${MIN_REQUEST_TIMEOUT_MS}`)
    .max(MAX_REQUEST_TIMEOUT_MS, `requestTimeoutMs 不能大于 ${MAX_REQUEST_TIMEOUT_MS}`)
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
  maxConcurrentRequests: z
    .number()
    .int()
    .min(MIN_MAX_CONCURRENT_REQUESTS, `maxConcurrentRequests 不能小于 ${MIN_MAX_CONCURRENT_REQUESTS}`)
    .max(MAX_MAX_CONCURRENT_REQUESTS, `maxConcurrentRequests 不能大于 ${MAX_MAX_CONCURRENT_REQUESTS}`)
    .default(DEFAULT_MAX_CONCURRENT_REQUESTS),
});

/** 配置文件顶层形状；`strictObject` 让拼错的键在启动期失败，而不是被静默忽略。 */
const rawConfigSchema = z.strictObject({
  connections: z.array(rawConnectionSchema),
});

/**
 * 已解析配置的形状校验；宿主投影后仍可复用它复核（`z.ZodType<GitModuleConfig>` 的标注让「接口加了
 * 字段而 schema 没加」在编译期报错）。
 *
 * `connections` 允许为空：未启用 git 的装配会投影 `{ connections: [] }`，空连接的语义（启动失败还是
 * 无 Git 能力）由调用方判定——解析层已经拒绝空配置文件，schema 不重复承担这条业务规则。
 * `secretValues` 给默认值 `{}`：漏投影密钥表只会让所有 `credentialRef` 解析被拒（安全侧失败），
 * 不应表现成整份配置校验不通过。
 */
export const GitModuleConfigSchema: z.ZodType<GitModuleConfig> = z.strictObject({
  connections: z.array(
    z.strictObject({
      id: z.string().regex(CONNECTION_ID_PATTERN, "连接 id 必须匹配 ^[a-z][a-z0-9-]{0,63}$"),
      baseUrl: z
        .string()
        .min(1)
        .refine((value) => describeBaseUrlProblem(value) === null, "baseUrl 必须是 http/https 的 origin"),
      provisionToken: z.string().min(1),
      requestTimeoutMs: z.number().int().min(MIN_REQUEST_TIMEOUT_MS).max(MAX_REQUEST_TIMEOUT_MS),
      maxConcurrentRequests: z.number().int().min(MIN_MAX_CONCURRENT_REQUESTS).max(MAX_MAX_CONCURRENT_REQUESTS),
    }),
  ),
  secretValues: z.record(z.string(), z.string()).default({}),
});

/**
 * 解析 `AOS_GIT_CONFIG_FILE` 的 JSON 文本。
 *
 * @param raw 配置文件原文（宿主读取后传入；本函数不接触文件系统）
 * @param secrets 宿主注入的密钥值表，键集合即 manifest 已声明的 secret 键
 * @throws Error 配置缺失、形状非法、baseUrl 非纯 origin、引用未声明或未提供值的密钥
 */
export function parseGitModuleConfig(raw: string, secrets: Readonly<Record<string, string>>): GitModuleConfig {
  const parsed = rawConfigSchema.safeParse(parseConfigJson(raw));
  if (!parsed.success) {
    throw new Error(`AOS_GIT_CONFIG_FILE 校验失败：${formatIssues(parsed.error)}`);
  }
  if (parsed.data.connections.length === 0) {
    throw new Error("AOS_GIT_CONFIG_FILE 未配置任何连接（connections 为空）");
  }

  const seenIds = new Set<string>();
  const connections = parsed.data.connections.map((connection, index): GitConnectionConfig => {
    const context = `connections[${index}]`;
    if (seenIds.has(connection.id)) {
      throw new Error(`AOS_GIT_CONFIG_FILE 连接 id 重复：${connection.id}`);
    }
    seenIds.add(connection.id);

    const baseUrlProblem = describeBaseUrlProblem(connection.baseUrl);
    if (baseUrlProblem !== null) {
      throw new Error(`AOS_GIT_CONFIG_FILE ${context}.baseUrl ${baseUrlProblem}`);
    }

    return {
      id: connection.id,
      baseUrl: new URL(connection.baseUrl).origin,
      provisionToken: resolveSecretRef(connection.provisionTokenRef, secrets, `${context}.provisionTokenRef`),
      requestTimeoutMs: connection.requestTimeoutMs,
      maxConcurrentRequests: connection.maxConcurrentRequests,
    };
  });

  // 复制一份再外露：投影对象由宿主持有，模块内解析 credentialRef 时不应受宿主后续改动影响。
  return { connections, secretValues: { ...secrets } };
}

/**
 * 校验 baseUrl 是不是「只含一个 origin」，返回问题描述（null 表示合法）。
 *
 * 返回描述而不是直接抛错，是为了让 {@link GitModuleConfigSchema} 与 {@link parseGitModuleConfig} 共用
 * 同一套规则。描述里**不带**原始值：baseUrl 可能被误写成内嵌用户名/口令的 URL，而错误消息会进日志。
 */
function describeBaseUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "必须是合法的 http/https URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "只允许 http 或 https";
  if (url.username !== "" || url.password !== "") return "不得内嵌用户名或口令";
  // 尾部单个 `/` 是 origin 的规范写法（URL 总会把空路径解析成 `/`），不算路径。
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    return "只能配置 origin，不得带路径、查询或片段";
  }
  return null;
}

/**
 * 解析 `{env:NAME}` 引用。
 *
 * NAME 必须存在于 `secrets`（宿主只投影 manifest 声明过的键），否则说明配置文件引用了本模块无权读取
 * 的凭据，必须当场拒绝。已声明但值为空同样拒绝：带着空 token 出站只会在 Forgejo 侧变成 401，把
 * 「忘配密钥」伪装成远端故障。消息只带变量名——变量名不敏感，值一律不回显。
 */
function resolveSecretRef(ref: string, secrets: Readonly<Record<string, string>>, context: string): string {
  const match = ENV_REF_PATTERN.exec(ref);
  if (match === null) {
    throw new Error(`AOS_GIT_CONFIG_FILE ${context} 必须是 {env:NAME} 形式的密钥引用`);
  }
  const name = match[1];
  const value = secrets[name];
  if (value === undefined) {
    throw new Error(`AOS_GIT_CONFIG_FILE ${context} 引用了未声明的密钥 ${name}`);
  }
  if (value === "") {
    throw new Error(`AOS_GIT_CONFIG_FILE ${context} 引用的密钥 ${name} 未提供值`);
  }
  return value;
}

/**
 * 解析配置文件文本。
 *
 * 刻意不透传 `JSON.parse` 的异常消息：V8 与 JavaScriptCore 的报错都会带上文件片段，而配置文件里
 * 理论上只该有 `{env:NAME}` 引用——运维一旦误把凭据值粘进来，透传就等于把它写进启动日志。
 */
function parseConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("AOS_GIT_CONFIG_FILE 内容不是合法 JSON");
  }
}

/** 汇总 zod 失败：只给字段路径与我方定义的静态消息，不回显字段值（文件里可能混入凭据材料）。 */
function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("；");
}
