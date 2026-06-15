import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { applyEnv, config } from "../config";
import type { Env } from "../env";

function makeEnv(skillDir: string): Env {
  return {
    DATABASE_URL: "postgres://u:p@h:5432/db",
    RCS_API_KEYS: "test-key",
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
    RCS_POLL_TIMEOUT: 8,
    RCS_HEARTBEAT_INTERVAL: 20,
    RCS_WS_IDLE_TIMEOUT: 255,
    RCS_WS_KEEPALIVE_INTERVAL: 20,
    RCS_DISCONNECT_TIMEOUT: 120,
    RCS_JWT_EXPIRES_IN: 3600,
    RAGFLOW_API_URL: "http://localhost:9380",
    RAGFLOW_API_KEY: "",
    RAGFLOW_REQUEST_TIMEOUT_MS: 30000,
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
    REGISTRY_SECRET: "",
    ACPX_G_URL: "http://localhost:8848",
    RCS_ENGINE_TYPE: "opencode" as const,
    RCS_CCB_COMMAND: "ccb",
    RCS_CCB_ARGS: "--acp",
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
