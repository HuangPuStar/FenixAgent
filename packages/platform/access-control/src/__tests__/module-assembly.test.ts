import { beforeEach, expect, test } from "bun:test";
import type { ModuleManifest } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { pgTable, varchar } from "drizzle-orm/pg-core";
import { moduleManifest } from "../../fenix.module";
import { DefaultAccessControl } from "../index";
import { ColumnResourceScopeStore } from "../scope/column-resource-scope-store";

/**
 * access-control 的 registry 装配契约。
 *
 * 这里锁定的是 `fenix.module.ts` 的 `create`：它必须是**真实例工厂**（产出三个授权端口），而不是
 * 早期那种「返回包命名空间」的占位形态——后者会让 registry 的 `instances` 里躺着一个不是装配结果的
 * 对象，资源模块再去 `context.modules` 取端口时拿到的就是命名空间。
 *
 * 资源绑定来自**声明**而不是实例：下面的 fixture 里 `assembly_probe` 由声明提供，装配序（本模块的
 * `dependsOn` 不含任何资源模块）因此不成环。
 */

const probeTable = pgTable("assembly_probe", {
  id: varchar("id", { length: 36 }).primaryKey(),
  organizationId: varchar("organization_id", { length: 36 }),
  visibility: varchar("visibility", { length: 20 }),
});

/** 一个声明了存储绑定的资源模块；内容只需满足 `ResourceStorageBinding` 的形状。 */
const declaringResourceManifest = {
  id: "assembly-probe",
  kind: "resource",
  dependsOn: [],
  accessControlBindings: [
    {
      resourceType: "assembly_probe",
      table: probeTable,
      columns: {
        id: probeTable.id,
        organizationId: probeTable.organizationId,
        visibility: probeTable.visibility,
      },
    },
  ],
} satisfies ModuleManifest;

const emptyDeclarations: readonly ModuleManifest[] = [];

beforeEach(() => {
  resetAllStubs();
});

// 工厂是真实例工厂：`context.modules` 里放的就是资源模块要取的那三个授权端口。
test("create 产出真实授权装配单元", async () => {
  initializeTestApplicationInfrastructure();

  const suite = await moduleManifest.create({
    env: {},
    modules: new Map(),
    declarations: emptyDeclarations,
    registerCleanup: () => {},
  });

  expect(suite.accessControl).toBeInstanceOf(DefaultAccessControl);
  expect(suite.scopeStore).toBeInstanceOf(ColumnResourceScopeStore);
});

// 绑定必须来自装配声明：声明中的资源被注册，未声明的资源直接报错（静默放宽授权是最坏的结果）。
test("资源绑定从装配声明收集，未声明即报错", async () => {
  initializeTestApplicationInfrastructure();

  const suite = await moduleManifest.create({
    env: {},
    modules: new Map(),
    declarations: [declaringResourceManifest],
    registerCleanup: () => {},
  });

  await expect(suite.scopeStore.getMany({ resourceType: "assembly_probe", resourceIds: [] })).resolves.toEqual(
    new Map(),
  );
  await expect(suite.scopeStore.getMany({ resourceType: "not_declared", resourceIds: [] })).rejects.toThrow(
    "资源 not_declared 未注册存储绑定，无法解析归属范围",
  );
});

// 宿主未完成基础设施初始化（未注册进程级 DB）时，工厂必须当场报错而不是留下半装配结果。
test("未初始化应用基础设施时拒绝装配", async () => {
  await expect(
    moduleManifest.create({
      env: {},
      modules: new Map(),
      declarations: emptyDeclarations,
      registerCleanup: () => {},
    }),
  ).rejects.toThrow("应用基础设施尚未初始化");
});
