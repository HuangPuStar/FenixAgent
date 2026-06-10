import { z } from "zod/v4";

const envSchema = z.object({
  // ── 必填 ──
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  RCS_API_KEYS: z.string().min(1, "RCS_API_KEYS is required — used for acp-link / worker JWT signing"),

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
  RCS_JWT_EXPIRES_IN: z.coerce.number().int().positive().default(3600),

  // ── 可选：知识库 ──
  RCS_KNOWLEDGE_PROVIDER: z.string().default("openviking"),
  RCS_KNOWLEDGE_BASE_URL: z.string().default("http://localhost:8090"),
  RCS_KNOWLEDGE_API_KEY: z.string().default(""),
  RCS_KNOWLEDGE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // ── 可选：S3 ──
  RCS_S3_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  RCS_S3_ENDPOINT: z.string().default("http://localhost:9000"),
  RCS_S3_REGION: z.string().default("us-east-1"),
  RCS_S3_ACCESS_KEY: z.string().default(""),
  RCS_S3_SECRET_KEY: z.string().default(""),
  RCS_S3_BUCKET_SESSIONS: z.string().default("rcs-sessions"),
  RCS_S3_BUCKET_ASSETS: z.string().default("rcs-assets"),
  RCS_S3_PRESIGN_EXPIRES: z.coerce.number().int().positive().default(3600),
  RCS_S3_PRESIGN_UPLOAD_EXPIRES: z.coerce.number().int().positive().default(600),

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

  // ── 可选：Agent 智能生成（使用标准 OpenAI 环境变量）──
  // OPENAI_API_KEY 和 OPENAI_BASE_URL 由 OpenAI SDK 自动读取，此处仅声明模型名
  OPENAI_MODEL: z.string().optional(),

  // ── 可选：Workflow ──

  // ── 可选：注册中心 ──
  REGISTRY_SECRET: z.string().default("rcs-registry-secret"),
  ACPX_G_URL: z.string().default("http://localhost:8848"),

  // ── 可选：引擎 ──
  RCS_ENGINE_TYPE: z.enum(["opencode", "ccb"]).default("opencode"),
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
