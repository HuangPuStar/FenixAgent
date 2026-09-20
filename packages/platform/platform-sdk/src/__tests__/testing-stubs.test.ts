import { afterEach, describe, expect, test } from "bun:test";
import { getDatabase, getModuleConfig } from "../server";
import {
  createStubRegistry,
  getAuthApiStub,
  getDbStub,
  getIdentityDirectoryStub,
  getModuleConfigStub,
  initializeTestApplicationInfrastructure,
  readJson,
  registerModuleConfigBaseline,
  registerTestIdentityDirectory,
  resetAllStubs,
  stubAuthApi,
  stubDb,
  stubIdentityDirectory,
  stubModuleConfig,
} from "../testing";

afterEach(() => {
  resetAllStubs();
});

describe("createStubRegistry", () => {
  // 未登记且要求抛错时必须在读取点报错，而不是把 undefined 交给被测代码。
  test("默认在读取未登记函数时抛错", () => {
    const registry = createStubRegistry("demo");
    expect(() => registry.get("missing")).toThrow("demo stub 'missing' not configured");

    registry.stub({ find: () => "value" });
    expect(registry.get("find")()).toBe("value");
    expect(registry.has("find")).toBe(true);
  });

  // preload 期注册的转发代理会被不相关用例读取，此时回退空函数而不是抛错。
  test("throwOnMissing=false 时未登记返回空函数", () => {
    const registry = createStubRegistry("demo", false);
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("missing")()).toBeUndefined();
  });

  // reset 必须清空全部替身，否则上一条用例的函数会泄漏到下一条。
  test("reset 清空已登记函数", () => {
    const registry = createStubRegistry("demo");
    registry.stub({ find: () => "value" });
    registry.reset();

    expect(registry.has("find")).toBe(false);
    expect(() => registry.get("find")).toThrow("not configured");
  });
});

describe("DB 替身", () => {
  // 未登记时返回空对象：宿主 preload 的 mock 工厂会立即求值，抛错会让测试进程启动失败。
  test("未登记时返回空对象", () => {
    expect(getDbStub()).toEqual({});
  });

  // 登记与复位必须成对生效，用例之间不得共享 DB 对象。
  test("登记后可读、复位后清空", () => {
    const db = { select: () => "row" };
    stubDb(db);
    expect(getDbStub()).toBe(db);

    resetAllStubs();
    expect(getDbStub()).toEqual({});
  });
});

describe("模块配置替身", () => {
  // 基线承载生产默认值，用例覆盖只做浅合并，未覆盖字段保持默认。
  test("覆盖浅合并到基线之上", () => {
    registerModuleConfigBaseline("demo-module", { host: "http://prod", disableSignup: false });
    stubModuleConfig("demo-module", { host: "http://test" });

    expect(getModuleConfigStub<{ host: string; disableSignup: boolean }>("demo-module")).toEqual({
      host: "http://test",
      disableSignup: false,
    });
  });

  // 复位只清用例覆盖：基线是 preload 期登记的生产默认值，清掉会让后续用例读到空配置。
  test("resetAllStubs 保留基线、清空用例覆盖", () => {
    registerModuleConfigBaseline("demo-module", { host: "http://prod" });
    stubModuleConfig("demo-module", { host: "http://test" });
    resetAllStubs();

    expect(getModuleConfigStub<{ host: string }>("demo-module")).toEqual({ host: "http://prod" });
  });

  // 未登记配置的模块读取必须失败，与 getModuleConfig 对未声明模块的严格性一致。
  test("读取未登记的模块配置失败", () => {
    expect(() => getModuleConfigStub("never-registered")).toThrow("模块 never-registered 的测试配置未登记");
  });
});

describe("身份目录替身", () => {
  // 默认值取空投影：未声明的身份数据要让用例立即察觉缺失。
  test("默认返回空投影", async () => {
    const directory = getIdentityDirectoryStub();
    expect(await directory.getUser("user-1")).toBeUndefined();
    expect(await directory.listOrganizationNames()).toEqual(new Map());

    stubIdentityDirectory({ getUser: async () => ({ name: "张三" }) });
    expect(await getIdentityDirectoryStub().getUser("user-1")).toEqual({ name: "张三" });
  });

  // 系统托管租户的 userId 是审计主体，未声明时必须抛错而不是返回假身份。
  test("resolveSystemTenant 未声明时抛错", () => {
    expect(() => getIdentityDirectoryStub().resolveSystemTenant()).toThrow("未在测试中 stub");
  });

  // 宿主 preload 已注册转发代理，重复注册必须被 registerIdentityDirectory 的严格语义拒绝。
  test("重复注册身份目录抛错", () => {
    expect(() => registerTestIdentityDirectory()).toThrow("身份目录已注册");
  });
});

describe("认证入口替身", () => {
  // 读取未登记的 auth.api 方法必须抛错，避免路由用例拿到 undefined 后在别处失败。
  test("读取未登记方法抛错", () => {
    expect(() => getAuthApiStub("getSession")).toThrow("auth.api stub 'getSession' not configured");

    stubAuthApi({ getSession: () => ({ user: { id: "user-1" } }) });
    expect(getAuthApiStub("getSession")()).toEqual({ user: { id: "user-1" } });
  });

  // 复位后方法必须回到未登记状态，防止会话在用例之间泄漏。
  test("resetAllStubs 清空认证替身", () => {
    stubAuthApi({ getSession: () => null });
    resetAllStubs();

    expect(() => getAuthApiStub("getSession")).toThrow("not configured");
  });
});

describe("应用基础设施初始化辅助", () => {
  // 显式传入的 DB 替身与模块配置必须能从生产读取入口读到。
  test("以替身初始化后可按契约读取 DB 与模块配置", () => {
    const database = { kind: "db-stub" };
    initializeTestApplicationInfrastructure({
      database,
      moduleConfigs: { "demo-module": { host: "http://test" } },
    });

    expect(getDatabase()).toBe(database);
    expect(getModuleConfig<{ host: string }>("demo-module")).toEqual({ host: "http://test" });
  });

  // 缺省 database 取当前 DB 替身，避免用例把同一个替身登记两遍导致两处漂移。
  test("缺省使用已登记的 DB 替身", () => {
    const db = { select: () => "row" };
    stubDb(db);
    initializeTestApplicationInfrastructure();

    expect(getDatabase()).toBe(db);
  });

  // 重复初始化必须与 initializeApplicationInfrastructure 同样失败，测试不得静默共享基础设施。
  test("拒绝重复初始化", () => {
    initializeTestApplicationInfrastructure({ database: {} });
    expect(() => initializeTestApplicationInfrastructure({ database: {} })).toThrow("应用基础设施已初始化");
  });

  // resetAllStubs 复位基础设施后必须允许下一条用例重新初始化。
  test("resetAllStubs 后可重新初始化", () => {
    initializeTestApplicationInfrastructure({ database: {} });
    resetAllStubs();

    expect(() => initializeTestApplicationInfrastructure({ database: {} })).not.toThrow();
  });
});

describe("readJson", () => {
  // 响应按运行时 JSON 值读取，测试不被路由声明的窄响应类型限制。
  test("读取响应 JSON", async () => {
    const response = new Response(JSON.stringify({ success: true, data: { id: "s-1" } }), {
      headers: { "content-type": "application/json" },
    });

    expect(await readJson(response)).toEqual({ success: true, data: { id: "s-1" } });
  });
});
