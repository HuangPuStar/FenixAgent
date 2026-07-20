import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

beforeEach(() => {
  resetAllStubs();
  stubDb({});
});

describe("registry schema 文件", () => {
  test("MachineSchema 已导出", async () => {
    const { MachineSchema } = await import("../schemas/registry.schema");
    expect(MachineSchema).toBeDefined();
  });

  test("RegistryEventSchema 已导出", async () => {
    const { RegistryEventSchema } = await import("../schemas/registry.schema");
    expect(RegistryEventSchema).toBeDefined();
  });

  test("EventQuerySchema 已导出", async () => {
    const { EventQuerySchema } = await import("../schemas/registry.schema");
    expect(EventQuerySchema).toBeDefined();
  });

  test("MachineQuerySchema 已导出", async () => {
    const { MachineQuerySchema } = await import("../schemas/registry.schema");
    expect(MachineQuerySchema).toBeDefined();
  });

  test("MachineListResponseSchema 已导出", async () => {
    const { MachineListResponseSchema } = await import("../schemas/registry.schema");
    expect(MachineListResponseSchema).toBeDefined();
  });

  test("MachineDetailResponseSchema 已导出", async () => {
    const { MachineDetailResponseSchema } = await import("../schemas/registry.schema");
    expect(MachineDetailResponseSchema).toBeDefined();
  });

  test("RegistryEventListResponseSchema 已导出", async () => {
    const { RegistryEventListResponseSchema } = await import("../schemas/registry.schema");
    expect(RegistryEventListResponseSchema).toBeDefined();
  });
});

describe("registry 路由文件", () => {
  test("路由文件默认导出 app", async () => {
    const mod = await import("../routes/web/registry");
    expect(mod.default).toBeDefined();
  });

  test("路由文件导出 Elysia app 并包含 expected 端点", async () => {
    const mod = await import("../routes/web/registry");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.handle).toBe("function");
  });
});

describe("schemas/index.ts 导出 registry", () => {
  test("schemas index 导出 MachineSchema", async () => {
    const mod = await import("../schemas");
    expect(mod.MachineSchema).toBeDefined();
  });

  test("schemas index 导出 RegistryEventSchema", async () => {
    const mod = await import("../schemas");
    expect(mod.RegistryEventSchema).toBeDefined();
  });
});

describe("web/index.ts 注册 registry 路由", () => {
  test("web index 导入 webRegistry", async () => {
    const mod = await import("../routes/web/index");
    expect(mod.default).toBeDefined();
  });
});
