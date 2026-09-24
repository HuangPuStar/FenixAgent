import {
  type AccessControlModule,
  type ActorContext,
  type IdentityDirectory,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceAccess,
  ResourceAccessDeniedError,
  type ResourceAction,
  type ResourceQueryConstraint,
  type SystemTenant,
} from "@fenix/platform-sdk";
import { pluginPackageResource } from "../server/access/plugin-package-resource";
import type { PackageDetailView, PackageView } from "../server/domain/package-view";
import { toPackageSlug } from "../server/domain/slug";
import type { PluginPackageFacadeApi } from "../server/facades/plugin-package-facade";
import { installPluginMarketModule, resetPluginMarketModule } from "../server/runtime";
import type { CatalogReadScope, PluginPackageService } from "../server/services/plugin-package-service";
import { TEST_OPERATOR_USER_ID, TEST_ORGANIZATION_ID, TEST_PACKAGE_NAME, TEST_SOURCE_ID } from "./catalog-harness";

/**
 * Facade 与协议层用例的公共夹具。
 *
 * 三件事都在这里、且只在这里定义：**系统托管租户**、**平台授权替身**、**目录读取替身**。前两者是应用层的两个
 * 外部世界（身份目录与授权模块），第三者让读路径不必连库。
 *
 * 授权替身**复刻了真实策略里与本模块有关的那一条**（组织分支要求「归属组织 = 主体 active organization」且角色
 * 属于 owner/admin），而不是「一律放行」：浏览面的读谓词由它产出，替身若一律放行，用例会把「越权主体也看得见」
 * 判成通过。规则本身仍由 `@fenix/access-control` 的用例覆盖，这里不重新推导它的其它分支（`visibility`、公开
 * 受众、个人归属）。
 */

/** 系统托管租户；市场条目的归属组织固定为它（`access/plugin-package-resource.ts` 的文件头解释了这条）。 */
export const SYSTEM_TENANT: SystemTenant = {
  organizationId: TEST_ORGANIZATION_ID,
  organizationSlug: "system",
  userId: TEST_OPERATOR_USER_ID,
  email: "system@example.test",
};

/** 平台系统管理员：active organization 就是系统租户，且在该组织里是 owner——管理面写入的归属与审计主体取自它。 */
export function systemAdminActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: "user",
    userId: "user-admin",
    activeOrganizationId: SYSTEM_TENANT.organizationId,
    memberships: [{ organizationId: SYSTEM_TENANT.organizationId, role: "owner" }],
    ...overrides,
  };
}

/**
 * 普通成员：在系统租户里只是 member。
 *
 * 浏览面（`/web/config/plugin-market/*`）对任意已认证主体开放，因此这个主体也能读——它不再有任何写路径
 * （管理面收系统 API Key，`facades/plugin-package-facade.ts` 的文件头）。
 */
export function memberActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return systemAdminActor({
    userId: "user-member",
    memberships: [{ organizationId: SYSTEM_TENANT.organizationId, role: "member" }],
    ...overrides,
  });
}

/** 另一个组织的成员：既不是系统租户的人，也没有它的角色。 */
export function outsiderActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: "user",
    userId: "user-outsider",
    activeOrganizationId: "org-other",
    memberships: [{ organizationId: "org-other", role: "owner" }],
    ...overrides,
  };
}

/** 构造平台授权条件句柄；形状与真实实现产出的一致（含私有载荷键，业务模块只能透传）。 */
export function testListConstraint(action: "read" | "use" = "read"): ResourceQueryConstraint {
  return {
    resourceType: pluginPackageResource.definition.type,
    action,
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { action },
  };
}

/**
 * 授权模块替身。
 *
 * `resolveInitialScope` 是写权探测的落点：只有「目标组织 = 主体 active organization，且主体在该组织里是
 * owner/admin」才返回归属，其余一律拒绝——与真实策略的组织分支同结论。有效动作按同一条件给出（写权主体拿全部
 * 动作、其余人只有 `read`），让 `/web` 视图里的 `access.actions` 在用例中有真实来源。
 */
export function createFakeAccessControl(overrides: Partial<AccessControlModule> = {}): AccessControlModule {
  const allActions: readonly ResourceAction[] = ["read", "create", "update", "delete", "use"];

  /** 主体在 active organization 里的角色 → 有效动作；角色缺失或不足时只有读权。 */
  const accessFor = (actor: ActorContext): ResourceAccess => {
    const role = actor.memberships.find((membership) => membership.organizationId === actor.activeOrganizationId)?.role;
    return role === "owner" || role === "admin" ? { actions: allActions } : { actions: ["read"] };
  };

  return {
    id: "test-access-control",
    resolveInitialScope: async ({ actor, organizationId }) => {
      const target = organizationId ?? actor.activeOrganizationId;
      if (target === undefined) throw new ResourceAccessDeniedError("缺少组织上下文");
      const role = actor.memberships.find((membership) => membership.organizationId === target)?.role;
      if (role !== "owner" && role !== "admin") throw new ResourceAccessDeniedError("当前主体无权创建该资源");
      return { organizationId: target, visibility: "public" };
    },
    initializeResourceAccess: async () => undefined,
    authorize: async () => undefined,
    createListConstraint: async ({ action }) => testListConstraint(action),
    resolveAccess: async ({ actor }) => accessFor(actor),
    resolveAccessMany: async ({ actor, resourceIds }) => new Map(resourceIds.map((id) => [id, accessFor(actor)])),
    ...overrides,
  };
}

/** 身份目录替身：只打桩 `resolveSystemTenant`，其余未打桩即失败（会读身份的路径不存在）。 */
export function createStubIdentity(overrides: Partial<IdentityDirectory> = {}): {
  readonly identity: IdentityDirectory;
  /** `resolveSystemTenant` 的调用次数；用来断言租户缓存生效。 */
  readonly tenantReads: () => number;
} {
  let reads = 0;
  const unstubbed = (): never => {
    throw new Error("身份目录替身未打桩：本模块只应调用 resolveSystemTenant");
  };
  const identity: IdentityDirectory = {
    listUserDisplayInfo: async () => unstubbed(),
    getUser: async () => unstubbed(),
    findUserByName: async () => unstubbed(),
    searchUsers: async () => unstubbed(),
    listOrganizationNames: async () => unstubbed(),
    getOrganization: async () => unstubbed(),
    resolveMembershipId: async () => unstubbed(),
    listMemberships: async () => unstubbed(),
    resolveSystemTenant: async () => {
      reads += 1;
      return SYSTEM_TENANT;
    },
    listOrganizationsWithMembers: async () => unstubbed(),
    ...overrides,
  };
  return { identity, tenantReads: () => reads };
}

/** 目录读取替身：记录调用并入参，让用例断言「Facade 交给了读侧什么口径」。 */
export function createRecordingPackageService(
  input: { readonly items?: readonly PackageView[]; readonly detail?: PackageDetailView | null } = {},
): {
  readonly service: PluginPackageService;
  readonly listCalls: ListCall[];
  readonly detailCalls: DetailCall[];
} {
  const listCalls: ListCall[] = [];
  const detailCalls: DetailCall[] = [];
  const items = input.items ?? [];
  return {
    listCalls,
    detailCalls,
    service: {
      async list(call) {
        listCalls.push(call);
        return { items: [...items], total: items.length };
      },
      async findDetailBySlug(call) {
        detailCalls.push(call);
        return input.detail ?? undefined;
      },
    },
  };
}

/**
 * 一次读调用的记录。
 *
 * `access` 可选：管理面（系统凭据）的读**不带**授权条件，那是平台端口记录在案的例外形状；用例据此断言
 * 「哪一面走了哪条路径」，而不是只看结果。
 */
export interface ListCall {
  readonly access?: ResourceQueryConstraint;
  readonly sourceId: string;
  readonly scope: CatalogReadScope;
}

export interface DetailCall extends ListCall {
  readonly slug: string;
}

/** 列表项夹具（Domain Service 的产出形状）。 */
export function packageViewOf(overrides: Partial<PackageView> = {}): PackageView {
  return {
    id: "pkg-1",
    slug: toPackageSlug(TEST_PACKAGE_NAME),
    sourceId: TEST_SOURCE_ID,
    packageName: TEST_PACKAGE_NAME,
    latestVersion: "1.0.0",
    latestPublicationId: "pub-1",
    metadata: null,
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    hidden: false,
    scope: { organizationId: TEST_ORGANIZATION_ID, visibility: "public" },
    ...overrides,
  };
}

/** 详情夹具：列表字段 + 版本历史。 */
export function packageDetailViewOf(overrides: Partial<PackageDetailView> = {}): PackageDetailView {
  return { ...packageViewOf(), versions: [], ...overrides };
}

/** Facade 替身；未打桩的方法调用即失败，避免路由调用了用例未预期的方法而断言失真。 */
export function createStubFacade(overrides: Partial<PluginPackageFacadeApi> = {}): PluginPackageFacadeApi {
  const unstubbed = (name: string) => (): never => {
    throw new Error(`插件市场 Facade 替身未打桩：${name}`);
  };
  return {
    list: unstubbed("facade.list"),
    getDetail: unstubbed("facade.getDetail"),
    listAll: unstubbed("facade.listAll"),
    getDetailAll: unstubbed("facade.getDetailAll"),
    preview: unstubbed("facade.preview"),
    publish: unstubbed("facade.publish"),
    unpublish: unstubbed("facade.unpublish"),
    restore: unstubbed("facade.restore"),
    ...overrides,
  };
}

/** 装入资源模块替身（资源注册保持真实，只有一个实现）。 */
export function installMarketModuleStub(facade: Partial<PluginPackageFacadeApi> = {}): void {
  installPluginMarketModule({ resource: pluginPackageResource, facade: createStubFacade(facade) });
}

/** 清除模块装配结果；测试结束必须调用，避免跨用例共享状态。 */
export function resetMarketModuleStub(): void {
  resetPluginMarketModule();
}
