import { describe, expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { createStubMcpServerService } from "@fenix/resource-mcp/server/testing";
import {
  buildMcpSpecs,
  loadAgentMcpServers,
  toSdkMcpConfig,
} from "../server/services/agent-launch-spec/mcp-resolution";
import { createStubAgentAssociations } from "../server/testing";
import { launchSpecDeps, mcpRow, scopedAgent } from "./fixtures";

/**
 * MCP 解析（`agent-launch-spec/mcp-resolution.ts`）的规则用例。
 *
 * 覆盖两个方向：**行 → SDK 配置的翻译**（两代写法 `local` / `stdio` / `remote` 的归一与容忍性过滤）与
 * **绑定集合 → 行的读取**（缺行、停用、绑定顺序）。两者都按「配置损坏即阻断启动」处理：静默跳过会让
 * 实例看起来启动成功而工具集残缺，排查成本远高于启动失败。
 *
 * 迁移说明（W4b）：本文件承接 `agent-runtime` 的 `round43` / `round44` / `launch-spec-mcp-resource-access` /
 * `launch-spec-builder-errors` 四个旧用例文件里的 MCP 断言面（旧实现 `launch-spec-builder.ts` 已删除）。
 * 写入期的 MCP 校验由 `@fenix/resource-mcp` 自己的用例覆盖，这里只覆盖**读取期**的翻译与失败语义。
 */

/** 捕获组装抛出的配置错误；不用 `rejects.toThrow` 是为了同时断言错误码与状态码。 */
async function captureConfigError(run: () => unknown): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("预期翻译失败，但调用成功返回");
}

describe("MCP 行翻译为 SDK 配置", () => {
  // local 是历史写法：command 是数组，首元素是命令、其余是参数；非字符串项（旧数据里混进来的数字）
  // 必须被过滤掉，而不是把 `[object]` 之类的东西当参数下发给 agent 进程。
  test("local 写法归一为 stdio 并过滤非字符串参数", () => {
    const spec = toSdkMcpConfig(
      "filesystem",
      {
        type: "local",
        command: ["node", "server.js", 9, null, "extra"],
        environment: { SAFE: "1" },
        timeout: 500,
      },
      "agent-1",
    );

    expect(spec).toEqual({
      name: "filesystem",
      type: "stdio",
      command: "node",
      args: ["server.js", "extra"],
      env: { SAFE: "1" },
      timeout: 500,
    });
  });

  // 单命令的 local 行没有参数：`args` 保持 undefined，避免下发空数组让下游两种空值混用。
  test("local 写法只有命令时省略参数", () => {
    const spec = toSdkMcpConfig("filesystem", { type: "local", command: ["node"] }, "agent-1");

    expect(spec.command).toBe("node");
    expect(spec.args).toBeUndefined();
  });

  // stdio 写法的 `args` 同样要过滤非字符串项；`timeout` 非数字时不下发（而不是转成 NaN）。
  test("stdio 写法过滤非字符串参数且忽略非数字超时", () => {
    const spec = toSdkMcpConfig(
      "filesystem",
      { type: "stdio", command: "bun", args: ["run", 1, "serve"], env: { A: "b" }, timeout: "500" },
      "agent-1",
    );

    expect(spec).toEqual({
      name: "filesystem",
      type: "stdio",
      command: "bun",
      args: ["run", "serve"],
      env: { A: "b" },
      timeout: undefined,
    });
  });

  // remote 与 streamable-http 是同一个协议的两代写法：都要转成 SDK 的 streamable-http，并保留 headers
  // （远端 MCP 的鉴权在这里）。
  test.each([
    ["remote", { type: "remote", url: "https://mcp.example.com/tools", headers: { Authorization: "Bearer t" } }],
    [
      "streamable-http",
      { type: "streamable-http", url: "https://mcp.example.com/tools", headers: { Authorization: "Bearer t" } },
    ],
  ])("%s 写法转为 streamable-http 并保留 headers", (_label, raw) => {
    const spec = toSdkMcpConfig("remote-tools", raw as Record<string, unknown>, "agent-1");

    expect(spec).toEqual({
      name: "remote-tools",
      type: "streamable-http",
      url: "https://mcp.example.com/tools",
      headers: { Authorization: "Bearer t" },
      timeout: undefined,
    });
  });

  // 形状非法一律阻断启动，并按类型给出可区分的失败语义（local 空 command / remote 空 url / 未知 type）。
  test.each([
    ["local 命令非数组", { type: "local", command: "node" }],
    ["local 命令数组为空", { type: "local", command: [] }],
    ["local 命令首项非字符串", { type: "local", command: [1, "server.js"] }],
    ["stdio 命令为空串", { type: "stdio", command: "" }],
    ["stdio 命令只有空白", { type: "stdio", command: "  " }],
    ["remote 缺少 url", { type: "remote" }],
    ["remote url 只有空白", { type: "remote", url: "  " }],
    ["未知类型", { type: "socket", address: "localhost" }],
    ["缺少类型", {}],
  ])("拒绝 %s", (_label, raw) => {
    expect(() => toSdkMcpConfig("broken", raw as Record<string, unknown>, "agent-1")).toThrow(AppError);
  });

  // 失败必须是「配置问题」：错误码 INVALID_CONFIG + 400，前端据此引导用户改配置而不是报服务故障。
  test("非法配置抛 INVALID_CONFIG 400", async () => {
    const error = await captureConfigError(() => toSdkMcpConfig("broken", { type: "socket" }, "agent-1"));

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("unsupported MCP config");
  });
});

describe("绑定 MCP 行的读取与转换", () => {
  // 绑定顺序即工具集顺序：翻译结果必须与绑定顺序一致，否则「先绑定的先出现」这条约定会在启动路径上丢失。
  test("按绑定顺序输出 SDK 配置", () => {
    const specs = buildMcpSpecs(
      [
        mcpRow({ id: "mcp-b", name: "second", config: { type: "stdio", command: "b" } }),
        mcpRow({ id: "mcp-a", name: "first", config: { type: "stdio", command: "a" } }),
      ],
      "agent-1",
    );

    expect(specs.map((spec) => spec.name)).toEqual(["second", "first"]);
  });

  // `config` 列历史上写过字符串形式的 JSON：两种形状都要接受，且解析后走同一条翻译规则。
  test("字符串形式的 config 解析后照常转换", () => {
    const specs = buildMcpSpecs(
      [mcpRow({ config: JSON.stringify({ type: "remote", url: "https://mcp.example.com", timeout: 1000 }) })],
      "agent-1",
    );

    expect(specs).toEqual([
      {
        name: "filesystem",
        type: "streamable-http",
        url: "https://mcp.example.com",
        headers: undefined,
        timeout: 1000,
      },
    ]);
  });

  // 字符串 config 解析失败按配置损坏处理：不能静默跳过（工具集残缺），也不能把原文打进错误细节
  // （里面常有 headers / env 形式的凭证，日志只记长度与类型）。
  test("损坏的字符串 config 抛 INVALID_CONFIG", async () => {
    const error = await captureConfigError(() =>
      buildMcpSpecs([mcpRow({ config: "{broken" as unknown as Record<string, unknown> })], "agent-1"),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("invalid MCP config");
  });

  // 绑定为空即「不注入任何 MCP」：这是显式勾选语义，绝不回退到组织下的全部 MCP（那在多租户下是权限扩张）。
  test("没有绑定 MCP 时返回空集合", async () => {
    const deps = launchSpecDeps({
      associations: createStubAgentAssociations({ listMcpIds: async () => [] }),
    });

    expect(await loadAgentMcpServers(deps, scopedAgent())).toEqual([]);
  });

  // 绑定指向缺失行说明配置已不一致：直接失败，不返回残缺工具集。
  test("绑定指向缺失行时抛 INVALID_CONFIG", async () => {
    const deps = launchSpecDeps({
      associations: createStubAgentAssociations({ listMcpIds: async () => ["mcp-1", "mcp-missing"] }),
      mcp: createStubMcpServerService({ listRowsByIdsUnscoped: async () => [mcpRow()] }),
    });

    const error = await captureConfigError(() => loadAgentMcpServers(deps, scopedAgent()));

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("references missing MCP servers");
  });

  // 绑定指向已停用的行同样阻断启动：错误文案要能区分「缺行」与「停用」两种不一致。
  test("绑定指向已停用行时抛 INVALID_CONFIG", async () => {
    const deps = launchSpecDeps({
      associations: createStubAgentAssociations({ listMcpIds: async () => ["mcp-1"] }),
      mcp: createStubMcpServerService({ listRowsByIdsUnscoped: async () => [mcpRow({ enabled: false })] }),
    });

    const error = await captureConfigError(() => loadAgentMcpServers(deps, scopedAgent()));

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("references disabled MCP servers");
  });
});
