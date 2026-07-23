import { resolve } from "node:path";
import type { Env } from "./env";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./services/agent-system-prompt";

function buildConfig(env: Env) {
  return {
    version: env.RCS_VERSION,
    port: env.RCS_PORT,
    host: env.RCS_HOST,
    baseUrl: env.RCS_BASE_URL,
    skillDir: resolve(env.SKILL_DIR ?? "./data/skills"),
    systemAdminPasswordFile: resolve(env.RCS_SYSTEM_ADMIN_PASSWORD_FILE ?? "./data/password.txt"),
    pollTimeout: env.RCS_POLL_TIMEOUT,
    heartbeatInterval: env.RCS_HEARTBEAT_INTERVAL,
    /** Bun WebSocket idle timeout (seconds). Bun sends protocol-level pings after
     *  this many seconds of no received data. Set higher than
     *  wsKeepaliveInterval * 3 so that application-level keepalive detects dead
     *  connections before Bun closes them. Default 255s (Bun's built-in default). */
    wsIdleTimeout: env.RCS_WS_IDLE_TIMEOUT,
    /** Server→client keep_alive data-frame interval (seconds). Keeps reverse
     *  proxies from closing idle connections. Default 20s. */
    wsKeepaliveInterval: env.RCS_WS_KEEPALIVE_INTERVAL,
    /** Disconnect timeout (seconds). Environments/sessions with no activity for
     *  this long are considered disconnected. Default 120s. */
    disconnectTimeout: env.RCS_DISCONNECT_TIMEOUT,
    /** Idle timeout in seconds before an unobserved ACP instance is auto-stopped. */
    acpIdleTimeoutSeconds: env.RCS_ACP_IDLE_TIMEOUT_SECONDS,
    /** Sweep interval in seconds for ACP idle instance cleanup. */
    acpIdleSweepIntervalSeconds: env.RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS,
    /** Hard timeout in seconds for no ACP business activity, even if relay is still attached. */
    acpActivityTimeoutSeconds: env.RCS_ACP_ACTIVITY_TIMEOUT_SECONDS,
    /** 全部活跃 Agent 实例的并发上限。 */
    agentMaxConcurrency: env.RCS_AGENT_MAX_CONCURRENCY,
    /** 定时任务触发的活跃 Agent 实例并发上限。 */
    scheduledAgentMaxConcurrency: env.RCS_SCHEDULED_AGENT_MAX_CONCURRENCY,
    /** acpx-g workflow engine URL for reverse proxy. */
    acpxGUrl: env.ACPX_G_URL,
    /** RagFlow API base URL (e.g. http://localhost:9380). */
    ragflowApiUrl: process.env.RAGFLOW_API_URL || "http://localhost:9380",
    /** RagFlow API key for authentication. */
    ragflowApiKey: process.env.RAGFLOW_API_KEY || "",
    /** Timeout in milliseconds for RagFlow API requests. */
    ragflowRequestTimeoutMs: parseInt(process.env.RAGFLOW_REQUEST_TIMEOUT_MS || "30000", 10),
    disableSignup: env.RCS_DISABLE_SIGNUP,
    defaultMachineId: env.RCS_DEFAULT_MACHINE_ID,
    defaultEngineType: env.RCS_DEFAULT_ENGINE_TYPE,
    agentSystemPrompt: env.RCS_AGENT_SYSTEM_PROMPT ?? DEFAULT_AGENT_SYSTEM_PROMPT,
    disableLocalExecution: env.RCS_DISABLE_LOCAL_EXECUTION,
  };
}

export type AppConfig = ReturnType<typeof buildConfig>;

/** 可替换的配置实例（测试时覆盖） */
export let config: AppConfig = buildConfig(
  // 延迟解析：config 模块被导入时不自动校验，由 index.ts 显式调用 validateEnv
  {} as Env,
);

/** 测试用：注入自定义配置 */
export function setConfig(overrides: Partial<AppConfig>) {
  config = { ...config, ...overrides } as AppConfig;
}

/** 测试用：恢复默认配置 */
export function resetConfig() {
  // config 初始值会被 applyEnv 覆盖，测试中 resetConfig 只需保持当前状态
}

/** 应用环境变量校验结果到 config */
export function applyEnv(env: Env) {
  config = buildConfig(env);
}

export function getBaseUrl(): string {
  const url = config.baseUrl || `http://localhost:${config.port}`;
  return url.replace(/\/+$/, "");
}
