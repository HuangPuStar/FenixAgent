import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { createMemoryModuleConfig } from "@fenix/resource-memory/server/testing";
import { buildLangfuseEnv, buildMemoryLaunchEnv } from "../server/services/agent-launch-spec/memory-env";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import { launchSpecDeps } from "./fixtures";

/**
 * 记忆与观测运行期环境（`agent-launch-spec/memory-env.ts`）的规则用例。
 *
 * 两条投递面必须并存：**opencode 引擎**读 `agent.extra.plugin`（记忆插件由运行时动态构造，用户自写的
 * 同名旧条目要被替换），**ccb 引擎**读 `launchSpec.env` 里的 `HINDSIGHT_*` 变量。三级前提缺一不可：
 * 宿主配了 Hindsight 地址 → Agent 级开关打开 → 才注入。
 *
 * 这里的 DB 替身只服务记忆开关的读取（`agent_memory_config`），身份目录替身只服务 bank ID 解析。
 *
 * 迁移说明（W4b）：本文件承接 `agent-runtime` 的 `launch-spec-builder-hindsight` 与
 * `launch-spec-langfuse-env` 的断言面。前者是**自造实现的死测试**（在被测文件里重写了一遍注入逻辑，
 * 从不执行生产代码），因此不算「原样搬运」，而是按现在的实现重新钉住同一条行为契约。
 */

const HINDSIGHT_URL = "http://hindsight:9999";
const BANK_ID = "bank-1";
const API_TOKEN = "token-abc";

/** 让 `isAgentMemoryEnabled` 读到给定开关；`false` 表示行不存在（未启用）。 */
function stubMemorySwitch(enabled: boolean): void {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (enabled ? [{ agentConfigId: "agent-1", enabled: true }] : []),
        }),
      }),
    }),
  });
}

describe("记忆注入（Hindsight）", () => {
  beforeEach(() => {
    // 模块配置只能初始化一次：地址与 skill 无关，故只声明 memory 一项。
    initializeAgentConfigModuleConfig({}, { memory: createMemoryModuleConfig({ hindsightMcpUrl: HINDSIGHT_URL }) });
  });

  // 未配置 Hindsight 地址：整体按「记忆能力未启用」处理，extra 原样返回、不注入任何变量。
  test("宿主未配置 Hindsight 时不注入", async () => {
    initializeAgentConfigModuleConfig({}, { memory: createMemoryModuleConfig() });
    stubMemorySwitch(true);
    stubIdentityDirectory({ resolveMembershipId: async () => BANK_ID });
    const extra = { plugin: [["some-other-plugin", {}]] };

    const result = await buildMemoryLaunchEnv(launchSpecDeps(), {
      agentConfigId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      extra,
    });

    expect(result.env).toEqual({});
    expect(result.extra).toBe(extra);
  });

  // 地址配好了但 Agent 级开关没打开：同样不注入，extra 原样返回（开关读取走 `agent_memory_config`）。
  test("Agent 未启用记忆时不注入", async () => {
    stubMemorySwitch(false);
    stubIdentityDirectory({ resolveMembershipId: async () => BANK_ID });
    const extra = { plugin: [] };

    const result = await buildMemoryLaunchEnv(launchSpecDeps(), {
      agentConfigId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      extra,
    });

    expect(result.env).toEqual({});
    expect(result.extra).toBe(extra);
  });

  // 启用后两条投递面同时生效：extra 里追加动态构造的记忆插件（指向本次的 bank），env 里注入变量。
  test("启用记忆时注入插件条目与环境变量", async () => {
    stubMemorySwitch(true);
    stubIdentityDirectory({ resolveMembershipId: async () => BANK_ID });
    const deps = launchSpecDeps({
      env: { ...launchSpecDeps().env, hindsightApiToken: API_TOKEN },
    });

    const result = await buildMemoryLaunchEnv(deps, {
      agentConfigId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      extra: null,
    });

    expect(result.env).toEqual({
      HINDSIGHT_API_URL: HINDSIGHT_URL,
      HINDSIGHT_LLM_PROVIDER: "claude-code",
      HINDSIGHT_BANK_ID: BANK_ID,
      HINDSIGHT_API_TOKEN: API_TOKEN,
    });
    const plugins = (result.extra as { plugin: Array<[string, Record<string, unknown>]> }).plugin;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.[0]).toBe("@konghayao/opencode-hindsight");
    expect(plugins[0]?.[1]).toMatchObject({ hindsightApiUrl: HINDSIGHT_URL, bankId: BANK_ID });
  });

  // 未配置 API token 时只注入三个键：空值不入 env（空串会让 agent 拿空 token 去连 Hindsight）。
  test("未配置 API token 时只注入三个变量", async () => {
    stubMemorySwitch(true);
    stubIdentityDirectory({ resolveMembershipId: async () => BANK_ID });

    const result = await buildMemoryLaunchEnv(launchSpecDeps(), {
      agentConfigId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      extra: null,
    });

    expect(result.env).not.toHaveProperty("HINDSIGHT_API_TOKEN");
    expect(Object.keys(result.env).sort()).toEqual([
      "HINDSIGHT_API_URL",
      "HINDSIGHT_BANK_ID",
      "HINDSIGHT_LLM_PROVIDER",
    ]);
  });

  // 用户可手改 `agent.extra.plugin`：同名旧条目必须被替换（留着会出现两份同名插件，行为取决于加载顺序），
  // 首项不是插件名的条目（`extra` 里混进来的非插件项）丢弃，其余用户的插件条目原样保留。
  test("替换同名的旧插件条目并丢弃非法形状", async () => {
    stubMemorySwitch(true);
    stubIdentityDirectory({ resolveMembershipId: async () => BANK_ID });
    const extra = {
      plugin: [
        ["@konghayao/opencode-hindsight", { stale: true }],
        ["keep-me", { a: 1 }],
        [42, {}],
      ],
      other: "kept",
    };

    const result = await buildMemoryLaunchEnv(launchSpecDeps(), {
      agentConfigId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      extra,
    });

    const plugins = (result.extra as { plugin: Array<[string, Record<string, unknown>]> }).plugin;
    expect(plugins.map((entry) => entry[0])).toEqual(["keep-me", "@konghayao/opencode-hindsight"]);
    expect((result.extra as { other: string }).other).toBe("kept");
    expect(plugins[0]?.[1]).toEqual({ a: 1 });
  });

  // bank ID 解析失败只记日志、不阻断启动：它是 Hindsight 侧的隔离标识，缺失时记忆退化为「不区分 bank」，
  // 而不是让 Agent 起不来。
  test("bank ID 解析失败时降级为不注入 bank", async () => {
    stubMemorySwitch(true);
    stubIdentityDirectory({
      resolveMembershipId: async () => {
        throw new Error("identity directory unavailable");
      },
    });

    const result = await buildMemoryLaunchEnv(launchSpecDeps(), {
      agentConfigId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      extra: null,
    });

    expect(result.env).not.toHaveProperty("HINDSIGHT_BANK_ID");
    expect(result.env.HINDSIGHT_API_URL).toBe(HINDSIGHT_URL);
    const plugins = (result.extra as { plugin: Array<[string, Record<string, unknown>]> }).plugin;
    expect(plugins[0]?.[1]).not.toHaveProperty("bankId");
  });
});

describe("观测变量注入（Langfuse）", () => {
  beforeEach(() => resetAllStubs());

  // 只透传声明的三个键：无关的 `LANGFUSE_*` 不得随宿主配置泄漏到 agent 进程。
  test("只透传声明的三个键", () => {
    const env = buildLangfuseEnv(
      launchSpecDeps({
        env: {
          agentSystemPrompt: "template",
          baseUrl: "https://platform.example.com",
          langfuse: { publicKey: "pk-1", secretKey: "sk-1", baseUrl: "https://lf.example.com" },
        },
      }),
    );

    expect(env).toEqual({
      LANGFUSE_PUBLIC_KEY: "pk-1",
      LANGFUSE_SECRET_KEY: "sk-1",
      LANGFUSE_BASE_URL: "https://lf.example.com",
    });
  });

  // 宿主未配置观测时不注入任何键：空值进 env 会让 agent 带着半截配置去连 Langfuse。
  test("未配置 Langfuse 时不注入", () => {
    const env = buildLangfuseEnv(
      launchSpecDeps({ env: { agentSystemPrompt: "template", baseUrl: "https://platform.example.com" } }),
    );

    expect(env).toEqual({});
  });

  // 三个键各自独立：只配了 publicKey 时就只注入它，其余键整体不出现。
  test("三个键各自独立注入", () => {
    const env = buildLangfuseEnv(
      launchSpecDeps({
        env: {
          agentSystemPrompt: "template",
          baseUrl: "https://platform.example.com",
          langfuse: { publicKey: "pk-only" },
        },
      }),
    );

    expect(env).toEqual({ LANGFUSE_PUBLIC_KEY: "pk-only" });
  });
});
