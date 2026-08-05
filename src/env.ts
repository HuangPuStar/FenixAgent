import { z } from "zod/v4";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./services/agent-system-prompt";
import { ENGINE_TYPES } from "./services/config/types";

const envSchema = z.object({
  // ── 必填 ──
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  RCS_API_KEYS: z.string().min(1, "RCS_API_KEYS is required — used for skill download token HMAC signing"),
  RCS_SYSTEM_API_KEYS: z.string().optional(),

  // ── 可选：服务器 ──
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  RCS_HOST: z.string().default("0.0.0.0"),
  RCS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RCS_CORS_ORIGIN: z.string().default("*"),
  RCS_TRUSTED_ORIGINS: z.string().default(""),
  RCS_BASE_URL: z.string().default(""),
  RCS_VERSION: z.string().default("0.1.0"),
  SKILL_DIR: z.string().default("./data/skills"),
  RCS_SYSTEM_ADMIN_PASSWORD_FILE: z.string().default("./data/password.txt"),
  APP_BRAND_NAME: z.string().default("Fenix"),
  APP_LOGO_PATH: z.string().default(""),
  APP_HIDDEN_SIDEBAR_TABS: z.string().default(""),

  // ── 可选：HTTP/WebSocket ──
  RCS_POLL_TIMEOUT: z.coerce.number().int().positive().default(8),
  RCS_HEARTBEAT_INTERVAL: z.coerce.number().int().positive().default(20),
  RCS_WS_IDLE_TIMEOUT: z.coerce.number().int().positive().default(255),
  RCS_WS_KEEPALIVE_INTERVAL: z.coerce.number().int().positive().default(20),
  RCS_DISCONNECT_TIMEOUT: z.coerce.number().int().positive().default(120),
  RCS_ACP_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  RCS_ACP_ACTIVITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1200),
  RCS_AGENT_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),
  RCS_USER_AGENT_MAX_CONCURRENCY: z.coerce.number().int().positive().default(10),
  RCS_SCHEDULED_AGENT_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),

  // ── 可选：file-ws 心跳巡检（P0-1）──
  // keep_alive 间隔 ≤30s 是跨仓库软契约（acp-link 独立仓库），3 倍间隔（90s）判定僵尸；
  // 巡检间隔 30s。默认关闭：旧机器端未实现 keep_alive 或间隔 >90s 时会被误判僵尸，
  // 需灰度逐步开启（见 docs/arch/12-files.md §7.4）。
  RCS_FILE_WS_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  RCS_FILE_WS_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  RCS_FILE_WS_SWEEP_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // ── 可选：file-ws 载荷上限（P1-11a，D12）──
  // file-ws 单帧最大载荷 32MB（§7.6）：远程 upload 单文件 20MB → base64 帧 ~27MB < 32MB。
  // 默认值须与 src/transport/file-ws-payload.ts 的 DEFAULT_FILE_WS_MAX_PAYLOAD_MB 保持一致。
  RCS_FILE_WS_MAX_PAYLOAD_MB: z.coerce.number().int().positive().default(32),

  // ── 可选：file-ws 身份绑定（P2-14，§7.1）──
  // register 对账 core runtime node 注册（registerRemoteNode 产物），未知 machine
  // 严格模式 close(4404)；默认 false（宽松）放行 + 告警。两阶段过渡软开关：
  // 旧机器端（acp-link）无 4404 退避语义、可能 file-ws 先连，服务端先上严格校验会
  // 硬阻塞旧机器端——须机器端先行升级后再开启（见 docs/arch/12-files.md §7.1/§10）。
  RCS_FILE_WS_IDENTITY_STRICT: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // ── 可选：file-events 订阅端点（P1-6b）──
  // 服务级连接上限，与 YJS_MAX_CLIENTS 分池（互不挤占）；超限 close 1013。
  RCS_FILE_EVENTS_MAX_CLIENTS: z.coerce.number().int().positive().default(200),

  // ── 可选：知识库（RagFlow）──
  RAGFLOW_API_URL: z.string().default("http://localhost:9380"),
  RAGFLOW_API_KEY: z.string().default(""),
  RAGFLOW_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // ── 可选：认证 ──
  RCS_DISABLE_SIGNUP: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // ── 可选：Hermes ──
  HERMES_URL: z.string().optional(),
  HERMES_PLATFORMS: z.string().optional(),

  // ── 可选：Hindsight 记忆 MCP ──
  HINDSIGHT_MCP_URL: z.string().optional(),
  HINDSIGHT_API_TOKEN: z.string().optional(),

  // ── 可选：Agent Sites 代理 ──
  AGENT_SITES_BASE_URL: z.string().optional(),
  AGENT_SITES_MASTER_KEY: z.string().optional(),

  // ── 可选：Agent 智能生成（使用标准 OpenAI 环境变量）──
  // OPENAI_API_KEY 和 OPENAI_BASE_URL 由 OpenAI SDK 自动读取，此处仅声明模型名
  OPENAI_MODEL: z.string().optional(),

  // ── 可选：Workflow ──
  // 自定义节点（CustomNode）工具目录，启动时扫描 .ts 文件并实例化注册到 CustomNodeRegistry
  WORKFLOW_TOOLS_DIR: z.string().default("./tools"),

  // ── 可选：注册中心 ──
  REGISTRY_SECRET: z.string().default("rcs-registry-secret"),
  ACPX_G_URL: z.string().default("http://localhost:8848"),

  // ── 可选：引擎 ──
  // 默认 fallback 机器 ID。agent config 未绑定 machineId 时使用此机器替代 local-default
  // preprocess 归一空串：docker-compose 的 `${RCS_DEFAULT_MACHINE_ID:-}` 在 .env 未设置时
  // 会透传空串（而非 undefined），若不归一将触发下方 regex 校验导致服务拒绝启动。
  RCS_DEFAULT_MACHINE_ID: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^mach_/, "RCS_DEFAULT_MACHINE_ID must start with 'mach_'")
      .optional(),
  ),

  // 默认引擎类型。agent config 未指定 engineType 时覆盖硬编码默认值
  RCS_DEFAULT_ENGINE_TYPE: z.enum(ENGINE_TYPES).optional(),
  RCS_AGENT_SYSTEM_PROMPT: z.string().min(1).default(DEFAULT_AGENT_SYSTEM_PROMPT),
  // 禁用 local-default 本地节点。设为 "true" 后所有实例必须路由到远程 machine
  RCS_DISABLE_LOCAL_EXECUTION: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  RCS_CCB_COMMAND: z.string().default("ccb"),
  RCS_CCB_ARGS: z.string().default("--acp"),

  // ── 可选：Redis 缓存 ──
  RCS_REDIS_URL: z.string().optional(),
  RCS_REDIS_PASSWORD: z.string().optional(),
  RCS_REDIS_CLUSTER: z.string().optional(),

  // ── 可选：Workspace 路径 ──
  WORKSPACE_ROOT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** 校验 process.env，成功返回类型安全的环境变量对象，失败则抛异常（测试）或退出进程（生产） */
export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    const message = `[RCS] Environment variable validation failed:\n${issues.join("\n")}`;
    if (process.env.NODE_ENV === "test" || (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST)) {
      throw new Error(message);
    }
    console.error(message);
    process.exit(1);
  }
  return result.data;
}

/**
 * 查找仍被设置但已被新变量取代的废弃环境变量。
 *
 * 仅硬编码维护一条映射（RCS_DEFAULT_MACHINE_TYPE → RCS_DEFAULT_ENGINE_TYPE）：
 * 不做通用扫描——代码无法区分"历史上存在过的变量"与"用户拼写错误的变量"，
 * 通用扫描会产生大量误报。新增废弃变量时必须在此显式登记。
 * 该函数为纯函数，由 index.ts 启动时调用输出告警；不放 validateEnv 内是因为
 * validateEnv 被测试直接调用，告警日志会污染测试输出。
 */
export function findDeprecatedEnvVars(): Array<{ name: string; replacement: string }> {
  const DEPRECATED_ENV_MAP = [{ name: "RCS_DEFAULT_MACHINE_TYPE", replacement: "RCS_DEFAULT_ENGINE_TYPE" }] as const;
  return DEPRECATED_ENV_MAP.filter(({ name }) => process.env[name] !== undefined);
}
