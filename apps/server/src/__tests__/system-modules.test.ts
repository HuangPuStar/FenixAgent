import { expect, test } from "bun:test";
import { bootstrapModules, type ModuleManifest } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { loadAssemblyProfile } from "../assembly-config";
import { projectAssemblyModules } from "../bootstrap/assembly-modules";
import { createWebApp } from "../routes/web";

/** 复用真实声明但隔离数据库与上游工厂，测试装配选择和路由挂载而非业务服务初始化。 */
const manifests: readonly ModuleManifest[] = generatedModuleManifests.map((manifest) => ({
  ...manifest,
  create: () => ({}),
}));
const fixturePath = new URL("./fixtures/assembly-without-workflow.json", import.meta.url).pathname;
/** 浏览器面必需配置齐备时的环境；只影响 web 收窄，与模块工厂拿到的 `loadEnv` 互不替代。 */
const configuredEnv = { LANGBOT_BASE_URL: "http://langbot.test/api/v1" };

// 禁用 workflow-v2 时清单和路由贡献必须一起收窄，宿主端点不能跟着可选模块消失。
test("profile fixture 装载后清单与真实装配一致，workflow-v2 无路由挂载", async () => {
  const profile = await loadAssemblyProfile(fixturePath);
  const mounted: string[] = [];
  const assembly = await bootstrapModules({
    profile,
    manifests,
    loadEnv: () => ({}),
    mountContribution: ({ manifest, contribution }) => {
      if (contribution.kind === "app-route") mounted.push(manifest.id);
    },
  });
  try {
    const data = projectAssemblyModules(assembly, configuredEnv);
    const app = createWebApp({ web: [], webConfig: [] }, data);
    const response = await app.handle(new Request("http://localhost/web/system/modules"));
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: {
        modules: assembly.modules.filter((module) => module.kind === "resource").map((module) => module.id),
        web: profile.web,
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(data.modules).not.toContain("workflow-v2");
    expect(data.modules).not.toContain("identity");
    expect(data.web).not.toContain("workflow");
    expect(mounted).not.toContain("workflow-v2");
    expect(assembly.instances.has("workflow-v2")).toBe(false);
  } finally {
    await assembly.dispose();
  }
});

// 开启模块时返回 web.id 而不是说明符，且装配确实挂载其所有 app-route 贡献。
test("启用 workflow-v2 恢复 workflow web ID 与路由贡献", async () => {
  const fixture = await loadAssemblyProfile(fixturePath);
  const profile = { ...fixture, resources: [...fixture.resources, "workflow-v2"], web: [...fixture.web, "workflow"] };
  const mounted: string[] = [];
  const assembly = await bootstrapModules({
    profile,
    manifests,
    loadEnv: () => ({}),
    mountContribution: ({ manifest, contribution }) => {
      if (manifest.id === "workflow-v2") mounted.push(contribution.id);
    },
  });
  try {
    const data = projectAssemblyModules(assembly, configuredEnv);
    const app = createWebApp({ web: [], webConfig: [] }, data);
    const response = await app.handle(new Request("http://localhost/web/system/modules"));
    expect((await response.json()) as unknown).toEqual({ success: true, data });
    expect(data.web).toContain("workflow");
    expect(data.modules).toContain("workflow-v2");
    expect(data.web.every((id) => !id.includes("/") && !id.includes("@"))).toBe(true);
    expect(mounted).toEqual([
      "workflow-v2.web-control",
      "workflow-v2.external-api",
      "workflow-v2.canvas-bff",
      "workflow-v2.canvas-static",
    ]);
  } finally {
    await assembly.dispose();
  }
});

// 缺少 LangBot 基址时 channel 仍装配，但浏览器面必须收窄：侧栏入口与路由拦截共用这一份清单。
test("未配置 LANGBOT_BASE_URL 时 channel 从 web 收窄但保留在 modules", async () => {
  const profile = await loadAssemblyProfile(fixturePath);
  const assembly = await bootstrapModules({
    profile,
    manifests,
    loadEnv: () => ({}),
    mountContribution: () => undefined,
  });
  try {
    const missing = projectAssemblyModules(assembly, {});
    expect(missing.modules).toContain("channel");
    expect(missing.web).not.toContain("channel");
    expect(missing.web).toEqual(profile.web.filter((id) => id !== "channel"));

    // 端点必须把收窄结果原样发布：浏览器侧栏与路由门都只消费这一份清单。
    const app = createWebApp({ web: [], webConfig: [] }, missing);
    const response = await app.handle(new Request("http://localhost/web/system/modules"));
    const payload = (await response.json()) as { success: boolean; data: { web: string[] } };
    expect(payload.success).toBe(true);
    expect(payload.data.web).toEqual([...missing.web]);

    // compose 的 `${VAR:-}` 会透传空串与纯空白，二者同样按未配置处理。
    expect(projectAssemblyModules(assembly, { LANGBOT_BASE_URL: "   " }).web).not.toContain("channel");
    expect(projectAssemblyModules(assembly, configuredEnv).web).toContain("channel");
  } finally {
    await assembly.dispose();
  }
});

// 全部可选路由为空时元数据仍由宿主持有，不能退化成 404。
test("空资源装配仍可读取宿主端点", async () => {
  const app = new Elysia().use(createWebApp({ web: [], webConfig: [] }, { modules: [], web: [] }));
  const response = await app.handle(new Request("http://localhost/web/system/modules"));
  expect((await response.json()) as unknown).toEqual({ success: true, data: { modules: [], web: [] } });
});
