import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { bootstrapModules, createModuleRegistry, type ModuleManifest, parseAssemblyProfile } from "../index";

const validProfile = {
  accessControl: "access-control",
  agentRuntime: "agent-runtime",
  webShell: "default",
  resources: ["agent-config"],
  web: ["agent-config"],
};

/** 构造覆盖基础模块、资源贡献和依赖顺序的最小可信 registry。 */
function createManifests(events: string[] = []): readonly ModuleManifest[] {
  return [
    {
      id: "access-control",
      kind: "access-control",
      dependsOn: [],
      capabilities: ["platform.access-control"],
      envDefinitions: [
        {
          moduleId: "access-control",
          key: "AUTH_MODE",
          schema: z.string(),
          secret: false,
          restartRequired: true,
          description: "认证模式",
        },
      ],
      create: ({ env }) => {
        events.push(`create:access:${String(env.AUTH_MODE)}`);
        return { id: "access" };
      },
    },
    {
      id: "agent-runtime",
      kind: "agent-runtime",
      dependsOn: ["access-control"],
      capabilities: ["agent.runtime"],
      create: ({ modules }) => {
        events.push(`create:agent-runtime:${String(modules.has("access-control"))}`);
        return { id: "runtime" };
      },
    },
    {
      id: "agent-config",
      kind: "resource",
      dependsOn: ["agent-runtime"],
      capabilities: ["resource.agent-config"],
      contributions: [{ id: "agent-config.routes", kind: "app-route", value: { prefix: "/app/agents" } }],
      web: { id: "agent-config", contribution: { route: "/agents" } },
    },
  ];
}

describe("assembly profile", () => {
  // Agent 高耦合能力以单一 agentRuntime 槽位装配，旧字段不能形成第二套契约。
  test("使用 agentRuntime 字段选择单一 Agent Runtime 模块并拒绝旧字段", () => {
    const agentRuntimeProfile = {
      accessControl: "access-control",
      agentRuntime: "agent-runtime",
      webShell: "default",
      resources: ["agent-config"],
      web: ["agent-config"],
    };

    expect(parseAssemblyProfile(agentRuntimeProfile)).toEqual(agentRuntimeProfile);
    expect(() => parseAssemblyProfile({ ...agentRuntimeProfile, agent: "agent-runtime" })).toThrow("装配配置格式非法");
    expect(() => parseAssemblyProfile({ ...agentRuntimeProfile, runtime: "agent-runtime" })).toThrow(
      "装配配置格式非法",
    );
  });

  // 合法 profile 只保留稳定装配字段，不接受运行时代码入口。
  test("解析合法的静态装配 profile", () => {
    expect(parseAssemblyProfile(validProfile)).toEqual(validProfile);
  });

  // 未知字段可能携带路径、URL 或表达式，必须由 strict schema 整体拒绝。
  test("拒绝 profile 中的加载入口和未知字段", () => {
    expect(() => parseAssemblyProfile({ ...validProfile, import: "https://example.com/module.ts" })).toThrow(
      "装配配置格式非法",
    );
  });

  // 模块 ID 只允许稳定 slug，不能退化为路径、包名或 URL。
  test("拒绝危险模块 ID", () => {
    expect(() => parseAssemblyProfile({ ...validProfile, agentRuntime: "../runtime.ts" })).toThrow("装配配置格式非法");
    expect(() => parseAssemblyProfile({ ...validProfile, agentRuntime: "@vendor/runtime" })).toThrow(
      "装配配置格式非法",
    );
  });

  // 同一类别重复启用会破坏确定性装配，应在访问 registry 前失败。
  test("拒绝重复资源和 Web 模块", () => {
    expect(() => parseAssemblyProfile({ ...validProfile, resources: ["agent-config", "agent-config"] })).toThrow(
      "装配配置包含重复资源模块 ID",
    );
    expect(() => parseAssemblyProfile({ ...validProfile, web: ["agent-config", "agent-config"] })).toThrow(
      "装配配置包含重复 Web 模块 ID",
    );
  });
});

describe("module registry", () => {
  // profile 引用必须完全来自构建期 registry，未知 ID 不能触发动态发现。
  test("拒绝未知模块 ID", () => {
    const registry = createModuleRegistry(createManifests());
    expect(() => registry.resolveProfile({ ...validProfile, agentRuntime: "unknown-agent-runtime" })).toThrow(
      "装配配置引用了未注册模块: unknown-agent-runtime",
    );
  });

  // 单例类别必须和 profile 字段一致，避免用资源模块冒充平台实现。
  test("拒绝类别不匹配的模块", () => {
    const registry = createModuleRegistry(createManifests());
    expect(() => registry.resolveProfile({ ...validProfile, accessControl: "agent-config" })).toThrow(
      "模块 agent-config 必须是 access-control，实际为 resource",
    );
  });

  // 被 profile 选中的基础模块必须可创建，不能以缺失核心实例的状态继续启动。
  test("拒绝没有工厂的基础模块", () => {
    const manifests = createManifests().map((manifest) =>
      manifest.id === "access-control" ? { ...manifest, create: undefined } : manifest,
    );
    const registry = createModuleRegistry(manifests);
    expect(() => registry.resolveProfile(validProfile)).toThrow("基础模块 access-control 未提供创建工厂");
  });

  // manifest 的装配依赖必须显式出现在当前 profile 中，不能靠隐式 import 满足。
  test("拒绝未启用的 manifest 依赖", () => {
    const manifests = [
      ...createManifests(),
      {
        id: "standalone-agent-runtime",
        kind: "agent-runtime",
        dependsOn: [],
        create: () => ({ id: "standalone" }),
      },
    ] satisfies readonly ModuleManifest[];
    const registry = createModuleRegistry(manifests);
    expect(() => registry.resolveProfile({ ...validProfile, agentRuntime: "standalone-agent-runtime" })).toThrow(
      "模块 agent-config 依赖未启用模块 agent-runtime",
    );
  });

  // 同一独占 capability 只能由一个已启用 manifest 提供，替换必须通过 profile 完成。
  test("拒绝已启用模块的 capability 冲突", () => {
    const manifests = [
      ...createManifests(),
      {
        id: "agent-config-publication",
        kind: "resource",
        dependsOn: [],
        capabilities: ["resource.agent-config"],
      },
    ] satisfies readonly ModuleManifest[];
    const registry = createModuleRegistry(manifests);
    expect(() =>
      registry.resolveProfile({
        ...validProfile,
        resources: ["agent-config", "agent-config-publication"],
      }),
    ).toThrow("capability resource.agent-config 同时由 agent-config 与 agent-config-publication 提供");
  });
});

describe("module bootstrap", () => {
  // bootstrap 必须先汇总 env，再按依赖创建实例，最后挂载贡献。
  test("按固定阶段和依赖顺序装配模块", async () => {
    const events: string[] = [];
    const result = await bootstrapModules({
      profile: validProfile,
      manifests: createManifests(events),
      loadEnv: (definitions) => {
        events.push(`env:${definitions.map((definition) => definition.key).join(",")}`);
        return { AUTH_MODE: "session", UNDECLARED: "hidden" };
      },
      mountContribution: ({ contribution, manifest }) => {
        events.push(`mount:${manifest.id}:${contribution.id}`);
      },
    });

    expect(events).toEqual([
      "env:AUTH_MODE",
      "create:access:session",
      "create:agent-runtime:true",
      "mount:agent-config:agent-config.routes",
    ]);
    expect(result.modules.map((manifest) => manifest.id)).toEqual(["access-control", "agent-runtime", "agent-config"]);
    expect(result.instances.has("access-control")).toBeTrue();
    expect(result.webContributions.get("agent-config")).toEqual({ route: "/agents" });
  });

  // 正常关闭必须按资源获取的逆序执行，并允许宿主重复调用而不重复释放。
  test("提供幂等的逆序 dispose", async () => {
    const events: string[] = [];
    const lifecycleManifests = [
      {
        id: "access-control",
        kind: "access-control",
        dependsOn: [],
        create: ({ registerCleanup }) => {
          registerCleanup(() => events.push("dispose:access"));
          return { id: "access" };
        },
      },
      {
        id: "agent-runtime",
        kind: "agent-runtime",
        dependsOn: ["access-control"],
        create: ({ registerCleanup }) => {
          registerCleanup(() => events.push("dispose:runtime"));
          return { id: "runtime" };
        },
      },
    ] satisfies readonly ModuleManifest[];
    const result = await bootstrapModules({
      profile: { ...validProfile, resources: [], web: [] },
      manifests: lifecycleManifests,
      loadEnv: () => ({}),
    });

    await result.dispose();
    await result.dispose();

    expect(events).toEqual(["dispose:runtime", "dispose:access"]);
  });

  // 工厂可能在返回实例前已分配资源，失败时也必须回滚已登记的当前模块资源。
  test("工厂失败时逆序回滚全部已登记资源", async () => {
    const events: string[] = [];
    const lifecycleManifests = [
      {
        id: "access-control",
        kind: "access-control",
        dependsOn: [],
        create: ({ registerCleanup }) => {
          registerCleanup(() => events.push("dispose:access"));
          return { id: "access" };
        },
      },
      {
        id: "agent-runtime",
        kind: "agent-runtime",
        dependsOn: ["access-control"],
        create: ({ registerCleanup }) => {
          registerCleanup(() => events.push("dispose:runtime-partial"));
          throw new Error("runtime failed");
        },
      },
    ] satisfies readonly ModuleManifest[];

    await expect(
      bootstrapModules({
        profile: { ...validProfile, resources: [], web: [] },
        manifests: lifecycleManifests,
        loadEnv: () => ({}),
      }),
    ).rejects.toThrow("runtime failed");
    expect(events).toEqual(["dispose:runtime-partial", "dispose:access"]);
  });

  // 基础工厂返回空值等同于未创建实例，必须失败并清理已经分配的资源。
  test("基础工厂返回空实例时失败并回滚", async () => {
    const events: string[] = [];
    const lifecycleManifests = [
      {
        id: "access-control",
        kind: "access-control",
        dependsOn: [],
        create: ({ registerCleanup }) => {
          registerCleanup(() => events.push("dispose:access"));
          return { id: "access" };
        },
      },
      {
        id: "agent-runtime",
        kind: "agent-runtime",
        dependsOn: ["access-control"],
        create: ({ registerCleanup }) => {
          registerCleanup(() => events.push("dispose:runtime-partial"));
        },
      },
    ] satisfies readonly ModuleManifest[];

    await expect(
      bootstrapModules({
        profile: { ...validProfile, resources: [], web: [] },
        manifests: lifecycleManifests,
        loadEnv: () => ({}),
      }),
    ).rejects.toThrow("基础模块 agent-runtime 工厂未返回实例");
    expect(events).toEqual(["dispose:runtime-partial", "dispose:access"]);
  });

  // contribution 挂载失败不能遗留先前挂载项或模块实例持有的资源。
  test("贡献挂载失败时逆序回滚挂载项和模块", async () => {
    const events: string[] = [];
    const lifecycleManifests = [
      {
        id: "access-control",
        kind: "access-control",
        dependsOn: [],
        create: ({ registerCleanup }) => {
          registerCleanup(() => events.push("dispose:access"));
          return { id: "access" };
        },
      },
      {
        id: "agent-runtime",
        kind: "agent-runtime",
        dependsOn: ["access-control"],
        create: ({ registerCleanup }) => {
          registerCleanup(() => events.push("dispose:runtime"));
          return { id: "runtime" };
        },
      },
      {
        id: "agent-config",
        kind: "resource",
        dependsOn: ["agent-runtime"],
        contributions: [
          { id: "agent-config.routes", kind: "app-route", value: "routes" },
          { id: "agent-config.lifecycle", kind: "lifecycle", value: "lifecycle" },
        ],
      },
    ] satisfies readonly ModuleManifest[];

    await expect(
      bootstrapModules({
        profile: { ...validProfile, web: [] },
        manifests: lifecycleManifests,
        loadEnv: () => ({}),
        mountContribution: ({ contribution, registerCleanup }) => {
          if (contribution.id === "agent-config.lifecycle") throw new Error("mount failed");
          registerCleanup(() => events.push("dispose:routes"));
        },
      }),
    ).rejects.toThrow("mount failed");
    expect(events).toEqual(["dispose:routes", "dispose:runtime", "dispose:access"]);
  });
});
