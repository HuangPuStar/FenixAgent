/**
 * 子进程环境白名单原语测试（§5.4）。
 *
 * 该原语是 machine 的目录打包与 mcp 的可执行文件探测两条白名单的取值来源：调用方给键集，它只回白名单内
 * 的键，因此「白名单外的宿主变量不会进到子进程」这条断言在平台层就被钉住。
 */

import { describe, expect, test } from "bun:test";
import { pickProcessEnv } from "../subprocess-env";

/** 模拟宿主环境：既有子进程需要的运行前提，也有必须拦下的宿主密钥。 */
function hostEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    TZ: "Asia/Shanghai",
    HOME: "/home/fenix",
    DATABASE_URL: "postgres://host/leak",
    RCS_API_KEYS: "host-api-keys",
    LANGFUSE_SECRET_KEY: "host-langfuse-secret",
  };
}

describe("pickProcessEnv 子进程环境白名单", () => {
  // 只放行调用方点名的键：宿主密钥（数据库连接串、API Key）绝不能随子进程外传
  test("只返回键集内的变量", () => {
    const env = pickProcessEnv(["PATH", "TZ"], hostEnv());

    expect(env).toEqual({ PATH: "/usr/bin:/bin", TZ: "Asia/Shanghai" });
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("RCS_API_KEYS");
    expect(env).not.toHaveProperty("LANGFUSE_SECRET_KEY");
  });

  // 未设置的键不进结果：undefined 值会让 spawn 的环境里出现「存在但为空」的键
  test("跳过未设置的键", () => {
    expect(pickProcessEnv(["PATH", "TZ"], { PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  // 空键集是合法输入：调用方声明「这个子进程不需要任何宿主变量」时应当拿到空环境
  test("空键集返回空环境", () => {
    expect(pickProcessEnv([], hostEnv())).toEqual({});
  });

  // 返回值必须是新对象：共享宿主环境对象会让调用方的写入污染进程环境
  test("返回新对象而非宿主环境本体", () => {
    const base = hostEnv();
    const picked = pickProcessEnv(["PATH"], base);

    expect(picked).not.toBe(base);
  });

  // 默认取值来源是宿主进程环境：省略 base 时读到的是当前进程的取值（每一次调用现取，不缓存）
  test("省略 base 时读取当前进程环境", () => {
    const previous = process.env.FENIX_PICK_PROCESS_ENV_PROBE;
    process.env.FENIX_PICK_PROCESS_ENV_PROBE = "probe-value";
    try {
      expect(pickProcessEnv(["FENIX_PICK_PROCESS_ENV_PROBE"])).toEqual({
        FENIX_PICK_PROCESS_ENV_PROBE: "probe-value",
      });
    } finally {
      if (previous === undefined) delete process.env.FENIX_PICK_PROCESS_ENV_PROBE;
      else process.env.FENIX_PICK_PROCESS_ENV_PROBE = previous;
    }
  });
});
