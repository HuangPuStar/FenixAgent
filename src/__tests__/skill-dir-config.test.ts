import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { applyEnv, config } from "../config";
import type { Env } from "../env";

function makeEnv(skillDir: string): Env {
  return {
    DATABASE_URL: "postgres://u:p@h:5432/db",
    RCS_API_KEYS: "test-key",
    RCS_MODEL_GATEWAY_TYPE: "litellm",
    RCS_MODEL_GATEWAY_BASE_URL: "http://localhost:4000",
    RCS_MODEL_GATEWAY_PUBLIC_BASE_URL: undefined,
    RCS_MODEL_GATEWAY_ADMIN_UI_URL: "http://localhost:4000/ui/",
    RCS_MODEL_GATEWAY_CREDENTIAL_RECONCILE_CRON: "0 3 * * *",
    RCS_MODEL_GATEWAY_CREDENTIAL_RECONCILE_TIMEZONE: "Asia/Shanghai",
    NODE_ENV: "test",
    RCS_HOST: "0.0.0.0",
    RCS_PORT: 3000,
    RCS_CORS_ORIGIN: "*",
    RCS_TRUSTED_ORIGINS: "",
    RCS_BASE_URL: "",
    RCS_VERSION: "0.1.0",
    SKILL_DIR: skillDir,
    RCS_SYSTEM_ADMIN_PASSWORD_FILE: "./data/password.txt",
    APP_BRAND_NAME: "Fenix",
    APP_LOGO_PATH: "",
    APP_HIDDEN_SIDEBAR_TABS: "",
    RCS_POLL_TIMEOUT: 8,
    RCS_HEARTBEAT_INTERVAL: 20,
    RCS_WS_IDLE_TIMEOUT: 255,
    RCS_WS_KEEPALIVE_INTERVAL: 20,
    RCS_WS_MAX_PAYLOAD_MB: 128,
    RCS_DISCONNECT_TIMEOUT: 120,
    RCS_ACP_IDLE_TIMEOUT_SECONDS: 1200,
    RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS: 60,
    RCS_ACP_ACTIVITY_TIMEOUT_SECONDS: 3600,
    RCS_FILE_WS_IDLE_TIMEOUT_MS: 90000,
    RCS_FILE_WS_SWEEP_INTERVAL_MS: 30000,
    RCS_FILE_WS_SWEEP_ENABLED: false,
    RCS_FILE_WS_MAX_PAYLOAD_MB: 32,
    RCS_FILE_WS_IDENTITY_STRICT: false,
    RCS_FILE_EVENTS_MAX_CLIENTS: 200,
    RCS_SANDBOX_ENABLED: false,
    RCS_DEFAULT_SANDBOX_AGENT_TYPE: "opencode",
    RCS_USER_AGENT_MAX_CONCURRENCY: 10,
    RCS_ENVIRONMENT_MAX_SESSIONS: 5,
    RAGFLOW_API_URL: "http://localhost:9380",
    RAGFLOW_API_KEY: "",
    RAGFLOW_REQUEST_TIMEOUT_MS: 30000,
    RCS_DISABLE_SIGNUP: false,
    RCS_DISABLE_LOCAL_EXECUTION: false,
    REGISTRY_SECRET: "",
    ACPX_G_URL: "http://localhost:8848",
    RCS_AGENT_SYSTEM_PROMPT: "你是 FENIXAGENT。\n你当前的 Agent 名称是「{{agentName}}」。\n{{userPrompt}}",
    RCS_CCB_COMMAND: "ccb",
    RCS_CCB_ARGS: "--acp",
    WORKFLOW_TOOLS_DIR: "./tools",
    // YJS 快照持久化默认值（与 src/env.ts schema 默认一致）
    RCS_YJS_SNAPSHOT_INTERVAL_MS: 2000,
    RCS_YJS_SNAPSHOT_IDLE_MS: 500,
    RCS_YJS_SNAPSHOT_TTL_SECONDS: 604800,
  };
}

describe("skill dir config", () => {
  // 绝对 SKILL_DIR 会原样规范化为服务端配置目录。
  test("absolute SKILL_DIR is exposed on config", () => {
    applyEnv(makeEnv("/tmp/rcs-skills"));
    expect(config.skillDir).toBe("/tmp/rcs-skills");
  });

  // 相对 SKILL_DIR 按当前服务进程工作目录解析。
  test("relative SKILL_DIR is resolved from cwd", () => {
    applyEnv(makeEnv("./tmp-skills"));
    expect(config.skillDir).toBe(resolve("./tmp-skills"));
  });
});

describe("model gateway endpoint config", () => {
  // 未配置 Agent 公开地址时，Provider 地址回退为管理地址。
  test("public model gateway URL falls back to management URL", () => {
    applyEnv(makeEnv("/tmp/rcs-skills"));
    expect(config.modelGatewayPublicBaseUrl).toBe("http://localhost:4000");
  });

  // 公开地址配置后，Fenix 管理调用地址保持独立。
  test("public model gateway URL can be configured independently", () => {
    applyEnv({ ...makeEnv("/tmp/rcs-skills"), RCS_MODEL_GATEWAY_PUBLIC_BASE_URL: "http://host.docker.internal:4000" });
    expect(config.modelGatewayBaseUrl).toBe("http://localhost:4000");
    expect(config.modelGatewayPublicBaseUrl).toBe("http://host.docker.internal:4000");
  });
});
