import type { Env } from "./env";

function buildConfig(env: Env) {
  return {
    version: env.RCS_VERSION,
    port: env.RCS_PORT,
    host: env.RCS_HOST,
    baseUrl: env.RCS_BASE_URL,
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
    /** JWT expiration time in seconds for worker tokens. Default 3600s (1 hour). */
    jwtExpiresIn: env.RCS_JWT_EXPIRES_IN,
    /** acpx-g workflow engine URL for reverse proxy. */
    acpxGUrl: env.ACPX_G_URL,
    /** Knowledge provider selection. Phase 1 supports OpenViking only. */
    knowledgeProvider: env.RCS_KNOWLEDGE_PROVIDER,
    /** Knowledge provider HTTP base URL. */
    knowledgeBaseUrl: env.RCS_KNOWLEDGE_BASE_URL,
    /** Optional shared API key for the knowledge provider. */
    knowledgeApiKey: env.RCS_KNOWLEDGE_API_KEY,
    /** Timeout in milliseconds for knowledge provider requests. */
    knowledgeRequestTimeoutMs: env.RCS_KNOWLEDGE_REQUEST_TIMEOUT_MS,
    /** S3-compatible object storage (RustFS / MinIO / AWS S3). */
    s3: {
      enabled: env.RCS_S3_ENABLED,
      endpoint: env.RCS_S3_ENDPOINT,
      region: env.RCS_S3_REGION,
      accessKey: env.RCS_S3_ACCESS_KEY,
      secretKey: env.RCS_S3_SECRET_KEY,
      bucketSessions: env.RCS_S3_BUCKET_SESSIONS,
      bucketAssets: env.RCS_S3_BUCKET_ASSETS,
      presignExpires: env.RCS_S3_PRESIGN_EXPIRES,
      presignUploadExpires: env.RCS_S3_PRESIGN_UPLOAD_EXPIRES,
    },
    disableSignup: env.RCS_DISABLE_SIGNUP,
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
  config = { ...config, ...overrides, s3: { ...config.s3, ...overrides.s3 } } as AppConfig;
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
