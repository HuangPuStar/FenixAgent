/**
 * downloadZip 打包子进程环境白名单测试。
 *
 * 断言白名单产物本身（不真起 zip）：`LocalBackend.downloadZip` 用同一函数构造 `spawn("zip")` 的 env。
 * 端到端断言（假 zip 把自己的 process.env 落盘）见 `fs-download-zip.test.ts`。
 */

import { describe, expect, test } from "bun:test";
import { buildDownloadZipEnv, DOWNLOAD_ZIP_ENV_KEYS } from "../services/download-zip-env";

/** 模拟宿主环境：既有打包依赖的基础变量，也有必须拦下的宿主密钥与会被 zip 当选项的变量。 */
function hostEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    TZ: "Asia/Shanghai",
    HOME: "/home/fenix",
    TMPDIR: "/tmp",
    DATABASE_URL: "postgres://host/leak",
    RCS_API_KEYS: "host-api-keys",
    RCS_SECRET_PROVIDER: "host-secret",
    LANGFUSE_SECRET_KEY: "host-langfuse-secret",
    ZIPOPT: "-X",
    ZIP: "-X",
  };
}

describe("buildDownloadZipEnv 环境白名单", () => {
  // 打包由用户工作区内容驱动，宿主密钥（数据库连接串、API Key、langfuse secret）绝不能随之外传
  test("拦下宿主密钥", () => {
    const env = buildDownloadZipEnv(hostEnv());

    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("RCS_API_KEYS");
    expect(env).not.toHaveProperty("RCS_SECRET_PROVIDER");
    expect(env).not.toHaveProperty("LANGFUSE_SECRET_KEY");
  });

  // zip 会把 ZIPOPT/ZIP 的内容插入命令行（man zip 的 ENVIRONMENT），继承等于让宿主改写命令参数
  test("不放行会被 zip 当命令行选项读的变量", () => {
    const env = buildDownloadZipEnv(hostEnv());

    expect(env).not.toHaveProperty("ZIPOPT");
    expect(env).not.toHaveProperty("ZIP");
  });

  // PATH 是 spawn("zip") 命令查找的前提（缺了直接 ENOENT → 503），TZ 决定归档内 DOS 时间戳
  test("只保留命令查找与时间戳依赖的变量", () => {
    expect(DOWNLOAD_ZIP_ENV_KEYS).toEqual(["PATH", "TZ"]);

    expect(buildDownloadZipEnv(hostEnv())).toEqual({ PATH: "/usr/bin:/bin", TZ: "Asia/Shanghai" });
  });

  // 未设置的宿主变量不应以 undefined 值出现在子进程环境里
  test("跳过未设置的宿主变量", () => {
    const env = buildDownloadZipEnv({ PATH: "/usr/bin", TZ: undefined });

    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  // 返回值必须是新对象：共享宿主环境对象会让后续写入污染进程环境
  test("返回新对象而非宿主环境本体", () => {
    const base = hostEnv();

    expect(buildDownloadZipEnv(base)).not.toBe(base);
  });
});
