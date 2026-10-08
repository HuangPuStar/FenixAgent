/**
 * 工作区归档子进程环境白名单测试（file_op `zip`，F3）。
 *
 * 断言白名单产物本身：`opZip` 用同一函数构造 `/bin/sh -c ...` 的 env。真实子进程路径由
 * `file-operations.test.ts` 的打包用例覆盖（PATH 缺失时那里的脚本会走 exit 73 / 找不到 zip）。
 */

import { describe, expect, test } from "bun:test";
import { buildWorkspaceZipEnv, WORKSPACE_ZIP_ENV_KEYS } from "../client/workspace-zip-env";

/** 模拟 acp-link 进程环境：既有脚本依赖的基础变量，也有必须拦下的引擎配置与宿主变量。 */
function processEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    TZ: "Asia/Shanghai",
    HOME: "/home/fenix",
    USER: "fenix",
    TERM: "xterm-256color",
    ACP_ENGINE_TYPE: "claude-code",
    ANTHROPIC_MODEL: "claude-sonnet-4-6",
    CLAUDE_CODE_CLI_PATH: "/usr/local/bin/claude",
    ZIPOPT: "-X",
    DATABASE_URL: "postgres://host/leak",
    LANGFUSE_SECRET_KEY: "host-langfuse-secret",
  };
}

describe("buildWorkspaceZipEnv 环境白名单", () => {
  // 归档子进程由服务端请求驱动，宿主密钥（数据库连接串、langfuse secret）绝不能随之外传
  test("拦下宿主密钥", () => {
    const env = buildWorkspaceZipEnv(processEnv());

    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("LANGFUSE_SECRET_KEY");
  });

  // 归档不复用 Agent 白名单：引擎配置与交互变量（HOME/USER/TERM）对一次性打包没有用处
  test("不放行 Agent 引擎配置与交互变量", () => {
    const env = buildWorkspaceZipEnv(processEnv());

    expect(env).not.toHaveProperty("ACP_ENGINE_TYPE");
    expect(env).not.toHaveProperty("ANTHROPIC_MODEL");
    expect(env).not.toHaveProperty("CLAUDE_CODE_CLI_PATH");
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("USER");
    expect(env).not.toHaveProperty("TERM");
  });

  // zip 会把 ZIPOPT/ZIP 的内容插入命令行（man zip 的 ENVIRONMENT），继承等于让宿主改写命令参数
  test("不放行会被 zip 当命令行选项读的变量", () => {
    const env = buildWorkspaceZipEnv(processEnv());

    expect(env).not.toHaveProperty("ZIPOPT");
  });

  // 脚本内的 zip/find/grep 都按名字调用，PATH 缺失会把环境问题伪装成路径安全问题（exit 73）
  test("只保留命令查找与时间戳依赖的变量", () => {
    expect(WORKSPACE_ZIP_ENV_KEYS).toEqual(["PATH", "TZ"]);

    expect(buildWorkspaceZipEnv(processEnv())).toEqual({ PATH: "/usr/bin:/bin", TZ: "Asia/Shanghai" });
  });

  // 未设置的宿主变量不应以 undefined 值出现在子进程环境里
  test("跳过未设置的宿主变量", () => {
    const env = buildWorkspaceZipEnv({ PATH: "/usr/bin", TZ: undefined });

    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  // 返回值必须是新对象：共享宿主环境对象会让后续写入污染进程环境
  test("返回新对象而非宿主环境本体", () => {
    const base = processEnv();

    expect(buildWorkspaceZipEnv(base)).not.toBe(base);
  });
});
