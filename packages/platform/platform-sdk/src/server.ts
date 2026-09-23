/**
 * 应用基础设施的受限注册与读取入口。
 *
 * `apps/server` 是唯一的宿主：它负责读取并校验 `process.env`、创建进程级 DB client，
 * 然后在任何模块开始运行前调用 {@link initializeApplicationInfrastructure} 完成唯一初始化。
 * 包只能通过本模块读取已注册的基础设施，不得导入 `apps/server` 的 env、config、db 或内部路径。
 *
 * 本模块刻意不导入 Drizzle、不读取环境变量、不创建连接池，也不包含领域逻辑；它只保存宿主
 * 传进来的对象引用。{@link ServerRouteHost} 是同一取向的另一半：宿主在挂载路由贡献时把协议适配面
 * 交给包，字段类型一律为 `unknown`，本模块因此仍然不依赖任何 HTTP 框架。
 */

import type { IdentityDirectory } from "./identity/identity-directory";

interface ApplicationInfrastructure {
  readonly database: unknown;
  readonly moduleConfigs: Map<string, unknown>;
  /**
   * 进程级 Redis 连接 provider；`null` 表示本进程已声明「不使用 Redis」。
   *
   * 存**函数**而不是连接本身：宿主的 `apps/server/src/services/cache.ts` 首次 `getCache()` 时才建连，
   * 注册期取值会把「尚未建连」固化成永久 `null`，而那个状态在进程生命周期内不会自愈。
   */
  readonly redisConnection: (() => unknown) | null;
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
  /**
   * 进程级 Redis 连接 provider；显式传 `null` 表示本进程不使用 Redis。
   *
   * 必填而非可选：Redis 是可选基础设施，但「本进程用不用」必须由装配方回答。选填会让「漏传」与
   * 「声明不用」不可区分——配了 `RCS_REDIS_URL` 的部署会静默退化成进程内缓存，多实例之间的
   * Y.Doc 快照因此不再共享，且没有任何报错。
   */
  readonly redisConnection: (() => unknown) | null;
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
    redisConnection: input.redisConnection,
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
 * 读取进程级 Redis 连接。
 *
 * 未初始化时抛错（同 {@link getDatabase}）；装配方声明 `null` 或宿主尚未建连时返回 `null`。与
 * `getDatabase` 的差别是有意为之：Redis 是可选基础设施，「本进程没有可用的 Redis」是合法状态，
 * 调用方据此回退进程内后端，而不是把它当成装配错误。
 *
 * 返回类型是泛型：本模块不依赖 ioredis，`unknown` 只用于存储槽位，调用方收窄为具体客户端类型
 * （`Redis | Cluster`）。连接的生命周期归宿主——本模块只转发，不建连、不关连接。
 */
export function getRedisConnection<TRedis = unknown>(): TRedis | null {
  const provider = requireInfrastructure().redisConnection;
  return provider ? ((provider() as TRedis | null | undefined) ?? null) : null;
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

/**
 * 宿主在挂载路由贡献时交给模块的协议适配面。
 *
 * 路由贡献的 `value` 是惰性构造函数（见 `ModuleContribution`），宿主构造 app 时按挂载顺序调用它并
 * 传入本对象；模块在自己的 `src/server/assembly.ts` 里把用到的字段收窄为**包内** `dependencies.ts`
 * 的契约类型，收窄点唯一且显式——本模块只声明「宿主持有这些能力」，不声明它们的类型，因此不引入
 * `elysia` 依赖，也不与任何协议的实现细节耦合。
 *
 * 为什么由宿主提供而不能由包自建：会话守卫的 `macro` / `state` 是 Elysia 实例作用域的，包内自建第二份
 * 会让同一进程出现两套互不可见的认证状态（表现成「所有请求 401」而不是装配错误）；环境归属、用户偏好
 * 与密钥引用的真相也分别属于 agent-runtime、identity 与宿主进程环境。
 */
export interface ServerRouteHost {
  /** 会话认证守卫：写入 `sessionAuth` 宏与 `store.actor`（宿主 `plugins/auth`）。 */
  readonly authGuardPlugin: unknown;
  /** 系统 API 守卫：校验 `RCS_SYSTEM_API_KEYS` 的调用方（宿主 `plugins/system-api-auth`）。 */
  readonly systemApiGuardPlugin: unknown;
  /** 请求级认证结果解析；站点代理等不走 `sessionAuth` 宏的入口用它区分「未登录」与「已登录但无权限」。 */
  readonly authenticateRequest: unknown;
  /** Environment 归属查询端口；该表的 owner 是 `@fenix/agent-runtime`。 */
  readonly environmentLookup: unknown;
  /** Agent 级用户偏好读写端口；`user_config` 表的 owner 是 `@fenix/identity`。 */
  readonly userAgentPreferences: unknown;
  /** Model 级用户偏好读写端口；与 Agent 级共用 `user_config` 表。 */
  readonly userModelPreferences: unknown;
  /** `{env:NAME}` 密钥引用解析；真相来源是宿主进程环境，包不得直读 `process.env`。 */
  readonly resolveSecretReference: unknown;
  /** Environment 归属校验；不存在、跨组织或跨用户一律抛 `NotFoundError`。 */
  readonly verifyEnvironmentOwnership: unknown;
  /** 请求错误日志（宿主 `plugins/logger`）：读宿主中间件写入的 requestId / 耗时，包内没有来源。 */
  readonly logError: unknown;
}

function requireInfrastructure(): ApplicationInfrastructure {
  if (!applicationInfrastructure) {
    throw new Error("应用基础设施尚未初始化，必须先由 apps/server 调用 initializeApplicationInfrastructure");
  }
  return applicationInfrastructure;
}
