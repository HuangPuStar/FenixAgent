import { describe, expect, test } from "bun:test";
import { applyEnv, config } from "../config";
import type { Env } from "../env";

describe("system admin password file config", () => {
  // 系统 admin 的密码文件路径必须独立配置，不能和 skillDir 的语义耦合。
  test("applies RCS_SYSTEM_ADMIN_PASSWORD_FILE into runtime config", () => {
    applyEnv({
      DATABASE_URL: "postgres://test",
      RCS_API_KEYS: "secret",
      NODE_ENV: "test",
      RCS_HOST: "0.0.0.0",
      RCS_PORT: 3000,
      RCS_CORS_ORIGIN: "*",
      RCS_TRUSTED_ORIGINS: "",
      RCS_BASE_URL: "",
      RCS_VERSION: "0.1.0",
      SKILL_DIR: "./data/skills",
      RCS_SYSTEM_ADMIN_PASSWORD_FILE: "./data/custom-password.txt",
      APP_BRAND_NAME: "Fenix",
      APP_LOGO_PATH: "",
      RCS_POLL_TIMEOUT: 8,
      RCS_HEARTBEAT_INTERVAL: 20,
      RCS_WS_IDLE_TIMEOUT: 255,
      RCS_WS_KEEPALIVE_INTERVAL: 20,
      RCS_DISCONNECT_TIMEOUT: 120,
      RCS_JWT_EXPIRES_IN: 3600,
      RCS_KNOWLEDGE_PROVIDER: "openviking",
      RCS_KNOWLEDGE_BASE_URL: "http://localhost:8090",
      RCS_KNOWLEDGE_API_KEY: "",
      RCS_KNOWLEDGE_REQUEST_TIMEOUT_MS: 15000,
      RCS_S3_ENABLED: false,
      RCS_S3_ENDPOINT: "http://localhost:9000",
      RCS_S3_REGION: "us-east-1",
      RCS_S3_ACCESS_KEY: "",
      RCS_S3_SECRET_KEY: "",
      RCS_S3_BUCKET_SESSIONS: "rcs-sessions",
      RCS_S3_BUCKET_ASSETS: "rcs-assets",
      RCS_S3_PRESIGN_EXPIRES: 3600,
      RCS_S3_PRESIGN_UPLOAD_EXPIRES: 600,
      RCS_DISABLE_SIGNUP: false,
      REGISTRY_SECRET: "rcs-registry-secret",
      ACPX_G_URL: "http://localhost:8848",
      RCS_ENGINE_TYPE: "opencode",
      RCS_CCB_COMMAND: "ccb",
      RCS_CCB_ARGS: "--acp",
    } as Env);

    expect(config.systemAdminPasswordFile.endsWith("data/custom-password.txt")).toBe(true);
  });
});
