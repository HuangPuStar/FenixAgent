/**
 * LibreOffice 转换子进程环境白名单测试。
 *
 * 断言白名单产物本身，不真起 LibreOffice 进程：`convertToPdf` 用同一函数构造 `execFile` 的 env。
 */

import { describe, expect, test } from "bun:test";
import {
  buildOfficeConvertEnv,
  OFFICE_CONVERT_ENV_KEYS,
  OFFICE_CONVERT_ENV_PREFIXES,
} from "../server/office-convert-env";

/** 模拟宿主环境：既有转换依赖的基础变量，也有必须拦下的宿主密钥。 */
function hostEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/fenix",
    TMPDIR: "/tmp",
    LC_ALL: "zh_CN.UTF-8",
    DATABASE_URL: "postgres://host/leak",
    RCS_API_KEYS: "host-api-keys",
    RCS_SYSTEM_API_KEYS: "host-system-keys",
    RCS_SECRET_PROVIDER: "host-secret",
    LANGFUSE_SECRET_KEY: "host-langfuse-secret",
  };
}

describe("buildOfficeConvertEnv 环境白名单", () => {
  // 转换进程处理用户上传文档，宿主密钥（数据库连接串、API Key、langfuse secret）绝不能随之外传
  test("拦下宿主密钥", () => {
    const env = buildOfficeConvertEnv(hostEnv());

    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("RCS_API_KEYS");
    expect(env).not.toHaveProperty("RCS_SYSTEM_API_KEYS");
    expect(env).not.toHaveProperty("LANGFUSE_SECRET_KEY");
  });

  // LibreOffice 的启动依赖命令查找（PATH）、用户 profile（HOME）与临时目录，locale 为时间/日期解析基线
  test("保留转换依赖的基础变量与 locale", () => {
    const env = buildOfficeConvertEnv(hostEnv());

    expect(OFFICE_CONVERT_ENV_KEYS).toEqual(expect.arrayContaining(["PATH", "HOME", "TMPDIR"]));
    expect(env).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/home/fenix",
      TMPDIR: "/tmp",
      LC_ALL: "zh_CN.UTF-8",
    });
  });

  // 只放行 locale 前缀：按 RCS_ / LANGFUSE_ 之类前缀放宽会让宿主密钥随下一次改名重新泄漏
  test("不按 RCS_ 或 LANGFUSE_ 前缀放行", () => {
    expect(OFFICE_CONVERT_ENV_PREFIXES).toEqual(["LC_"]);

    const env = buildOfficeConvertEnv({ RCS_SECRET_EXTRA: "declared", LANGFUSE_SECRET_KEY: "host-langfuse-secret" });

    expect(env).not.toHaveProperty("RCS_SECRET_EXTRA");
    expect(env).not.toHaveProperty("LANGFUSE_SECRET_KEY");
  });

  // 未设置的宿主变量不应以 undefined 值出现在子进程环境里
  test("跳过未设置的宿主变量", () => {
    const env = buildOfficeConvertEnv({ PATH: "/usr/bin", HOME: undefined });

    expect(Object.keys(env)).toEqual(["PATH"]);
  });
});
