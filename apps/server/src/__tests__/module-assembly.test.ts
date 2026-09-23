import { expect, test } from "bun:test";
import { createModuleRegistry, loadDeclaredEnv, type ModuleManifest } from "@fenix/platform-sdk";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { loadAssemblyProfile } from "../assembly-config";
import { bootstrapServerAssembly } from "../bootstrap";

/**
 * 该测试锁定的是 1.1 的最小闭环：受版本控制的 `deploy/assembly/ce.json`、构建期生成的
 * `apps/generated/module-registry.ts` 与宿主装配入口三者必须真实自洽。
 *
 * 与 `bootstrap.test.ts` 的分工：那里用注入的合成 manifest 验证契约与错误路径；这里用真实
 * 产物验证「发布版本今天真的能装起来」。
 */

/**
 * server 侧实例化顺序：三个基础模块按 profile 声明顺序展开，资源模块按 `dependsOn` 拓扑序跟进
 * （1.5e 起 `resources` 由真实 ce.json 驱动），Web Shell 不参与。
 *
 * 资源模块是全量发布组合的 14 个（不是「谁被迁移谁才启用」）：宿主手写挂载逐包迁入贡献面后，未启用的
 * 模块其路由会随手写挂载一起消失，因此启用范围必须先于迁移到位。跨类别顺序（machine 早于 sandbox，
 * agent-config 早于 model-management）由各自 `dependsOn` 决定，不按字母序；同为 `dependsOn: []` 的
 * 叶子模块（knowledge…workflow、plugin-market）保持 ce.json 的声明序。
 */
const EXPECTED_SERVER_MODULES = [
  ["identity", "identity"],
  ["access-control", "access-control"],
  ["agent-runtime", "agent-runtime"],
  ["knowledge", "resource"],
  ["mcp", "resource"],
  ["memory", "resource"],
  ["skill", "resource"],
  ["agent-config", "resource"],
  ["channel", "resource"],
  ["machine", "resource"],
  ["model-management", "resource"],
  ["observer", "resource"],
  ["plugin-market", "resource"],
  ["prod-view", "resource"],
  ["sandbox", "resource"],
  ["task", "resource"],
  ["workflow", "resource"],
];

/** 真实 registry 里由 `apps/web/fenix.module.ts` 提供的纯元数据 Shell 描述符。 */
const generatedWebShellManifests = generatedModuleManifests.filter((manifest) => manifest.kind === "web-shell");

/**
 * registry 产出的契约视图。
 *
 * 生成物用 `as const satisfies` 保留各 manifest 的字面量类型，联合类型上访问不到「只有部分模块声明」
 * 的可选字段（如 `accessControlBindings`）；按契约面收窄后，用例读到的就是宿主装配入口读的那份类型。
 */
const contractManifests: readonly ModuleManifest[] = generatedModuleManifests;

// 真实 ce.json 必须能被真实生成的 registry 解析，否则发布组合在启动前就不可用。
test("真实 profile 与生成的 registry 可解析", async () => {
  const profile = await loadAssemblyProfile();
  const resolved = createModuleRegistry(generatedModuleManifests).resolveProfile(profile);

  expect(resolved.modules.map((manifest) => [manifest.id, manifest.kind])).toEqual(EXPECTED_SERVER_MODULES);
  // Shell 是应用级组合：registry 只校验 ID 与类别，不把它交给 server 实例化。
  expect(profile.webShell).toBe("default");
  expect(resolved.modules.every((manifest) => manifest.id !== profile.webShell)).toBe(true);
});

// 宿主入口必须读真实 ce.json，按依赖序实例化，并在关闭时逆序释放且可重复调用。
test("bootstrapServerAssembly 按依赖序装配并逆序幂等释放", async () => {
  const events: string[] = [];
  const lifecycleManifests = [
    {
      id: "identity",
      kind: "identity",
      dependsOn: [],
      contributions: [{ id: "identity.routes", kind: "app-route", value: "identity-routes" }],
      create: ({ registerCleanup }) => {
        events.push("create:identity");
        registerCleanup(() => {
          events.push("dispose:identity");
        });
        return { id: "identity" };
      },
    },
    {
      id: "access-control",
      kind: "access-control",
      dependsOn: [],
      contributions: [{ id: "access-control.routes", kind: "app-route", value: "access-routes" }],
      create: ({ registerCleanup }) => {
        events.push("create:access-control");
        registerCleanup(() => {
          events.push("dispose:access-control");
        });
        return { id: "access-control" };
      },
    },
    {
      id: "agent-runtime",
      kind: "agent-runtime",
      dependsOn: ["access-control"],
      contributions: [{ id: "agent-runtime.routes", kind: "app-route", value: "runtime-routes" }],
      create: ({ registerCleanup }) => {
        events.push("create:agent-runtime");
        registerCleanup(() => {
          events.push("dispose:agent-runtime");
        });
        return { id: "agent-runtime" };
      },
    },
  ] satisfies readonly ModuleManifest[];

  const result = await bootstrapServerAssembly({
    // Shell 槽位取真实 profile 的绑定，但 profile 的 `resources` 与 `web` 由本用例自己声明——fixture 工厂
    // 只覆盖三个基础模块，真实 ce.json 的资源列表与 web 列表都会引用未注册进 fixture 的模块。
    profile: { ...(await loadAssemblyProfile()), resources: [], web: [] },
    // 真实 Shell 描述符 + fixture 基础模块工厂：真实 Runtime 工厂会拉起整套服务端运行面。
    manifests: [...lifecycleManifests, ...generatedWebShellManifests],
    loadEnv: (definitions) => loadDeclaredEnv(definitions, {}),
    preflight: ({ modules }) => {
      events.push(`preflight:${modules.map((manifest) => manifest.id).join(",")}`);
    },
    mountContribution: ({ contribution }) => {
      events.push(`mount:${contribution.id}`);
    },
  });

  expect(events).toEqual([
    "preflight:identity,access-control,agent-runtime",
    "create:identity",
    "create:access-control",
    "create:agent-runtime",
    "mount:identity.routes",
    "mount:access-control.routes",
    "mount:agent-runtime.routes",
  ]);
  expect(result.profile.webShell).toBe("default");
  expect(result.modules.map((manifest) => manifest.id)).toEqual(["identity", "access-control", "agent-runtime"]);

  await result.dispose();
  expect(events.slice(-3)).toEqual(["dispose:agent-runtime", "dispose:access-control", "dispose:identity"]);

  // 宿主可能同时从信号处理和错误路径触发关闭，重复 dispose 不得重复释放资源。
  await result.dispose();
  expect(events.slice(-3)).toEqual(["dispose:agent-runtime", "dispose:access-control", "dispose:identity"]);
});

// 授权绑定只从声明面收集（§1.5f 起宿主不再手写 `bindings` 列表）：五个受控资源主表必须各自声明
// 自己的 `storage`，漏声明的那一个会在运行期以「未注册存储绑定」报错，而不是静默放宽授权范围。
test("受控资源 manifest 各自声明存储绑定", async () => {
  const declaredTypes = contractManifests
    .flatMap((manifest) => manifest.accessControlBindings ?? [])
    .map((binding) => binding.resourceType)
    .sort();

  expect(declaredTypes).toEqual(["agent_config", "mcp_server", "plugin_market_package", "provider", "skill"]);
});

// profile 引用了未编译进 registry 的 Shell 时，必须在执行任何工厂前失败。
test("profile 引用未注册的 Web Shell 时拒绝装配", async () => {
  const profile = await loadAssemblyProfile();

  await expect(
    bootstrapServerAssembly({
      profile: { ...profile, webShell: "missing-shell" },
      manifests: generatedModuleManifests,
      loadEnv: (definitions) => loadDeclaredEnv(definitions, {}),
    }),
  ).rejects.toThrow("装配配置引用了未注册模块: missing-shell");
});

// Shell 类别不能被其他基础模块顶替，否则 server 会开始实例化前端组合。
test("Shell 绑定到非 web-shell 类别时拒绝装配", async () => {
  const profile = await loadAssemblyProfile();

  await expect(
    bootstrapServerAssembly({
      profile: { ...profile, webShell: "agent-runtime" },
      manifests: generatedModuleManifests,
      loadEnv: (definitions) => loadDeclaredEnv(definitions, {}),
    }),
  ).rejects.toThrow("模块 agent-runtime 必须是 web-shell，实际为 agent-runtime");
});
