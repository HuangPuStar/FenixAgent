import { describe, expect, test } from "bun:test";
import { AGENT_PROCESS_ENV_KEYS, AGENT_PROCESS_ENV_PREFIXES, buildAgentProcessEnv } from "../spawn-env";

/** 模拟宿主环境：既有必需的基础变量，也有必须拦下的宿主密钥。 */
function hostEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    LC_ALL: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    DATABASE_URL: "postgres://host/db",
    RCS_API_KEYS: "host-api-keys",
    RCS_SYSTEM_API_KEYS: "host-system-keys",
    RCS_SECRET_PROVIDER: "host-secret",
    LANGFUSE_SECRET_KEY: "host-langfuse-secret",
    ANTHROPIC_API_KEY: "host-model-key",
  };
}

describe("buildAgentProcessEnv 环境白名单", () => {
  // 宿主密钥（数据库连接串、API Key、langfuse secret）绝不能随子进程外传。
  test("拦下宿主密钥", () => {
    const env = buildAgentProcessEnv(undefined, hostEnv());

    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("RCS_API_KEYS");
    expect(env).not.toHaveProperty("RCS_SYSTEM_API_KEYS");
    expect(env).not.toHaveProperty("LANGFUSE_SECRET_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  // RCS_* 与 ANTHROPIC_* 不做前缀放行：按前缀放宽会让宿主密钥随下一次改名重新泄漏。
  test("不按 RCS_ 或 ANTHROPIC_ 前缀放行", () => {
    expect(AGENT_PROCESS_ENV_PREFIXES).toEqual(["LC_"]);
    const env = buildAgentProcessEnv({ RCS_SECRET_EXTRA: "declared" }, hostEnv());

    expect(env).toMatchObject({ RCS_SECRET_EXTRA: "declared" });
    expect(env).not.toHaveProperty("RCS_SECRET_PROVIDER");
  });

  // Agent CLI 启动依赖的基础变量（命令查找、用户目录、locale）必须保留。
  test("保留基础变量与 locale 前缀", () => {
    const env = buildAgentProcessEnv(undefined, hostEnv());

    expect(AGENT_PROCESS_ENV_KEYS).toEqual(expect.arrayContaining(["PATH", "HOME", "TERM"]));
    expect(env).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/home/agent",
      LC_ALL: "zh_CN.UTF-8",
      TERM: "xterm-256color",
    });
  });

  // launchSpec.env 是组装器产出的白名单，同名时必须覆盖继承值。
  test("launchSpec 覆盖同名继承值", () => {
    const env = buildAgentProcessEnv({ PATH: "/custom/bin", LANGFUSE_PUBLIC_KEY: "pk" }, hostEnv());

    expect(env).toMatchObject({ PATH: "/custom/bin", LANGFUSE_PUBLIC_KEY: "pk", HOME: "/home/agent" });
  });

  // 返回值必须是新对象：共享宿主环境对象会让后续写入污染进程环境。
  test("返回新对象而非宿主环境本体", () => {
    const base = hostEnv();
    const env = buildAgentProcessEnv(undefined, base);

    expect(env).not.toBe(base);
  });

  // 未设置的宿主变量不应以 undefined 值出现在子进程环境里。
  test("跳过未设置的宿主变量", () => {
    const env = buildAgentProcessEnv(undefined, { PATH: "/usr/bin", HOME: undefined });

    expect(Object.keys(env)).toEqual(["PATH"]);
  });
});
