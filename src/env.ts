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

  // ── 可选：HTTP/WebSocket ──
  RCS_POLL_TIMEOUT: z.coerce.number().int().positive().default(8),
  RCS_HEARTBEAT_INTERVAL: z.coerce.number().int().positive().default(20),
  RCS_WS_IDLE_TIMEOUT: z.coerce.number().int().positive().default(255),
  RCS_WS_KEEPALIVE_INTERVAL: z.coerce.number().int().positive().default(20),
  RCS_DISCONNECT_TIMEOUT: z.coerce.number().int().positive().default(120),
  RCS_ACP_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1200),
  RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  RCS_ACP_ACTIVITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(7200),
  RCS_AGENT_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),
  RCS_SCHEDULED_AGENT_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),

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
  RCS_DEFAULT_MACHINE_ID: z
    .string()
    .regex(/^mach_/, "RCS_DEFAULT_MACHINE_ID must start with 'mach_'")
    .optional(),

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
