import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { bindWorkspaceFiles } from "@fenix/plugin-sdk";
import { HINDSIGHT_PLUGIN_DEFAULTS } from "@fenix/resource-memory/server";
import { createMemoryModuleConfig } from "@fenix/resource-memory/server/testing";
import { buildLangfuseEnv, buildMemoryLaunchEnv } from "../server/services/agent-launch-spec/memory-env";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import { launchSpecDeps } from "./fixtures";

const HINDSIGHT_URL = "http://hindsight:9999";
const input = { agentConfigId: "agent-1", organizationId: "org-1", userId: "user-1", extra: null };

function stubMemorySwitch(enabled: boolean): void {
  stubDb({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (enabled ? [{ enabled: true }] : []) }) }) }),
  });
}

describe("Hindsight 工作区配置下发", () => {
  beforeEach(() => {
    initializeAgentConfigModuleConfig({}, { memory: createMemoryModuleConfig({ hindsightMcpUrl: HINDSIGHT_URL }) });
    stubMemorySwitch(true);
    stubIdentityDirectory({ resolveMembershipId: async () => "bank-1" });
  });
  afterEach(() => resetAllStubs());

  // 未配置或未启用时不分配插件和文件，避免绕过平台记忆开关。
  test("两级记忆开关控制文件与插件", async () => {
    stubMemorySwitch(false);
    expect((await buildMemoryLaunchEnv(launchSpecDeps(), input)).workspaceFiles).toEqual([]);
    initializeAgentConfigModuleConfig({}, { memory: createMemoryModuleConfig() });
    stubMemorySwitch(true);
    expect((await buildMemoryLaunchEnv(launchSpecDeps(), input)).plugins).toEqual([]);
  });

  // 跨仓键名契约来自插件 src/lib/config.ts DEFAULTS，配置值只出现在文件中。
  test("生成扁平 camelCase JSON 与显式插件信号", async () => {
    const token = crypto.randomUUID();
    const deps = launchSpecDeps({ env: { ...launchSpecDeps().env, hindsightApiToken: token } });
    const result = await buildMemoryLaunchEnv(deps, input);
    expect(result.plugins).toEqual(["hindsight"]);
    expect(result.extra).toBeNull();
    expect(result).not.toHaveProperty("env");
    const file = result.workspaceFiles[0];
    expect(file.path).toBe(".hindsight/workspace.json");
    expect(file.envVar).toBe("HINDSIGHT_CONFIG");
    expect(file.content).toEqual({
      autoRecall: true,
      autoRetain: true,
      recallBudget: "mid",
      recallTags: [],
      recallTagsMatch: "any",
      retainEveryNTurns: 3,
      debug: false,
      hindsightApiUrl: HINDSIGHT_URL,
      hindsightApiToken: token,
      llmProvider: "claude-code",
      bankId: "bank-1",
      bankIdPrefix: "",
      directoryBankMap: {},
      recallAdditionalBanks: [],
      recallAdditionalBankFilters: {},
      dynamicBankId: false,
    });
  });

  // 托管文件是最高层但插件逐键合并（插件 config.ts:287-295）：隔离键必须真实写出，缺一个就等于把
  // 该维度交还给 ~/.hindsight/<engine>.json 等低优先级层。键集本身就是隔离契约，本用例按集合钉死。
  test("钉死 bank 选择与跨 bank 召回的隔离键", async () => {
    const content = (await buildMemoryLaunchEnv(launchSpecDeps(), input)).workspaceFiles[0].content;
    expect(Object.keys(content).sort()).toEqual([
      "autoRecall",
      "autoRetain",
      "bankId",
      "bankIdPrefix",
      "debug",
      "directoryBankMap",
      "dynamicBankId",
      "hindsightApiToken",
      "hindsightApiUrl",
      "llmProvider",
      "recallAdditionalBankFilters",
      "recallAdditionalBanks",
      "recallBudget",
      "recallTags",
      "recallTagsMatch",
      "retainEveryNTurns",
    ]);
    // 插件 deriveBankId 的 directoryBankMap / bankIdPrefix 分支优先于静态 bankId（插件 bank.ts:138-163）：
    // 空值让两条分支都不生效，最终只返回托管文件里的成员 bankId。
    expect(content.bankIdPrefix).toBe("");
    expect(content.directoryBankMap).toEqual({});
    expect(content.dynamicBankId).toBe(false);
    // 插件会用平台 client（含平台 token）对 recallAdditionalBanks 里的每个 bank 发起 recall
    // （插件 hooks/recall.ts:381-407）：空容器让循环不进入，读取面与写入面同样锁在成员 bank。
    expect(content.recallAdditionalBanks).toEqual([]);
    expect(content.recallAdditionalBankFilters).toEqual({});
  });

  // retain 会话标签是插件默认 ['{session_id}']（插件 config.ts:111-115），写空数组会对所有引擎静默
  // 关闭标签、且写入后无法补打：托管文件必须省略该键，让插件默认层生效。
  test("不写 retainTags，保留插件的会话标签默认值", async () => {
    const content = (await buildMemoryLaunchEnv(launchSpecDeps(), input)).workspaceFiles[0].content;
    expect(content).not.toHaveProperty("retainTags");
    expect(HINDSIGHT_PLUGIN_DEFAULTS).not.toHaveProperty("retainTags");
  });

  // 平台未配置 token 时写 null：插件把 null 视为「未设置」（插件 config.ts:291-292），故机器侧 env /
  // 用户配置里的 token 仍可生效，与改造前「只有平台配置了才注入 HINDSIGHT_API_TOKEN」一致。
  test("未配置 token 时写 null 表示未设置而非清空", async () => {
    const result = await buildMemoryLaunchEnv(launchSpecDeps(), input);
    expect(result.workspaceFiles[0].content.hindsightApiToken).toBeNull();
  });

  // 去掉旧 tuple 和字符串条目，不再通过 extra 携带第二份 Hindsight 配置。
  test("清除旧插件配置，保留其它插件", async () => {
    const result = await buildMemoryLaunchEnv(launchSpecDeps(), {
      ...input,
      extra: {
        plugin: [["@konghayao/opencode-hindsight", { stale: true }], "@konghayao/opencode-hindsight", ["other", {}]],
        steps: 12,
      },
    });
    expect(result.extra).toEqual({ plugin: [["other", {}]], steps: 12 });
  });

  // 成员解析失败不阻断 agent，但不能回落到默认共享 bank 造成跨租户混用。
  test("成员缺失或解析异常时禁用记忆", async () => {
    stubIdentityDirectory({ resolveMembershipId: async () => undefined });
    expect((await buildMemoryLaunchEnv(launchSpecDeps(), input)).workspaceFiles).toEqual([]);
    stubIdentityDirectory({
      resolveMembershipId: async () => {
        throw new Error("unavailable");
      },
    });
    expect((await buildMemoryLaunchEnv(launchSpecDeps(), input)).plugins).toEqual([]);
  });

  // 工作区解析结果决定唯一定位 env，调用方额外变量不能重新引入旧配置面。
  test("绝对路径注入并停发所有旧 HINDSIGHT 配置 env", async () => {
    const memory = await buildMemoryLaunchEnv(launchSpecDeps(), input);
    const workspace = launchSpecDeps().resolveWorkspacePath("org-1", "user-1", "env-1");
    const spec = bindWorkspaceFiles(
      {
        organizationId: "org-1",
        userId: "user-1",
        environmentId: "env-1",
        agent: { name: "test" },
        model: { provider: "test", protocol: "openai", baseUrl: "", apiKey: "", model: "test" },
        skills: [],
        mcpServers: [],
        workspaceFiles: memory.workspaceFiles,
        plugins: memory.plugins,
        env: {
          HINDSIGHT_API_URL: "stale",
          HINDSIGHT_BANK_ID: "stale",
          HINDSIGHT_LLM_PROVIDER: "stale",
          HINDSIGHT_API_TOKEN: crypto.randomUUID(),
          HINDSIGHT_CONFIG: "/stale",
          OTHER: "kept",
        },
      },
      workspace,
    );
    expect(spec.env).toEqual({ HINDSIGHT_CONFIG: `${workspace}/.hindsight/workspace.json`, OTHER: "kept" });
    expect(spec.workspaceFiles?.[0].content.managed).toMatchObject({ writer: "FenixAgent", workspaceRoot: workspace });
    expect(memory.workspaceFiles[0].content).not.toHaveProperty("managed");
  });
});

describe("Langfuse 下发保持独立", () => {
  // 观测只透传三个已声明键，不受记忆配置文件迁移影响。
  test("三个观测键独立按配置注入", () => {
    expect(buildLangfuseEnv(launchSpecDeps({ env: { agentSystemPrompt: "", baseUrl: "" } }))).toEqual({});
    expect(
      buildLangfuseEnv(
        launchSpecDeps({ env: { agentSystemPrompt: "", baseUrl: "", langfuse: { publicKey: "public" } } }),
      ),
    ).toEqual({ LANGFUSE_PUBLIC_KEY: "public" });
    const secretKey = crypto.randomUUID();
    expect(
      buildLangfuseEnv(
        launchSpecDeps({
          env: {
            agentSystemPrompt: "",
            baseUrl: "",
            langfuse: { publicKey: "public", secretKey, baseUrl: "http://langfuse" },
          },
        }),
      ),
    ).toEqual({ LANGFUSE_PUBLIC_KEY: "public", LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: "http://langfuse" });
  });
});
