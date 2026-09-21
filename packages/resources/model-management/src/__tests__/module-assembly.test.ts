import { beforeEach, expect, test } from "bun:test";
import type {
  AccessControlModule,
  AuthorizedResourceQuery,
  ModuleFactoryContext,
  ResourceScopeStore,
} from "@fenix/platform-sdk";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createModelManagementModule } from "../module";
import { providerResource } from "../server/access/provider-resource";
import { getModelManagementModule, resetModelManagementModule } from "../server/module-runtime";

/**
 * Model-management 的 registry 装配契约。
 *
 * 本包不 import `@fenix/access-control`（依赖矩阵禁止 `resources → platform-impl`），装配期只能按端口
 * 契约收窄 `context.modules` 里的实例；这里锁定「收窄后产出真实模块实例 + 装入进程级槽位」以及
 * 「端口缺失当场失败」两条（口径同 `@fenix/resource-mcp` 的同类用例）。
 *
 * 模型网关服务集（`ModelGatewayServices`）不在本工厂内：它由宿主在 `initModelGateway` 阶段装配。
 */

/** registry 会注入的 access-control 实例形状；本用例只验证装配，不触发端口行为。 */
const accessControlSuite = {
  accessControl: {} as AccessControlModule,
  scopeStore: {} as ResourceScopeStore,
  authorizedQuery: {} as AuthorizedResourceQuery,
};

function factoryContext(modules: ReadonlyMap<string, unknown>): ModuleFactoryContext {
  return { env: {}, modules, declarations: [], registerCleanup: () => {} };
}

beforeEach(() => {
  resetAllStubs();
  resetModelManagementModule();
});

// 工厂必须产出真实模块实例（而不是装配结果的命名空间包装）并装入进程级槽位：`/web/config/providers`
// 等路由与网关的 provider 同步都经 `getModelManagementModule()` 读同一份。
test("createModelManagementModule 产出真实例并装入进程级槽位", () => {
  const module = createModelManagementModule(factoryContext(new Map([["access-control", accessControlSuite]])));

  expect(module.resource).toBe(providerResource);
  expect(module.identity).toBeDefined();
  expect(getModelManagementModule()).toBe(module);
});

// 授权端口缺失必须当场失败：静默退让会让所有 Provider 端点以「资源不存在」响应，把装配故障伪装成业务结果。
test("access-control 未提供授权端口时拒绝装配", () => {
  expect(() =>
    createModelManagementModule(factoryContext(new Map([["access-control", { accessControl: {} }]]))),
  ).toThrow("access-control 模块未提供 accessControl / scopeStore / authorizedQuery");
});
