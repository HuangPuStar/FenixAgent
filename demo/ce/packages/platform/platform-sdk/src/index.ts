/**
 * 平台资源的归属与可见边界。
 *
 * CE 不假定范围一定是 organization；EE 或甲方版可以使用 workspace、project 等范围，
 * 而不修改 CE 的资源领域服务。
 */
export interface ResourceScope {
  readonly kind: string;
  readonly id: string;
}

/** 已认证主体可以是用户、服务账号或来自外部身份系统的主体。 */
export interface Subject {
  readonly id: string;
  readonly type: "user" | "service" | "external";
}

/** 在资源服务边界创建，携带资源写入归属。 */
export interface ResourceContext {
  readonly subject: Subject;
  readonly scope: ResourceScope;
}

/**
 * repository 消费的范围过滤条件。
 *
 * demo 用 matches() 表示数据库 WHERE；生产 repository 应将对应实现转换为 Drizzle 条件，
 * 而不是先读取全量数据再在 service 内过滤。
 */
export interface ResourceQueryConstraint {
  matches(scope: ResourceScope): boolean;
}

/** CE 资源服务不理解具体角色或企业权限模型。 */
export interface AuthorizationInput {
  readonly actorId: string;
  readonly action: string;
  readonly resourceScope: ResourceScope;
}

/**
 * 身份、租户和授权的整体替换边界。
 *
 * CE 提供默认实现；EE 通过 submodule 导入此契约后可替换整个模块，绝不需要继承 CE 角色模型。
 */
export interface AccessControlModule {
  readonly id: string;
  createResourceContext(input: { actorId: string }): Promise<ResourceContext>;
  buildResourceQueryConstraint(context: ResourceContext): ResourceQueryConstraint;
  authorize(input: AuthorizationInput): Promise<void>;
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
  /** 授权与 runtime 等基础模块通过工厂交给 app 创建。 */
  readonly create?: () => unknown;
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
    /** 为基础模块创建实例；调用方显式指定预期类型，避免 SDK 依赖具体实现。 */
    create<T>(id: string, kind: ModuleKind): T {
      const manifest = requireModule(id, kind);
      if (!manifest.create) throw new Error(`模块 ${id} 未提供创建工厂`);
      return manifest.create() as T;
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
