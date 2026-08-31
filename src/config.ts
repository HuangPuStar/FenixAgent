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
    /** Workspace 根目录，默认运行目录下 workspaces；与 workspace-resolver 的默认值保持一致。 */
    workspaceRoot: resolve(env.WORKSPACE_ROOT ?? "./workspaces"),
    systemAdminPasswordFile: resolve(env.RCS_SYSTEM_ADMIN_PASSWORD_FILE ?? "./data/password.txt"),
    modelGatewayCredentialEncryptionKey: env.RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY,
    modelGatewayType: env.RCS_MODEL_GATEWAY_TYPE,
    modelGatewayBaseUrl: env.RCS_MODEL_GATEWAY_BASE_URL,
    modelGatewayPublicBaseUrl: env.RCS_MODEL_GATEWAY_PUBLIC_BASE_URL ?? env.RCS_MODEL_GATEWAY_BASE_URL,
    modelGatewayAdminKey: env.RCS_MODEL_GATEWAY_ADMIN_KEY,
    modelGatewayAdminUiUrl: env.RCS_MODEL_GATEWAY_ADMIN_UI_URL,
    modelGatewayDefaultUserBudgetUsd: env.RCS_MODEL_GATEWAY_DEFAULT_USER_BUDGET_USD,
    modelGatewayDefaultBudgetDuration: env.RCS_MODEL_GATEWAY_DEFAULT_BUDGET_DURATION,
    modelGatewayCredentialReconcileCron: env.RCS_MODEL_GATEWAY_CREDENTIAL_RECONCILE_CRON,
    modelGatewayCredentialReconcileTimezone: env.RCS_MODEL_GATEWAY_CREDENTIAL_RECONCILE_TIMEZONE,
    pollTimeout: env.RCS_POLL_TIMEOUT,
    heartbeatInterval: env.RCS_HEARTBEAT_INTERVAL,
    /** Bun WebSocket idle timeout (seconds). Bun sends protocol-level pings after
     *  this many seconds of no received data. Set higher than
     *  wsKeepaliveInterval * 3 so that application-level keepalive detects dead
     *  connections before Bun closes them. Default 255s (Bun's built-in default). */
    wsIdleTimeout: env.RCS_WS_IDLE_TIMEOUT,
    /** 单条 WebSocket 消息最大大小（MB），由 Bun 配置入口转换为字节。 */
    wsMaxPayloadMb: env.RCS_WS_MAX_PAYLOAD_MB,
    /** Server→client keep_alive data-frame interval (seconds). Keeps reverse
     *  proxies from closing idle connections. Default 20s. */
    wsKeepaliveInterval: env.RCS_WS_KEEPALIVE_INTERVAL,
    /** Disconnect timeout (seconds). Environments/sessions with no activity for
     *  this long are considered disconnected. Default 120s. */
    disconnectTimeout: env.RCS_DISCONNECT_TIMEOUT,
    /** Idle timeout in seconds before an unobserved non-interactive ACP instance is auto-stopped. */
    acpIdleTimeoutSeconds: env.RCS_ACP_IDLE_TIMEOUT_SECONDS,
    /** Sweep interval in seconds for non-interactive ACP instance cleanup. */
    acpIdleSweepIntervalSeconds: env.RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS,
    /** Hard timeout in seconds for no ACP business activity on non-interactive instances. */
    acpActivityTimeoutSeconds: env.RCS_ACP_ACTIVITY_TIMEOUT_SECONDS,
    /** 全部活跃 Agent 实例的并发上限。 */
    agentMaxConcurrency: env.RCS_AGENT_MAX_CONCURRENCY,
    /** 单个用户活跃 Agent 实例的并发上限。 */
    userAgentMaxConcurrency: env.RCS_USER_AGENT_MAX_CONCURRENCY,
    /** 定时任务触发的活跃 Agent 实例并发上限。 */
    scheduledAgentMaxConcurrency: env.RCS_SCHEDULED_AGENT_MAX_CONCURRENCY,
    /** file-ws 僵尸判定阈值：lastClientActivity 距今超过该值（ms）视为僵尸连接。默认 90s（3×30s keep_alive 间隔）。 */
    fileWsIdleTimeoutMs: env.RCS_FILE_WS_IDLE_TIMEOUT_MS,
    /** file-ws 僵尸巡检间隔（ms）。默认 30s。 */
    fileWsSweepIntervalMs: env.RCS_FILE_WS_SWEEP_INTERVAL_MS,
    /** file-ws 巡检开关。默认 false：旧机器端 keep_alive 缺失或间隔 >90s 会被误判，灰度开启防误杀。 */
    fileWsSweepEnabled: env.RCS_FILE_WS_SWEEP_ENABLED,
    /** file-ws 身份绑定严格模式（§7.1）。默认 false（宽松）：未知 machine 放行 + 告警；true 时 close(4404)。两阶段过渡软开关。 */
    fileWsIdentityStrict: env.RCS_FILE_WS_IDENTITY_STRICT,
    /** 沙盒创建或恢复后等待 ACP Runtime 回连的最长时间（毫秒）。 */
    sandboxRuntimeConnectTimeoutMs: env.RCS_SANDBOX_RUNTIME_CONNECT_TIMEOUT_MS ?? 10000,
    /** 是否启用沙盒默认策略。 */
    sandboxEnabled: env.RCS_SANDBOX_ENABLED,
    /** 未显式指定运行节点时使用的默认沙盒资源池 ID。 */
    defaultSandboxPoolId: env.RCS_DEFAULT_SANDBOX_POOL_ID,
    /** 默认沙盒镜像名称。 */
    defaultSandboxImage: env.RCS_DEFAULT_SANDBOX_IMAGE,
    /** 默认沙盒 Agent 类型，写入默认 Pool 并用于生成 Sandbox Machine 身份。 */
    defaultSandboxAgentType: env.RCS_DEFAULT_SANDBOX_AGENT_TYPE,
    /** 默认沙盒资源配置 JSON，包括环境变量和挂载。 */
    defaultSandboxResourcesJson: env.RCS_DEFAULT_SANDBOX_RESOURCES_JSON,
    /** Provider 专属的默认配置 JSON。 */
    defaultSandboxExtraJson: env.RCS_DEFAULT_SANDBOX_EXTRA_JSON,
    /** OpenSandbox Cluster 服务地址。 */
    openSandboxClusterUrl: env.RCS_SANDBOX_CLUSTER_URL,
    /** 调用 OpenSandbox Cluster 使用的 API Key。 */
    openSandboxClusterApiKey: env.RCS_SANDBOX_CLUSTER_API_KEY,
    /** Provider 普通请求的超时时间（毫秒）。 */
    sandboxProviderRequestTimeoutMs: env.RCS_SANDBOX_PROVIDER_REQUEST_TIMEOUT_MS ?? 10000,
    /** Provider 创建沙盒的超时时间（毫秒）。 */
    sandboxProviderCreateTimeoutMs: env.RCS_SANDBOX_PROVIDER_CREATE_TIMEOUT_MS ?? 120000,
    /** Provider 恢复沙盒的超时时间（毫秒）。 */
    sandboxProviderResumeTimeoutMs: env.RCS_SANDBOX_PROVIDER_RESUME_TIMEOUT_MS ?? 60000,
    /** Provider 删除沙盒的超时时间（毫秒）。 */
    sandboxProviderDestroyTimeoutMs: env.RCS_SANDBOX_PROVIDER_DESTROY_TIMEOUT_MS ?? 60000,
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
    /** Langfuse 观测透传（env.ts 声明，经 launchSpec.env 统一派发到 machine 上 agent 进程）。 */
    langfusePublicKey: env.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: env.LANGFUSE_SECRET_KEY,
    langfuseBaseUrl: env.LANGFUSE_BASE_URL,
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
