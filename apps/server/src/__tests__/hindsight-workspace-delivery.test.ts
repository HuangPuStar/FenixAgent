import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCcbRuntimeConfig, createCcbHandler, createCcbRuntime } from "@fenix/ccb";
import { buildSettings, createClaudeCodeHandler, createClaudeCodeRuntime } from "@fenix/claude-code";
import { buildOpencodeRuntimeConfig, createOpencodeHandler, createOpencodeRuntime } from "@fenix/opencode";
import { buildPeriRuntimeConfig, createPeriHandler, createPeriRuntime } from "@fenix/peri";

type LaunchSpec = Parameters<typeof buildCcbRuntimeConfig>[0];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function spec(): LaunchSpec {
  return {
    organizationId: "org",
    userId: "user",
    environmentId: "env",
    agent: { name: "test" },
    model: { provider: "test", protocol: "openai", baseUrl: "", apiKey: "", model: "test" },
    skills: [],
    mcpServers: [],
    plugins: ["hindsight"],
    env: { HINDSIGHT_CONFIG: "/host/old/workspace.json" },
    workspaceFiles: [
      {
        path: ".hindsight/workspace.json",
        envVar: "HINDSIGHT_CONFIG",
        content: {
          bankId: "member",
          hindsightApiUrl: "http://hindsight:9999",
          autoRecall: true,
          // 与组装器产出的托管键集一致：隔离钉必须原样落到磁盘。
          bankIdPrefix: "",
          directoryBankMap: {},
          recallAdditionalBanks: [],
          recallAdditionalBankFilters: {},
          dynamicBankId: false,
        },
      },
    ],
  };
}

const engines = [
  {
    name: "opencode",
    runtime: createOpencodeRuntime,
    handler: createOpencodeHandler,
    config: ".opencode/opencode.json",
  },
  { name: "ccb", runtime: createCcbRuntime, handler: createCcbHandler, config: ".claude/settings.local.json" },
  { name: "peri", runtime: createPeriRuntime, handler: createPeriHandler, config: ".claude/settings.local.json" },
  {
    name: "claude-code",
    runtime: createClaudeCodeRuntime,
    handler: createClaudeCodeHandler,
    config: ".claude/settings.local.json",
  },
];

for (const engine of engines) {
  describe(`${engine.name} 工作区下发`, () => {
    // 本地和 machine 的实际 preparer 都需消费 launch_spec，刷新时全量覆盖手改内容而不是 merge。
    test("本地 prepare 与远程 handler 全量幂等重写且只保留定位变量", async () => {
      const root = await mkdtemp(join(tmpdir(), "hindsight-delivery-"));
      roots.push(root);
      const runtime = engine.runtime({ workspaceRoot: join(root, "local") });
      const handler = engine.handler();
      const localWorkspace = join(root, "local", "org", "user", "env");
      const remoteWorkspace = join(root, "machine", "org", "user", "env");
      for (const [workspace, prepare] of [
        [
          localWorkspace,
          (launchSpec: LaunchSpec) => runtime.prepareEnvironment({ instanceId: "instance", launchSpec }),
        ],
        [remoteWorkspace, (launchSpec: LaunchSpec) => handler.prepareWorkspace(remoteWorkspace, launchSpec)],
      ] as const) {
        const original = spec();
        await prepare(original);
        const path = join(workspace, ".hindsight/workspace.json");
        const first = JSON.parse(await readFile(path, "utf8"));
        expect(first).toMatchObject({
          bankId: "member",
          autoRecall: true,
          managed: { writer: "FenixAgent", workspaceRoot: workspace },
        });
        // 隔离钉与「不写 retainTags」都要活着到达磁盘：写入链不得丢键，也不得补回插件默认以外的标签配置。
        expect(first).toMatchObject({
          bankIdPrefix: "",
          directoryBankMap: {},
          recallAdditionalBanks: [],
          recallAdditionalBankFilters: {},
          dynamicBankId: false,
        });
        expect(first).not.toHaveProperty("retainTags");
        expect(Number.isNaN(Date.parse(first.managed.writtenAt))).toBe(false);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(original.workspaceFiles?.[0].content).not.toHaveProperty("managed");
        await writeFile(path, JSON.stringify({ stale: true, bankId: "manual" }));
        const refreshed = spec();
        refreshed.workspaceFiles![0].content = { bankId: "updated", autoRecall: false };
        await prepare(refreshed);
        const second = JSON.parse(await readFile(path, "utf8"));
        expect(second.bankId).toBe("updated");
        expect(second.autoRecall).toBe(false);
        expect(second).not.toHaveProperty("stale");
        expect(second).not.toHaveProperty("hindsightApiUrl");
        const config = JSON.parse(await readFile(join(workspace, engine.config), "utf8"));
        if (engine.name === "opencode") {
          expect(config.plugin).toEqual([["@konghayao/opencode-hindsight", {}]]);
        } else {
          expect(config.enabledPlugins).toEqual({ "hindsight-memory@hindsight-plugin": true });
          expect(Object.keys(config.env).filter((key) => key.startsWith("HINDSIGHT_"))).toEqual(["HINDSIGHT_CONFIG"]);
          expect(config.env.HINDSIGHT_CONFIG).toBe(path);
        }
      }
    });
  });
}

// 三个 Claude 兼容引擎都必须只读显式信号，不能把定位变量当作开关。
test("ccb/peri/claude-code 显式启用语义一致", () => {
  for (const build of [buildCcbRuntimeConfig, buildPeriRuntimeConfig, buildSettings]) {
    expect(build({ ...spec(), env: undefined }, []).enabledPlugins).toEqual({
      "hindsight-memory@hindsight-plugin": true,
    });
    expect(build({ ...spec(), plugins: [] }, []).enabledPlugins).toBeUndefined();
  }
});

// 平台不再注册系统 MCP，同名的用户资源应正常下发而非被引擎暗中剔除。
test("opencode 保留用户同名 MCP，插件参数不携带配置", () => {
  const config = buildOpencodeRuntimeConfig(
    { ...spec(), mcpServers: [{ name: "hindsight", type: "stdio", command: "user-server" }] },
    [],
  );
  expect(config.mcp.hindsight).toMatchObject({ type: "local", command: ["user-server"] });
  expect(config.plugin).toEqual([["@konghayao/opencode-hindsight", {}]]);
});
