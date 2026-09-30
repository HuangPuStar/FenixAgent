/**
 * MCP 本地服务器可执行文件探测（`which`）子进程环境白名单测试（F3）。
 *
 * 断言白名单产物本身，并用一次真实 `which` 调用证明白名单「够用」：`Bun.spawn` 的 `env` 是替换语义，
 * 漏掉 `PATH` 不会报错，只会让所有配置探测静默变成「命令未找到」。
 */

import { describe, expect, test } from "bun:test";
import { buildCommandProbeEnv, COMMAND_PROBE_ENV_KEYS } from "../server/services/command-probe-env";

/** 模拟宿主环境：既有探测依赖的基础变量，也有必须拦下的宿主密钥。 */
function hostEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/fenix",
    DATABASE_URL: "postgres://host/leak",
    RCS_API_KEYS: "host-api-keys",
    LANGFUSE_SECRET_KEY: "host-langfuse-secret",
  };
}

describe("buildCommandProbeEnv 环境白名单", () => {
  // 探测命令来自管理端提交的 MCP 配置，宿主密钥（数据库连接串、API Key）绝不能随之外传
  test("拦下宿主密钥", () => {
    const env = buildCommandProbeEnv(hostEnv());

    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("RCS_API_KEYS");
    expect(env).not.toHaveProperty("LANGFUSE_SECRET_KEY");
  });

  // which 的全部价值就是按 PATH 搜索；只需 PATH，不需要 HOME 等用户级变量
  test("只保留命令查找依赖的 PATH", () => {
    expect(COMMAND_PROBE_ENV_KEYS).toEqual(["PATH"]);

    expect(buildCommandProbeEnv(hostEnv())).toEqual({ PATH: "/usr/bin:/bin" });
  });

  // 未设置的宿主变量不应以 undefined 值出现在子进程环境里
  test("跳过未设置的宿主变量", () => {
    const env = buildCommandProbeEnv({ PATH: undefined, HOME: "/home/fenix" });

    expect(Object.keys(env)).toEqual([]);
  });

  // 返回值必须是新对象：共享宿主环境对象会让后续写入污染进程环境
  test("返回新对象而非宿主环境本体", () => {
    const base = hostEnv();

    expect(buildCommandProbeEnv(base)).not.toBe(base);
  });

  // 白名单必须够用：只有 PATH 的真 which 仍能命中已安装命令（缺 PATH 时命中一律为假，配置探测整体退化）
  test("白名单足以让真实 which 命中命令", async () => {
    const found = Bun.spawn(["which", "sh"], { env: buildCommandProbeEnv(), stdout: "pipe", stderr: "pipe" });
    await found.exited;

    const missing = Bun.spawn(["which", "fenix-no-such-command"], {
      env: buildCommandProbeEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    await missing.exited;

    expect(found.exitCode).toBe(0);
    expect(missing.exitCode).toBe(1);
  });
});
