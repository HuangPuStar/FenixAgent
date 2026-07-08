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
      RAGFLOW_API_URL: "http://localhost:9380",
      RAGFLOW_API_KEY: "",
      RAGFLOW_REQUEST_TIMEOUT_MS: 30000,
      RCS_DISABLE_SIGNUP: false,
      REGISTRY_SECRET: "rcs-registry-secret",
      ACPX_G_URL: "http://localhost:8848",
      RCS_CCB_COMMAND: "ccb",
      RCS_CCB_ARGS: "--acp",
    } as Env);

    expect(config.systemAdminPasswordFile.endsWith("data/custom-password.txt")).toBe(true);
  });
});
