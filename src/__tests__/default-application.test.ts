import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createLogger } from "@fenix/logger";
import { createDefaultApplication } from "../application/create-default-application";
import type { DefaultApplicationOptions } from "../application/default-app-options";
import { type AppConfig, applyEnv, config, setConfig } from "../config";
import { validateEnv } from "../env";

type Assert<TValue extends true> = TValue;
type RouteKeys<TApp> = TApp extends { "~Routes": infer TRoutes } ? keyof TRoutes : never;
type HasRoute<TApp, TRouteKey extends string> = TRouteKey extends RouteKeys<TApp> ? true : false;
type LacksRoute<TApp, TRouteKey extends string> = TRouteKey extends RouteKeys<TApp> ? false : true;

const originalConfig: AppConfig = { ...config };
const originalRequiredEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  RCS_API_KEYS: process.env.RCS_API_KEYS,
};
let options: DefaultApplicationOptions;

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:5432/test";
  process.env.RCS_API_KEYS = "test-skill-signing-key";
  process.env.NODE_ENV = "test";
  const env = validateEnv();
  applyEnv(env);
  options = {
    env,
    config,
    logger: createLogger("default-application-test"),
    startedAt: "2026-09-04T00:00:00.000Z",
  };
});

afterAll(() => {
  setConfig(originalConfig);
  restoreEnv("DATABASE_URL", originalRequiredEnv.DATABASE_URL);
  restoreEnv("RCS_API_KEYS", originalRequiredEnv.RCS_API_KEYS);
  restoreEnv("NODE_ENV", originalRequiredEnv.NODE_ENV);
});

describe("community default application", () => {
  // 构造默认应用不能监听端口或注册进程信号，外部资源只能在 start 后创建。
  test("constructs without process lifecycle side effects", async () => {
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");

    const runtime = createDefaultApplication(options);

    expect(runtime.state).toBe("created");
    expect(runtime.app.server).toBeNull();
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    await runtime.stop();
  });

  // 默认 Profile 必须通过单一过渡模块保留完整社区路由及原有最终兼容路由顺序。
  test("keeps the complete community route tree", async () => {
    const runtime = createDefaultApplication(options);
    const paths = runtime.app.routes.map((route) => route.path);
    const hasHealth: Assert<HasRoute<typeof runtime.app, "health">> = true;
    const hasWeb: Assert<HasRoute<typeof runtime.app, "web">> = true;
    const hasApi: Assert<HasRoute<typeof runtime.app, "api">> = true;
    const excludesUnknown: Assert<LacksRoute<typeof runtime.app, "not-registered">> = true;

    expect([hasHealth, hasWeb, hasApi, excludesUnknown]).toEqual([true, true, true, true]);
    expect(paths).toContain("/web/channels/providers");
    expect(paths).toContain("/web/agent-sites/apps");
    expect(paths).toContain("/web/site/deploy/:appId");
    expect(paths.at(-1)).toBe("/*");
    await runtime.stop();
  });

  // 过渡模块必须保持原入口的生产启动顺序，避免迁移时静默改变依赖时序。
  test("keeps the legacy startup order", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "../application/modules/legacy-community-module.ts")).text();
    const startSource = source.slice(source.indexOf("async start("), source.indexOf("return () =>"));
    const orderedCalls = [
      "initDb(",
      "registerConfiguredSandboxProviders(",
      "ensureSystemAdmin(",
      "runDataMigrations(",
      "createModelGatewayRuntime(",
      "initializeDefaultSandboxPool(",
      "sandboxManager.recoverAfterRestart(",
      "initCoreRuntime(",
      "schedulerService.start(",
      "syncBuiltin(",
      "initCustomToolsRegistry(",
      "initHermesClient(",
      "checkRagFlowHealth(",
      "startMachineSweep(",
      "startFileWsSweep(",
      "startAcpIdleMonitor(",
    ] as const;
    let previousIndex = -1;

    for (const call of orderedCalls) {
      const currentIndex = startSource.indexOf(call);
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
  });

  // 现有 Web 聚合中的路由必须继续进入同一份 OpenAPI 文档。
  test("keeps aggregated Web routes in OpenAPI", async () => {
    const runtime = createDefaultApplication(options);
    const response = await runtime.app.handle(new Request("http://localhost/docs/openapi/web/json"));
    const spec = (await response.json()) as { paths?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(spec.paths?.["/web/channels/providers"]).toBeDefined();
    expect(spec.paths?.["/web/agent-sites/apps"]).toBeDefined();
    await runtime.stop();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
