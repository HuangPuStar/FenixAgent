import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleManifest } from "@fenix/platform-sdk";
import { loadAssemblyProfile } from "../assembly-config";
import { bootstrapServerAssembly } from "../bootstrap";

const profile = {
  accessControl: "access-control",
  agentRuntime: "agent-runtime",
  webShell: "default",
  resources: ["agent-config"],
  web: ["agent-config"],
};

const manifests = [
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

  expect(events).toEqual(["env:0", "preflight:3", "mount:agent-config.routes"]);
  expect(result.webContributions.get("agent-config")).toBe("page");
});
