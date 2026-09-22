import { describe, expect, test } from "bun:test";
import { applyEnv, config } from "@server/config";
import { parseEnv } from "@server/env";

describe("system admin password file config", () => {
  // 系统 admin 的密码文件路径必须独立配置，不能和 skillDir 的语义耦合。
  //
  // 宿主键由 `parseEnv` 提供真实默认值，只有本用例关心的声明键（`RCS_SYSTEM_ADMIN_PASSWORD_FILE` 自 1.7 C 块
  // 起归 identity 模块声明）显式给出——手写整份 env 快照会让本用例在每次 schema 调整时被迫跟着改。
  test("applies RCS_SYSTEM_ADMIN_PASSWORD_FILE into runtime config", () => {
    applyEnv({
      ...parseEnv({ DATABASE_URL: "postgres://test", RCS_API_KEYS: "secret", NODE_ENV: "test" }),
      RCS_SYSTEM_ADMIN_PASSWORD_FILE: "./data/custom-password.txt",
    });

    expect(config.systemAdminPasswordFile.endsWith("data/custom-password.txt")).toBe(true);
  });
});
