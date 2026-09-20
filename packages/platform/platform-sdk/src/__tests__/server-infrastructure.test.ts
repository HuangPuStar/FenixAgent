import { afterEach, describe, expect, test } from "bun:test";
import {
  getDatabase,
  getModuleConfig,
  getRedisConnection,
  initializeApplicationInfrastructure,
  overrideModuleConfig,
  resetApplicationInfrastructure,
} from "../server";

afterEach(() => {
  resetApplicationInfrastructure();
});

describe("application infrastructure", () => {
  // 模块早于宿主初始化读取基础设施属于装配错误，必须显式报错而不是返回 undefined。
  //
  // 模块 ID 必须用宿主 preload 永不登记的哨兵值（下面第 2 条用例的 `access-control` 与初始化用例里的
  // 模块 ID 只是普通示例）。宿主测试进程的 `@fenix/platform-sdk/server` 替身会把**已登记**模块的读取
  // 回退到替身基线（`apps/server/src/test-utils/setup-mocks.ts` 的 `getModuleConfig` 包装），因此任何真实
  // 模块 ID——包括 1.4 W1 起登记了基线的 `agent-runtime`——在这里都读不出「未初始化」这一状态，
  // 断言会静默失去意义（实测：用 `agent-runtime` 时本用例由失败变为读到基线值）。
  //
  // `getRedisConnection()` 的同类契约无法在此断言，原因同上：宿主 preload 的替身对 Redis 也接了
  // 「未初始化回退到宿主 `services/cache`」的 seam（否则测试进程里 DocManager 与会话快照路径会全线
  // 抛错），实测该断言读到的是替身回退值 `null` 而不是错误。契约由同一个 `requireInfrastructure()`
  // 保证，与上面两条断言同一条实现路径。
  test("未初始化时读取 DB 与模块配置都失败", () => {
    expect(() => getDatabase()).toThrow("应用基础设施尚未初始化");
    expect(() => getModuleConfig("never-registered-module")).toThrow("应用基础设施尚未初始化");
  });

  // 宿主唯一初始化后，DB 与各模块配置按模块 ID 精确可读。
  test("按模块 ID 读取已注册的配置和 DB", () => {
    const database = { kind: "database" };
    initializeApplicationInfrastructure({
      database,
      moduleConfigs: { "agent-runtime": { SANDBOX_URL: "http://sandbox" } },
      redisConnection: null,
    });

    expect(getDatabase()).toBe(database);
    expect(getModuleConfig<{ SANDBOX_URL: string }>("agent-runtime")).toEqual({ SANDBOX_URL: "http://sandbox" });
  });

  // Redis 是可选基础设施：声明 null 表示本进程不用它，读取得到 null 而不是抛错。provider 每次读取
  // 都重新调用——宿主的 cache.ts 首次 getCache() 才建连，注册期取值会把「未连」固化成永久 null。
  test("Redis provider 声明 null 时读取为 null，且每次读取都重新取值", () => {
    let connection: unknown = null;
    initializeApplicationInfrastructure({
      database: {},
      moduleConfigs: {},
      redisConnection: () => connection,
    });

    expect(getRedisConnection()).toBeNull();

    // 模拟宿主首次 getCache() 后完成建连：同一份基础设施应能读到新连接，无需重新初始化。
    connection = { kind: "redis" };
    expect(getRedisConnection()).toEqual({ kind: "redis" });
  });

  // 一个进程只允许一个 DB client 和一套配置，重复初始化必须失败。
  test("拒绝重复初始化", () => {
    initializeApplicationInfrastructure({ database: {}, moduleConfigs: {}, redisConnection: null });
    expect(() =>
      initializeApplicationInfrastructure({ database: {}, moduleConfigs: {}, redisConnection: null }),
    ).toThrow("应用基础设施已初始化，禁止重复初始化");
  });

  // 未声明配置的模块不得回退到 process.env 或默认值，必须失败。
  test("读取未声明的模块配置失败", () => {
    initializeApplicationInfrastructure({ database: {}, moduleConfigs: {}, redisConnection: null });
    expect(() => getModuleConfig("unknown-module")).toThrow("模块 unknown-module 未声明应用基础设施配置");
  });

  // 测试覆盖只能替换目标模块，不能污染其他模块或未初始化状态。
  test("覆盖单个模块配置不影响其他模块", () => {
    initializeApplicationInfrastructure({
      database: {},
      moduleConfigs: { "agent-runtime": { SANDBOX_URL: "http://sandbox" }, "access-control": { AUTH_MODE: "session" } },
      redisConnection: null,
    });

    overrideModuleConfig("agent-runtime", { SANDBOX_URL: "http://test-sandbox" });

    expect(getModuleConfig("agent-runtime")).toEqual({ SANDBOX_URL: "http://test-sandbox" });
    expect(getModuleConfig("access-control")).toEqual({ AUTH_MODE: "session" });
  });

  // 未初始化时覆盖配置会掩盖忘记初始化，必须直接失败。
  test("未初始化时覆盖模块配置失败", () => {
    expect(() => overrideModuleConfig("agent-runtime", {})).toThrow("应用基础设施尚未初始化");
  });

  // reset 必须让状态完全回到未初始化，测试之间才能隔离。
  test("reset 后回到未初始化状态", () => {
    initializeApplicationInfrastructure({
      database: {},
      moduleConfigs: { "agent-runtime": {} },
      redisConnection: null,
    });
    resetApplicationInfrastructure();

    expect(() => getDatabase()).toThrow("应用基础设施尚未初始化");
    expect(() =>
      initializeApplicationInfrastructure({ database: {}, moduleConfigs: {}, redisConnection: null }),
    ).not.toThrow();
  });
});
