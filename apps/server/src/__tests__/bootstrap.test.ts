import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleManifest } from "@fenix/platform-sdk";
import { loadAssemblyProfile } from "../assembly-config";
import { bootstrapServerAssembly } from "../bootstrap";

const profile = {
  identity: "identity",
  accessControl: "access-control",
  agentRuntime: "agent-runtime",
  webShell: "default",
  resources: ["agent-config"],
  web: ["agent-config"],
};

const manifests = [
  {
    id: "identity",
    kind: "identity",
    dependsOn: [],
    create: () => ({ id: "identity" }),
  },
  {
    id: "access-control",
    kind: "access-control",
    dependsOn: [],
    create: () => ({ id: "access" }),
  },
  {
    id: "agent-runtime",
    kind: "agent-runtime",
    dependsOn: ["access-control"],
    create: () => ({ id: "runtime" }),
  },
  {
    id: "agent-config",
    kind: "resource",
    dependsOn: ["agent-runtime"],
    contributions: [{ id: "agent-config.routes", kind: "app-route", value: "routes" }],
    web: { id: "agent-config", contribution: "page" },
  },
  // profile 的 webShell 必须解析到已注册的 web-shell 模块；Shell 是应用级组合，只做绑定校验，
  // 不进入 server 的 modules / instances（因此下面的 preflight 仍为 4）。
  {
    id: "default",
    kind: "web-shell",
    dependsOn: [],
  },
] satisfies readonly ModuleManifest[];

// 部署入口可选择 JSON 或 YAML，但两者必须进入同一个 SDK parser。
test("从 JSON 和 YAML 文件读取同一 assembly profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fenix-assembly-profile-"));
  try {
    const jsonPath = join(directory, "ce.json");
    const yamlPath = join(directory, "ce.yaml");
    await writeFile(jsonPath, JSON.stringify(profile));
    await writeFile(
      yamlPath,
      [
        "identity: identity",
        "accessControl: access-control",
        "agentRuntime: agent-runtime",
        "webShell: default",
        "resources:",
        "  - agent-config",
        "web:",
        "  - agent-config",
        "",
      ].join("\n"),
    );

    expect(await loadAssemblyProfile(jsonPath)).toEqual(profile);
    expect(await loadAssemblyProfile(yamlPath)).toEqual(profile);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// 未支持的扩展名不能触发猜测式解析或任意代码加载。
test("拒绝非 JSON/YAML assembly 文件", async () => {
  await expect(loadAssemblyProfile("/tmp/ce.ts")).rejects.toThrow("assembly profile 仅支持 .json、.yaml 或 .yml");
});

// 显式注入的非法值必须原样进入 parser，不能被空值合并误判为未提供配置。
test("拒绝显式注入的 null profile", async () => {
  await expect(
    bootstrapServerAssembly({
      profile: null,
      manifests,
      loadEnv: () => ({}),
    }),
  ).rejects.toThrow("装配配置格式非法");
});

// server bootstrap 只编排公共契约，不直接导入或创建具体业务实现。
test("通过注入边界完成 env、preflight 和贡献挂载", async () => {
  const events: string[] = [];
  const result = await bootstrapServerAssembly({
    profile,
    manifests,
    loadEnv: (definitions) => {
      events.push(`env:${definitions.length}`);
      return {};
    },
    preflight: ({ modules }) => {
      events.push(`preflight:${modules.length}`);
    },
    mountContribution: ({ contribution }) => {
      events.push(`mount:${contribution.id}`);
    },
  });

  expect(events).toEqual(["env:0", "preflight:4", "mount:agent-config.routes"]);
  expect(result.webContributions.get("agent-config")).toBe("page");
});

// 基础模块必须能读到本次装配的全部声明（含尚未实例化的资源模块）：授权模块据此收集资源模块声明的
// 静态绑定，收集因此不依赖资源模块的实例化，装配序不会成环。
test("工厂读到本次装配的全部声明，基础模块可先行收集静态绑定", async () => {
  const seenDeclarations: string[][] = [];
  const collectedBindings: string[] = [];
  const declarationManifests = [
    {
      id: "identity",
      kind: "identity",
      dependsOn: [],
      create: ({ declarations }) => {
        seenDeclarations.push(declarations.map((manifest) => manifest.id));
        return { id: "identity" };
      },
    },
    {
      id: "access-control",
      kind: "access-control",
      dependsOn: ["identity"],
      create: ({ declarations }) => {
        collectedBindings.push(
          ...declarations
            .flatMap((manifest) => manifest.accessControlBindings ?? [])
            .map((binding) => binding.resourceType),
        );
        return { id: "access-control" };
      },
    },
    {
      id: "agent-runtime",
      kind: "agent-runtime",
      dependsOn: ["access-control"],
      create: () => ({ id: "runtime" }),
    },
    {
      id: "mcp",
      kind: "resource",
      dependsOn: [],
      accessControlBindings: [{ resourceType: "mcp_server", table: {}, columns: { id: {} } }],
      create: () => ({ id: "mcp" }),
    },
    // profile 的 webShell 必须解析到已注册的 web-shell 模块；Shell 不进 server 的实例化列表。
    { id: "default", kind: "web-shell", dependsOn: [] },
  ] satisfies readonly ModuleManifest[];

  const result = await bootstrapServerAssembly({
    profile: { ...profile, resources: ["mcp"], web: [] },
    manifests: declarationManifests,
    loadEnv: () => ({}),
  });

  // 声明面是拓扑序的启用模块全集：顺序与实例化顺序一致，且不含不参与实例化的 Shell。
  expect(seenDeclarations).toEqual([["identity", "access-control", "agent-runtime", "mcp"]]);
  // access-control 先于 mcp 构造，却已经拿到 mcp 声明的绑定——「先装配授权、再装配资源模块」由此成立。
  expect(collectedBindings).toEqual(["mcp_server"]);
  expect(result.modules.map((manifest) => manifest.id)).toEqual(["identity", "access-control", "agent-runtime", "mcp"]);
});

// 兜底与通配路由必须最后挂载：贡献的 order 让优先级在声明处自证，宿主不必维护「哪些模块必须最后挂」。
test("贡献按 order 升序稳定排序后挂载", async () => {
  const mounted: string[] = [];
  const orderedManifests = [
    {
      id: "identity",
      kind: "identity",
      dependsOn: [],
      contributions: [
        { id: "identity.primary", kind: "app-route", value: "primary" },
        { id: "identity.fallback", kind: "app-route", order: 100, value: "fallback" },
      ],
      create: () => ({ id: "identity" }),
    },
    {
      id: "access-control",
      kind: "access-control",
      dependsOn: ["identity"],
      contributions: [{ id: "access-control.primary", kind: "app-route", value: "primary" }],
      create: () => ({ id: "access-control" }),
    },
    {
      id: "agent-runtime",
      kind: "agent-runtime",
      dependsOn: ["access-control"],
      create: () => ({ id: "runtime" }),
    },
    { id: "default", kind: "web-shell", dependsOn: [] },
  ] satisfies readonly ModuleManifest[];

  await bootstrapServerAssembly({
    profile: { ...profile, resources: [], web: [] },
    manifests: orderedManifests,
    loadEnv: () => ({}),
    mountContribution: ({ contribution }) => {
      mounted.push(contribution.id);
    },
  });

  // 同 order 保持拓扑序与声明序（identity 早于 access-control），order 100 的兜底贡献排在最后。
  expect(mounted).toEqual(["identity.primary", "access-control.primary", "identity.fallback"]);
});
