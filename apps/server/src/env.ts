import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { ENGINE_TYPES } from "./services/config/types";

const databaseConnectionPoolSchema = z.object({
  RCS_DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  RCS_DB_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  RCS_DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  RCS_DB_MAX_LIFETIME_SECONDS: z.coerce.number().int().positive().default(3600),
  RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(150),
  RCS_DB_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(5),
});

/** PostgreSQL 连接池的运行时配置。 */
export type DatabaseConnectionPoolConfig = z.infer<typeof databaseConnectionPoolSchema>;

/**
 * 解析数据库连接池配置。
 *
 * 数据库 client 会在应用入口执行完整环境校验前被 ESM 静态导入，因此需要独立解析
 * 此配置子集；完整 `envSchema` 复用同一份 schema，避免两处默认值或校验规则漂移。
 */
export function parseDatabaseConnectionPoolConfig(input: unknown = process.env): DatabaseConnectionPoolConfig {
  return databaseConnectionPoolSchema.parse(input);
}

/**
 * 宿主进程自身运行参数的 env schema。
 *
 * **模块专属变量不在这里**：自 1.7 C 块（`docs/design/ce-ee-refactoring/review/task-1.7-db-config-migration.md`）
 * 起，有唯一模块 owner 的部署变量由该模块的 `fenix.module.ts` 经 `envDefinitions` 声明——agent-runtime 的
 * 运行态旋钮与 workspace 根、knowledge 的 RAGFlow/Gotenberg、sandbox 与 model-management 的整族配置、
 * machine 的 file-ws 治理项、identity 的认证项、channel 的 Hermes 网关、workflow 的工具目录与签名密钥、
 * agent-config 的生成模型与观测透传等。声明与校验仍统一在启动期由 `loadServerEnv()` 汇总
 * （`./env-loader.ts`），宿主消费点经 `readDeclaredEnv()` 取值。
 *
 * **同名键不得两处声明**：`assertNoHostKeyOverride()` 会在启动期直接拒绝，部署也会失败。要改哪个变量就去
 * 它的 owner 模块改，不要往本文件加回同名行——本文件里留下的只有宿主自身参数与多模块共享键
 * （见 `config.ts` 的 `buildConfig` 说明与 agent-runtime manifest 的「不迁的兄弟键」）。
 *
 * 1.7 C 块收尾另删了四个**零消费者**的传输层参数键（`RCS_POLL_TIMEOUT` / `RCS_HEARTBEAT_INTERVAL` /
 * `RCS_WS_IDLE_TIMEOUT` / `RCS_DISCONNECT_TIMEOUT`）——它们的宿主字段已无任何读取点，理由与重建条件见
 * `config.ts` 的同名说明，不要加回。
 */
const envSchema = databaseConnectionPoolSchema.extend({
  // ── 必填 ──
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  RCS_API_KEYS: z.string().min(1, "RCS_API_KEYS is required — used for skill download token HMAC signing"),
  RCS_SYSTEM_API_KEYS: z.string().optional(),

  // ── 可选：服务器 ──
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  RCS_HOST: z.string().default("0.0.0.0"),
  RCS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RCS_CORS_ORIGIN: z.string().default("*"),
  RCS_BASE_URL: z.string().default(""),
  RCS_VERSION: z.string().default("0.1.0"),
  // Bun bundle 输出在应用源码目录外，静态资源需通过此绝对根目录定位，避免依赖启动 cwd。
  RCS_APPLICATION_ROOT: z
    .string()
    .min(1)
    .refine(isAbsolute, "RCS_APPLICATION_ROOT must be an absolute path")
    .optional(),
  APP_BRAND_NAME: z.string().default("Fenix"),
  APP_LOGO_PATH: z.string().default(""),

  // ── 可选：HTTP/WebSocket ──
  RCS_WS_MAX_PAYLOAD_MB: z.coerce.number().int().positive().default(128),
  RCS_DISABLE_SCHEDULER: z
    .string()
    .default("false")
    .transform((value) => value === "true"),

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

  // ── 可选：认证 ──
  RCS_DISABLE_SIGNUP: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

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

  // ── 可选：YJS Redis 快照持久化（C2 切片：SP-A1 节流 / SP-C1 TTL）──
  // 类型/默认值/部署文档的真相来源；包内持久层（packages/chat-channel/src/persist/
  // redis.ts）按同名变量直读（provider 创建于包内 factory 深处，暂无宿主 DI 通道），
  // 宿主把校验后的值经 provider options 注入后应删除包内直读。非法值由包内回落默认。
  RCS_YJS_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  RCS_YJS_SNAPSHOT_IDLE_MS: z.coerce.number().int().positive().default(500),
  RCS_YJS_SNAPSHOT_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
});

export type Env = z.infer<typeof envSchema>;

/** 校验 process.env，成功返回类型安全的环境变量对象，失败则抛异常（测试）或退出进程（生产） */
export function parseEnv(input: unknown = process.env): Env {
  return envSchema.parse(input);
}

/** 校验环境变量并保留现有生产进程退出语义。 */
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
