/**
 * 应用基础设施的受限注册与读取入口。
 *
 * `apps/server` 是唯一的宿主：它负责读取并校验 `process.env`、创建进程级 DB client，
 * 然后在任何模块开始运行前调用 {@link initializeApplicationInfrastructure} 完成唯一初始化。
 * 包只能通过本模块读取已注册的基础设施，不得导入 `apps/server` 的 env、config、db 或内部路径。
 *
 * 本模块刻意不导入 Drizzle、不读取环境变量、不创建连接池，也不包含领域逻辑；它只保存宿主
 * 传进来的对象引用。
 */

import type { IdentityDirectory } from "./identity/identity-directory";

interface ApplicationInfrastructure {
  readonly database: unknown;
  readonly moduleConfigs: Map<string, unknown>;
}

let applicationInfrastructure: ApplicationInfrastructure | undefined;

/**
 * 宿主注入的身份目录实现。
 *
 * 与 `moduleConfigs` 不同：它不是配置而是端口，调用方（资源模块）只依赖契约类型，
 * 不知道实现来自 `@fenix/identity`。`unknown` 只用于存储槽位，读取时收窄为契约类型。
 */
let identityDirectory: IdentityDirectory | undefined;

/** 宿主初始化应用基础设施所需的全部输入。 */
export interface InitializeApplicationInfrastructureInput {
  /** 进程级 DB client；由 `apps/server` 创建，本模块不关心其具体类型。 */
  readonly database: unknown;
  /** 按模块 ID 拆分的已校验只读配置；模块只能读取自己的那一份。 */
  readonly moduleConfigs: Readonly<Record<string, unknown>>;
}

/**
 * 注册进程级应用基础设施。
 *
 * 一个进程只允许初始化一次：重复调用会抛错，避免两个 DB client 或两套配置在进程内静默共存。
 * 该函数是同步的，不存在并发初始化的中间状态。
 */
export function initializeApplicationInfrastructure(input: InitializeApplicationInfrastructureInput): void {
  if (applicationInfrastructure) {
    throw new Error("应用基础设施已初始化，禁止重复初始化");
  }
  applicationInfrastructure = {
    database: input.database,
    moduleConfigs: new Map(Object.entries(input.moduleConfigs)),
  };
}

/**
 * 读取进程级 DB client。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块文件加载时调用，否则可能早于宿主初始化。
 */
export function getDatabase<TDatabase = unknown>(): TDatabase {
  return requireInfrastructure().database as TDatabase;
}

/**
 * 读取本模块已校验的只读配置。
 *
 * 未初始化或读取未声明配置时抛错；模块不得回退到 `process.env` 或 `.env`。
 */
export function getModuleConfig<TConfig = unknown>(moduleId: string): TConfig {
  const { moduleConfigs } = requireInfrastructure();
  if (!moduleConfigs.has(moduleId)) {
    throw new Error(`模块 ${moduleId} 未声明应用基础设施配置`);
  }
  return moduleConfigs.get(moduleId) as TConfig;
}

/**
 * 覆盖单个模块的配置，仅供测试构造独立场景使用。
 *
 * 它不写回 `process.env`、不影响其他模块，也要求基础设施已初始化，避免掩盖忘记初始化的测试。
 */
export function overrideModuleConfig(moduleId: string, config: unknown): void {
  requireInfrastructure().moduleConfigs.set(moduleId, config);
}

/** 清空已注册的基础设施，供测试在用例之间恢复未初始化状态。 */
export function resetApplicationInfrastructure(): void {
  applicationInfrastructure = undefined;
}

/**
 * 注册身份目录实现。
 *
 * 只允许 `apps/server` 在装配阶段调用一次：两个身份实现同时存在会让不同模块读到不一致的
 * 成员关系视图，且这类分歧不会在启动期暴露，因此这里选择与
 * {@link initializeApplicationInfrastructure} 相同的严格语义——重复注册直接抛错，
 * 测试改由 {@link resetIdentityDirectory} 显式复位。
 */
export function registerIdentityDirectory(directory: IdentityDirectory): void {
  if (identityDirectory) {
    throw new Error("身份目录已注册，禁止重复注册");
  }
  identityDirectory = directory;
}

/**
 * 读取身份目录实现。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块文件加载时调用，否则可能早于宿主装配。
 */
export function getIdentityDirectory(): IdentityDirectory {
  if (!identityDirectory) {
    throw new Error("身份目录尚未注册，必须先由 apps/server 调用 registerIdentityDirectory");
  }
  return identityDirectory;
}

/** 清空已注册的身份目录，供测试在用例之间恢复未注册状态。 */
export function resetIdentityDirectory(): void {
  identityDirectory = undefined;
}

function requireInfrastructure(): ApplicationInfrastructure {
  if (!applicationInfrastructure) {
    throw new Error("应用基础设施尚未初始化，必须先由 apps/server 调用 initializeApplicationInfrastructure");
  }
  return applicationInfrastructure;
}
