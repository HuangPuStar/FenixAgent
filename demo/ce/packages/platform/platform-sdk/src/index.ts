/** 资源默认可见范围；`public` 仅代表已认证用户可访问，不创建匿名入口。 */
export type ResourceVisibility = "private" | "public";
export type ResourceAction = "read" | "create" | "update" | "delete" | "use";
export type OwnershipMode = "organization" | "organization-personal" | "personal";

/** 由资源包静态声明的默认归属与动作，不由平台维护中央注册表。 */
export interface ResourceDefinition {
  readonly type: string;
  readonly ownershipMode: OwnershipMode;
  readonly actions: readonly ResourceAction[];
  readonly memberDefaultActions: readonly Extract<ResourceAction, "read" | "use">[];
}

/** 资源主表固定列映射出的归属与可见范围。 */
export interface ResourceScope {
  readonly organizationId?: string;
  readonly ownerUserId?: string;
  readonly visibility: ResourceVisibility;
}

/** 当前 actor 对单个资源的有效动作；不是资源自身的归属信息。 */
export interface ResourceAccess {
  readonly actions: readonly ResourceAction[];
}

/** 资源领域对外的稳定读模型：范围不随 actor 改变，access 则按 actor 计算。 */
export type ResourceRecord<TData, TScope extends ResourceScope = ResourceScope> = TData & {
  readonly scope: TScope;
  readonly access: ResourceAccess;
};

/**
 * 资源主表固定归属列的读写端口。
 *
 * CE 的 ColumnResourceScopeStore 将 organization_id、user_id、visibility 映射为 ResourceScope；
 * 资源模块不直接读写这些列。
 */
export interface ResourceScopeStore<TScope extends ResourceScope = ResourceScope> {
  initialize(input: { resourceType: string; resourceId: string; scope: TScope }): Promise<void>;
  getMany(input: { resourceType: string; resourceIds: readonly string[] }): Promise<Map<string, TScope>>;
  update(input: { resourceType: string; resourceId: string; scope: TScope }): Promise<void>;
  remove(input: { resourceType: string; resourceId: string }): Promise<void>;
}

/** 认证层构造的可信调用主体。 */
export interface ActorContext {
  readonly kind: "user";
  readonly userId: string;
  readonly systemRole?: "super-admin";
  readonly activeOrganizationId?: string;
  readonly memberships: readonly { readonly organizationId: string; readonly role: "owner" | "admin" | "member" }[];
}

/**
 * 授权查询能力消费的不透明范围过滤条件。
 *
 * 生产实现由 AuthorizedResourceQuery 将其编译为 Drizzle 条件；资源 repository 不解析它。
 */
export type ResourceQueryConstraint = Readonly<{
  readonly resourceType: string;
  readonly action: "read" | "use";
}>;

/** 单资源授权的稳定输入；资源领域不传递主表归属列。 */
export interface AuthorizationInput {
  readonly actor: ActorContext;
  readonly action: ResourceAction;
  readonly resource: ResourceDefinition;
  readonly resourceId: string;
}

/**
 * 身份、租户和授权的整体替换边界。
 *
 * CE 提供默认实现；EE 通过 submodule 导入此契约后可替换整个模块，绝不需要继承 CE 角色模型。
 */
export interface AccessControlModule {
  readonly id: string;
  createActorContext(input: { actorId: string }): Promise<ActorContext>;
  initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;
  authorize(input: AuthorizationInput): Promise<void>;
  createListConstraint(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    action: "read" | "use";
  }): ResourceQueryConstraint;
  /** 平台授权查询将结果映射为 actor 专属的 ResourceAccess。 */
  resolveAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<ResourceAccess>;
}

/** 装配层将资源主表范围 Store 交给授权实现；资源业务模块不依赖此内部接线端口。 */
export interface ResourceScopeStoreBinding {
  bindResourceScopeStore(store: ResourceScopeStore): void;
}

/** 领域模块作为一个整体交付：数据、服务、API、控制台与能力声明不可拆散。 */
export interface ResourceModule {
  readonly id: string;
  readonly schema: string;
  readonly migrations: readonly string[];
  readonly apiContribution: readonly string[];
  readonly webContribution: readonly string[];
  readonly capabilities: readonly string[];
}

/** 模块声明的部署级环境变量；由 app 在启动时一次性读取和校验。 */
export interface EnvDefinition {
  readonly moduleId: string;
  readonly key: string;
  readonly secret?: boolean;
}

/** bootstrap 校验后传入模块工厂的最小上下文。 */
export interface ModuleFactoryContext {
  readonly env: Readonly<Record<string, string>>;
}

/** 构建期发现的模块类别；不是运行时插件协议。 */
export type ModuleKind = "access-control" | "runtime" | "resource";

/**
 * 每个可装配包在包根目录的 `fenix.module.ts` 导出此声明。
 * 生成器只扫描可信 workspace/submodule 中的该文件，再生成静态 import registry。
 */
export interface ModuleManifest {
  readonly id: string;
  readonly kind: ModuleKind;
  readonly dependsOn: readonly string[];
  /** 模块仅声明所需配置，不自行读取 process.env。 */
  readonly envDefinitions?: readonly EnvDefinition[];
  /** 授权与 runtime 等基础模块通过工厂交给 app 创建。 */
  readonly create?: (context: ModuleFactoryContext) => unknown;
  /** 资源模块的后端交付物；只有 kind=resource 时可提供。 */
  readonly resourceModule?: ResourceModule;
  /** 浏览器 contribution 使用独立 ID，避免 package 名称成为前端装配契约。 */
  readonly web?: { readonly id: string; readonly contribution: unknown };
}

/**
 * 版本级 Web 应用壳的最小契约。
 * Shell 由各版本的 apps/web 实现和静态导入，不是 resources package 或可发现插件。
 */
export interface WebShell {
  readonly id: string;
  readonly homeRoute: string;
  readonly layoutDescription: string;
}

/**
 * 由生成的 manifest 集合创建只读查询表，并在启动时守住 ID、类型与依赖关系。
 * 它不扫描文件、不动态 import；发现行为已经在构建期结束。
 */
export function createModuleRegistry(manifests: readonly ModuleManifest[]) {
  const byId = new Map<string, ModuleManifest>();
  const webById = new Map<string, ModuleManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) throw new Error(`模块 ID 重复: ${manifest.id}`);
    byId.set(manifest.id, manifest);
    if (manifest.web) {
      if (webById.has(manifest.web.id)) throw new Error(`Web 模块 ID 重复: ${manifest.web.id}`);
      webById.set(manifest.web.id, manifest);
    }
  }

  function requireModule(id: string, kind?: ModuleKind): ModuleManifest {
    const manifest = byId.get(id);
    if (!manifest) throw new Error(`装配配置引用了未注册模块: ${id}`);
    if (kind && manifest.kind !== kind) throw new Error(`模块 ${id} 必须是 ${kind}，实际为 ${manifest.kind}`);
    return manifest;
  }

  return {
    requireModule,
    /** 返回启用模块，供 bootstrap 汇总 env、迁移与生命周期钩子。 */
    resolveEnabled(ids: readonly string[]): readonly ModuleManifest[] {
      this.assertDependencies(ids);
      return ids.map((id) => requireModule(id));
    },
    /** 为基础模块创建实例；调用方显式指定预期类型，避免 SDK 依赖具体实现。 */
    create<T>(id: string, kind: ModuleKind, context: ModuleFactoryContext): T {
      const manifest = requireModule(id, kind);
      if (!manifest.create) throw new Error(`模块 ${id} 未提供创建工厂`);
      return manifest.create(context) as T;
    },
    /** 资源 module 仍保持完整交付物，不在 app 内维护 ID → resource 映射。 */
    requireResource(id: string): ResourceModule {
      const manifest = requireModule(id, "resource");
      if (!manifest.resourceModule) throw new Error(`资源模块 ${id} 未提供 ResourceModule`);
      return manifest.resourceModule;
    },
    /** Web 只能获得构建期已收集的 contribution。 */
    requireWeb<T>(id: string): T {
      const manifest = webById.get(id);
      if (!manifest?.web) throw new Error(`装配配置引用了未注册 Web 模块: ${id}`);
      return manifest.web.contribution as T;
    },
    /** 启用模块必须同时启用它声明的直接依赖。 */
    assertDependencies(enabledIds: readonly string[]): void {
      const enabled = new Set(enabledIds);
      if (enabled.size !== enabledIds.length) throw new Error("装配配置包含重复模块 ID");
      for (const id of enabled) {
        const manifest = requireModule(id);
        for (const dependencyId of manifest.dependsOn) {
          if (!enabled.has(dependencyId)) throw new Error(`模块 ${id} 依赖未启用模块 ${dependencyId}`);
        }
      }
    },
  };
}

/** 仅用于展示构建期静态装配；不包含运行时插件发现机制。 */
export function defineApplication<T extends object>(application: T): Readonly<T> {
  return Object.freeze(application);
}

export * from "./resource/scoped-resource";
export * from "./services/authorized-resource-facade";
export * from "./services/authorized-resource-query";
