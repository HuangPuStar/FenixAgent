import {
  type AccessControlModule,
  type ActorContext,
  type IdentityDirectory,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceAccess,
  ResourceAccessDeniedError,
  type ResourceAction,
  type ResourceQueryConstraint,
  type ResourceScope,
  type ResourceScopeStore,
  type ResourceVisibility,
} from "@fenix/platform-sdk";
import { mcpServerResource } from "../server/access/mcp-server-resource";
import type { McpServerFacadeApi, McpServerListItem } from "../server/facades/mcp-server-facade";
import type { ScopedMcpServerRow } from "../server/repositories/mcp-server";
import type { McpServerService } from "../server/services/mcp-server-service";
import {
  createStubIdentityDirectory,
  createStubMcpFacade,
  createStubMcpServerModule,
  createStubMcpServerService,
  installMcpServerModule,
  resetMcpServerModuleForTesting,
} from "../server/testing";

/**
 * MCP 协议层与 Facade 测试的公共 fixture。
 *
 * 位置说明：这些构造只服务测试，因此留在 `__tests__/`，不加入 `@fenix/resource-mcp/server/testing`
 * 的对外面；后者只导出"替身工厂"这类消费方也会复用的接缝。
 */

/** 固定时间戳：让断言不依赖运行时刻。 */
export const FIXTURE_NOW = new Date("2026-08-19T00:00:00.000Z");

/** 构造可信主体；默认是 org-1 的 owner。 */
export function testActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: "user",
    userId: "user-1",
    activeOrganizationId: "org-1",
    memberships: [{ organizationId: "org-1", role: "owner" }],
    ...overrides,
  };
}

export interface ServerFixtureOptions {
  readonly id?: string;
  readonly name?: string;
  readonly organizationId?: string;
  readonly ownerUserId?: string;
  readonly visibility?: ResourceVisibility;
  readonly type?: string;
  readonly config?: unknown;
  readonly enabled?: boolean;
}

/** 构造带归属范围的资源行（Domain Service 的产出形状）。 */
export function scopedServer(options: ServerFixtureOptions = {}): ScopedMcpServerRow {
  const organizationId = options.organizationId ?? "org-1";
  const ownerUserId = options.ownerUserId ?? "user-1";
  const visibility = options.visibility ?? "private";
  return {
    id: options.id ?? "mcp-1",
    userId: ownerUserId,
    organizationId,
    name: options.name ?? "demo",
    type: options.type ?? "remote",
    config: options.config ?? { type: "remote", url: "https://mcp.example.test" },
    enabled: options.enabled ?? true,
    visibility,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    scope: { organizationId, ownerUserId, visibility },
  };
}

/** 构造带有效动作的列表项（Facade 的产出形状，`/web` 与 `/api` 视图的共同输入）。 */
export function authorizedServer(
  options: ServerFixtureOptions & {
    readonly actions?: readonly ResourceAction[];
    readonly toolsCount?: number;
  } = {},
): McpServerListItem {
  const row = scopedServer(options);
  return {
    ...row,
    access: { actions: options.actions ?? ["read", "create", "update", "delete", "use"] },
    toolsCount: options.toolsCount ?? 0,
  };
}

/** 装入资源模块替身；未打桩的方法调用即失败，避免路由调用了未预期的方法而断言失真。 */
export function installMcpModuleStub(
  deps: {
    readonly facade?: Partial<McpServerFacadeApi>;
    readonly service?: Partial<McpServerService>;
    readonly identity?: Partial<IdentityDirectory>;
  } = {},
): void {
  installMcpServerModule(
    createStubMcpServerModule({
      facade: createStubMcpFacade(deps.facade),
      service: createStubMcpServerService(deps.service),
      identity: createStubIdentityDirectory(deps.identity),
    }),
  );
}

/** 清除模块装配结果；测试结束必须调用，避免跨用例共享状态。 */
export function resetMcpModuleStub(): void {
  resetMcpServerModuleForTesting();
}

/** 构造平台授权条件句柄；形状与 `DefaultAccessControl` 产出的条件一致（含私有载荷键）。 */
export function testListConstraint(action: "read" | "use" = "read"): ResourceQueryConstraint {
  return {
    resourceType: mcpServerResource.definition.type,
    action,
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { action },
  };
}

/**
 * 授权实现替身：默认放行全部动作。
 *
 * Facade 用例只验证"授权编排"（何时调用、调用结果如何映射），权限规则本身由 `access-control` 的
 * 用例与谓词一致性 contract test 覆盖；因此这里默认全放行，拒绝路径由用例显式覆盖。
 */
export function createFakeAccessControl(overrides: Partial<AccessControlModule> = {}): AccessControlModule {
  const allActions: readonly ResourceAction[] = ["read", "create", "update", "delete", "use"];
  const access: ResourceAccess = { actions: allActions };
  return {
    id: "test-access-control",
    resolveInitialScope: async ({ actor }) => {
      if (actor.activeOrganizationId === undefined) {
        throw new ResourceAccessDeniedError("当前主体无权创建该资源");
      }
      return { organizationId: actor.activeOrganizationId, ownerUserId: actor.userId, visibility: "private" };
    },
    initializeResourceAccess: async () => undefined,
    authorize: async () => undefined,
    createListConstraint: async ({ action }) => testListConstraint(action),
    resolveAccess: async () => access,
    resolveAccessMany: async ({ resourceIds }) => new Map(resourceIds.map((id) => [id, access])),
    ...overrides,
  };
}

/** 构造并记录调用的 scope store 替身；`update` 的入参是 `visibility` 变更的断言点。 */
export function createRecordingScopeStore(initial: ResourceScope = { visibility: "private" }): {
  readonly store: ResourceScopeStore;
  readonly updates: ResourceScope[];
} {
  const updates: ResourceScope[] = [];
  return {
    store: {
      initialize: async () => undefined,
      getMany: async ({ resourceIds }) => new Map(resourceIds.map((id) => [id, initial])),
      update: async (input) => {
        updates.push(input.scope);
      },
      remove: async () => undefined,
    },
    updates,
  };
}

/**
 * 抛出平台授权拒绝错误（与实现抛出的类型一致），用来覆盖 Facade 的 403 映射。
 *
 * 返回类型是 `never`，因此可直接写成 `authorize: async () => denied()`。
 */
export function denied(): never {
  throw new ResourceAccessDeniedError("当前主体无权执行资源动作");
}
