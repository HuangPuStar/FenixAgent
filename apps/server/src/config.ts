import { resolve } from "node:path";
import { readDeclaredEnv, type ServerEnv } from "./env-loader";

/**
 * 把已校验的 env 投影成宿主运行期配置。
 *
 * 参数取 `ServerEnv`（宿主 schema 字段 + 模块声明的合并结果）而非 `Env`：合并对象里既有宿主声明也有
 * 模块声明的键，收窄回 `Env` 会把「值由谁声明」在类型上抹平（与 `env-loader.ts` 的口径一致）。
 *
 * **模块声明键经 `readDeclaredEnv` 读取**（1.7 C 块，路线 A）：这些键的 schema 已随 `envDefinitions`
 * 迁到各自的 owner 模块，`Env` 类型上不再有它们，只能经统一入口取。本函数仍是「部署值 → 宿主 config」
 * 的手工映射点（路线 A 的窄口径：声明只承担启动期校验与汇总，不引入通用拆分器），下游
 * `bootstrap/module-configs.ts` 与 `services/pre-launch-ports.ts` 继续从本对象读——它们的职责与本批无关。
 *
 * 保留为**宿主自有**的字段（不从 `readDeclaredEnv` 取）有明确理由，不要"顺手统一"：
 * `version` / `port` / `host` / `baseUrl` / `wsMaxPayloadMb` 是宿主自身运行参数；
 * `fileWsIdleTimeoutMs` / `fileWsSweepIntervalMs` / `fileWsSweepEnabled` 由宿主的 file-ws 巡检直接消费
 * （`host-startup.ts` 的 `startFileWsSweep`），machine 模块只读身份绑定与订阅上限两项；
 * `disableSignup` 同时被宿主 `plugins/auth.ts` 消费；
 * `defaultMachineId` / `defaultEngineType` / `disableLocalExecution` 为多模块共享的 Agent 路由类键，
 * 无唯一 owner（见 agent-runtime manifest 的「不迁的兄弟键」）。
 *
 * **1.7 C 块收尾删除了四个零消费者的字段**（`pollTimeout` / `heartbeatInterval` / `wsIdleTimeout` /
 * `disconnectTimeout`，对应 `RCS_POLL_TIMEOUT` / `RCS_HEARTBEAT_INTERVAL` / `RCS_WS_IDLE_TIMEOUT` /
 * `RCS_DISCONNECT_TIMEOUT`）：它们自 WS 层改用 Bun 原生配置后就没有读取点——`RCS_WS_IDLE_TIMEOUT`
 * 从未传给 `Bun.serve` 的 `idleTimeout`（注释曾声称它须高于 `wsKeepaliveInterval * 3`），改了不生效。
 * 现行保活旋钮是模块声明的 `wsKeepaliveInterval`。若要重建一个被运行时层取代的旋钮，先落实它的消费者
 * （例如真的把值接进 `Bun.serve`），不要只留一个声明。
 */
/** 单例占位期的路径兜底：`buildConfig({} as ServerEnv)` 下声明键全为 undefined，而 `resolve()` 对 undefined 会抛 `ERR_INVALID_ARG_TYPE`；给空串只求「不崩且同形」。刻意不用真实默认值兜底——`SKILL_DIR` / `RCS_SYSTEM_ADMIN_PASSWORD_FILE` 的默认值归各自模块 manifest 的 `defaultValue`，在这里再写一份就是第二个来源。 */
const PLACEHOLDER_PATH = "";

function buildConfig(env: ServerEnv) {
  return {
    version: env.RCS_VERSION,
    port: env.RCS_PORT,
    host: env.RCS_HOST,
    baseUrl: env.RCS_BASE_URL,
    skillDir: resolve(readDeclaredEnv<string>(env, "SKILL_DIR") ?? PLACEHOLDER_PATH),
    /** Workspace 根目录，默认运行目录下 workspaces；与 workspace-resolver 的默认值保持一致。 */
    workspaceRoot: resolve(readDeclaredEnv<string | undefined>(env, "WORKSPACE_ROOT") ?? "./workspaces"),
    systemAdminPasswordFile: resolve(
      readDeclaredEnv<string>(env, "RCS_SYSTEM_ADMIN_PASSWORD_FILE") ?? PLACEHOLDER_PATH,
    ),
    modelGatewayCredentialEncryptionKey: readDeclaredEnv<string | undefined>(
      env,
      "RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY",
    ),
    modelGatewayType: readDeclaredEnv<string>(env, "RCS_MODEL_GATEWAY_TYPE"),
    modelGatewayBaseUrl: readDeclaredEnv<string>(env, "RCS_MODEL_GATEWAY_BASE_URL"),
    modelGatewayPublicBaseUrl:
      readDeclaredEnv<string | undefined>(env, "RCS_MODEL_GATEWAY_PUBLIC_BASE_URL") ??
      readDeclaredEnv<string>(env, "RCS_MODEL_GATEWAY_BASE_URL"),
    modelGatewayAdminKey: readDeclaredEnv<string | undefined>(env, "RCS_MODEL_GATEWAY_ADMIN_KEY"),
    modelGatewayAdminUiUrl: readDeclaredEnv<string>(env, "RCS_MODEL_GATEWAY_ADMIN_UI_URL"),
    modelGatewayDefaultUserBudgetUsd: readDeclaredEnv<number | undefined>(
      env,
      "RCS_MODEL_GATEWAY_DEFAULT_USER_BUDGET_USD",
    ),
    modelGatewayDefaultBudgetDuration: readDeclaredEnv<string | undefined>(
      env,
      "RCS_MODEL_GATEWAY_DEFAULT_BUDGET_DURATION",
    ),
    /** 单条 WebSocket 消息最大大小（MB），由 Bun 配置入口转换为字节。 */
    wsMaxPayloadMb: env.RCS_WS_MAX_PAYLOAD_MB,
    /** Server→client keep_alive data-frame interval (seconds). Keeps reverse
     *  proxies from closing idle connections. Default 20s. */
    wsKeepaliveInterval: readDeclaredEnv<number>(env, "RCS_WS_KEEPALIVE_INTERVAL"),
    /** Idle timeout in seconds before an unobserved non-interactive ACP instance is auto-stopped. */
    acpIdleTimeoutSeconds: readDeclaredEnv<number>(env, "RCS_ACP_IDLE_TIMEOUT_SECONDS"),
    /** Sweep interval in seconds for non-interactive ACP instance cleanup. */
    acpIdleSweepIntervalSeconds: readDeclaredEnv<number>(env, "RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS"),
    /** Hard timeout in seconds for no ACP business activity on non-interactive instances. */
    acpActivityTimeoutSeconds: readDeclaredEnv<number>(env, "RCS_ACP_ACTIVITY_TIMEOUT_SECONDS"),
    /** 全部活跃 Agent 实例的并发上限。 */
    agentMaxConcurrency: readDeclaredEnv<number | undefined>(env, "RCS_AGENT_MAX_CONCURRENCY"),
    /** 单个用户活跃 Agent 实例的并发上限。 */
    userAgentMaxConcurrency: readDeclaredEnv<number>(env, "RCS_USER_AGENT_MAX_CONCURRENCY"),
    /** 定时任务触发的活跃 Agent 实例并发上限。 */
    scheduledAgentMaxConcurrency: readDeclaredEnv<number | undefined>(env, "RCS_SCHEDULED_AGENT_MAX_CONCURRENCY"),
    /** file-ws 僵尸判定阈值：lastClientActivity 距今超过该值（ms）视为僵尸连接。默认 90s（3×30s keep_alive 间隔）。 */
    fileWsIdleTimeoutMs: env.RCS_FILE_WS_IDLE_TIMEOUT_MS,
    /** file-ws 僵尸巡检间隔（ms）。默认 30s。 */
    fileWsSweepIntervalMs: env.RCS_FILE_WS_SWEEP_INTERVAL_MS,
    /** file-ws 巡检开关。默认 false：旧机器端 keep_alive 缺失或间隔 >90s 会被误判，灰度开启防误杀。 */
    fileWsSweepEnabled: env.RCS_FILE_WS_SWEEP_ENABLED,
    /** file-ws 身份绑定严格模式（§7.1）。默认 false（宽松）：未知 machine 放行 + 告警；true 时 close(4404)。两阶段过渡软开关。 */
    fileWsIdentityStrict: readDeclaredEnv<boolean>(env, "RCS_FILE_WS_IDENTITY_STRICT"),
    /** `/web/file-events` 文件变更事件订阅的并发连接上限；与 YJS 分池，不挤占同一配额。 */
    fileEventsMaxClients: readDeclaredEnv<number>(env, "RCS_FILE_EVENTS_MAX_CLIENTS"),
    /** 沙盒创建或恢复后等待 ACP Runtime 回连的最长时间（毫秒）。 */
    sandboxRuntimeConnectTimeoutMs:
      readDeclaredEnv<number | undefined>(env, "RCS_SANDBOX_RUNTIME_CONNECT_TIMEOUT_MS") ?? 10000,
    /** 是否启用沙盒默认策略。 */
    sandboxEnabled: readDeclaredEnv<boolean>(env, "RCS_SANDBOX_ENABLED"),
    /** 未显式指定运行节点时使用的默认沙盒资源池 ID。 */
    defaultSandboxPoolId: readDeclaredEnv<string | undefined>(env, "RCS_DEFAULT_SANDBOX_POOL_ID"),
    /** 默认沙盒镜像名称。 */
    defaultSandboxImage: readDeclaredEnv<string | undefined>(env, "RCS_DEFAULT_SANDBOX_IMAGE"),
    /** 默认沙盒 Agent 类型，写入默认 Pool 并用于生成 Sandbox Machine 身份。 */
    defaultSandboxAgentType: readDeclaredEnv<string>(env, "RCS_DEFAULT_SANDBOX_AGENT_TYPE"),
    /** 默认沙盒资源配置 JSON，包括环境变量和挂载。 */
    defaultSandboxResourcesJson: readDeclaredEnv<string | undefined>(env, "RCS_DEFAULT_SANDBOX_RESOURCES_JSON"),
    /** Provider 专属的默认配置 JSON。 */
    defaultSandboxExtraJson: readDeclaredEnv<string | undefined>(env, "RCS_DEFAULT_SANDBOX_EXTRA_JSON"),
    /** OpenSandbox Cluster 服务地址。 */
    openSandboxClusterUrl: readDeclaredEnv<string | undefined>(env, "RCS_SANDBOX_CLUSTER_URL"),
    /** 调用 OpenSandbox Cluster 使用的 API Key。 */
    openSandboxClusterApiKey: readDeclaredEnv<string | undefined>(env, "RCS_SANDBOX_CLUSTER_API_KEY"),
    /** Provider 普通请求的超时时间（毫秒）。 */
    sandboxProviderRequestTimeoutMs:
      readDeclaredEnv<number | undefined>(env, "RCS_SANDBOX_PROVIDER_REQUEST_TIMEOUT_MS") ?? 10000,
    /** Provider 创建沙盒的超时时间（毫秒）。 */
    sandboxProviderCreateTimeoutMs:
      readDeclaredEnv<number | undefined>(env, "RCS_SANDBOX_PROVIDER_CREATE_TIMEOUT_MS") ?? 120000,
    /** Provider 恢复沙盒的超时时间（毫秒）。 */
    sandboxProviderResumeTimeoutMs:
      readDeclaredEnv<number | undefined>(env, "RCS_SANDBOX_PROVIDER_RESUME_TIMEOUT_MS") ?? 60000,
    /** Provider 删除沙盒的超时时间（毫秒）。 */
    sandboxProviderDestroyTimeoutMs:
      readDeclaredEnv<number | undefined>(env, "RCS_SANDBOX_PROVIDER_DESTROY_TIMEOUT_MS") ?? 60000,
    /** acpx-g workflow engine URL for reverse proxy. */
    acpxGUrl: readDeclaredEnv<string>(env, "ACPX_G_URL"),
    // ── RagFlow 三项 ──
    // 键的 schema 归 knowledge 模块声明（1.7 C 块），经 `readDeclaredEnv` 取已校验值。两个地址类键在声明侧
    // 用 `z.preprocess` 把空串归一为 undefined（对齐迁移前 `process.env.X || 默认值` 的语义），因此这里
    // 只会拿到默认地址或显式配置值，不存在空串分支。
    /** RagFlow API base URL (e.g. http://localhost:9380). */
    ragflowApiUrl: readDeclaredEnv<string>(env, "RAGFLOW_API_URL"),
    /** RagFlow API key for authentication. */
    ragflowApiKey: readDeclaredEnv<string>(env, "RAGFLOW_API_KEY"),
    /** Timeout in milliseconds for RagFlow API requests. */
    ragflowRequestTimeoutMs: readDeclaredEnv<number>(env, "RAGFLOW_REQUEST_TIMEOUT_MS"),
    /**
     * Gotenberg（文档转 PDF）服务地址，Knowledge 模块的文档导入使用。
     *
     * 键的 schema 归 knowledge 模块声明（1.7 C 块「只迁有唯一模块 owner 的键」），声明侧用 `z.preprocess`
     * 把空串归一为 undefined 并由 `.default()` 补上迁移前的默认地址，因此这里与上面三项同一形态。
     */
    gotenbergUrl: readDeclaredEnv<string>(env, "GOTENBERG_URL"),
    disableSignup: env.RCS_DISABLE_SIGNUP,
    defaultMachineId: env.RCS_DEFAULT_MACHINE_ID,
    defaultEngineType: env.RCS_DEFAULT_ENGINE_TYPE,
    agentSystemPrompt: readDeclaredEnv<string>(env, "RCS_AGENT_SYSTEM_PROMPT"),
    disableLocalExecution: env.RCS_DISABLE_LOCAL_EXECUTION,
    /** Langfuse 观测透传（归 agent-config 声明，经本对象的 `langfuse*` 交给 launchSpec.env 派发到 machine 上 agent 进程）。 */
    langfusePublicKey: readDeclaredEnv<string | undefined>(env, "LANGFUSE_PUBLIC_KEY"),
    langfuseSecretKey: readDeclaredEnv<string | undefined>(env, "LANGFUSE_SECRET_KEY"),
    langfuseBaseUrl: readDeclaredEnv<string | undefined>(env, "LANGFUSE_BASE_URL"),
  };
}

export type AppConfig = ReturnType<typeof buildConfig>;

/** 可替换的配置实例（测试时覆盖） */
export let config: AppConfig = buildConfig(
  // 延迟解析：config 模块被导入时不自动校验，由 main.ts 显式调用 resolveAssemblyEnv → validateEnv
  // （`ServerEnv` 的交集类型让空对象断言合法；此处只求「构造出同形配置」，字段值在 applyEnv 时被整体替换）。
  {} as ServerEnv,
);

/** 测试用：注入自定义配置 */
export function setConfig(overrides: Partial<AppConfig>) {
  config = { ...config, ...overrides } as AppConfig;
}

/** 测试用：恢复默认配置 */
export function resetConfig() {
  // config 初始值会被 applyEnv 覆盖，测试中 resetConfig 只需保持当前状态
}

/**
 * 应用环境变量校验结果到 config。
 *
 * 参数类型与 `buildConfig` 一致地取 `ServerEnv`：`main.ts` 的调用点传的正是 `resolveAssemblyEnv()`
 * 返回的合并对象，收窄成 `Env` 只会逼调用点做一次无意义的断言。
 */
export function applyEnv(env: ServerEnv) {
  config = buildConfig(env);
}

export function getBaseUrl(): string {
  const url = config.baseUrl || `http://localhost:${config.port}`;
  return url.replace(/\/+$/, "");
}
