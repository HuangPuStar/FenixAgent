import type { z } from "zod/v4";
import type { DataMigration } from "../migration/data-migration";
import type { ResourceStorageBinding } from "../resource/registration";

/**
 * 构建期 registry 支持的模块类别。
 *
 * `identity` 与 `web-shell` 是平台基础类别：`identity` 由 `packages/platform/identity` 提供；
 * `web-shell` 由应用级 Shell manifest 提供（见 `apps/web/fenix.module.ts`）。
 */
export type ModuleKind = "access-control" | "agent-runtime" | "identity" | "resource" | "web-shell";

/** 模块声明的部署级环境变量；读取和交叉声明校验由统一 env loader 负责。 */
export interface EnvDefinition {
  readonly moduleId: string;
  readonly key: string;
  readonly schema: z.ZodType;
  readonly defaultValue?: unknown;
  readonly secret: boolean;
  readonly restartRequired: boolean;
  readonly description: string;
}

/** 与具体 HTTP/UI 框架解耦的服务端贡献描述。 */
export interface ModuleContribution<TValue = unknown> {
  readonly id: string;
  readonly kind: "app-route" | "protocol" | "lifecycle";
  /**
   * 挂载顺序，默认 0：小者先挂载，同值保持拓扑序与声明序（`bootstrapModules` 用稳定排序）。
   *
   * 兜底与通配路由（例如站点代理的兼容层）必须最后注册才能保留优先级，它们在自己的声明处写一个大
   * `order` 即可自证；宿主因此不再需要维护「哪些模块必须最后挂」的手写清单。
   */
  readonly order?: number;
  /**
   * 宿主协议聚合槽：贡献挂到宿主的哪一面，默认 `"app"`（顶层应用）。
   *
   * 路由贡献的路径是**相对形式**（包内不写 `/web` 一类前缀，前缀由宿主的聚合实例决定），所以要挂进
   * `/web` 还是 `/web/config` 这类聚合面必须由声明说清。槽名是包与宿主之间唯一的约定面，取值是宿主
   * 自定义的字符串（platform-sdk 不认识具体槽位，也就不把某个应用的结构写进契约）；宿主把槽名映射到
   * 具体聚合实例，遇到未知槽名当场报错——静默丢弃一个路由贡献等于让整组端点消失。
   */
  readonly slot?: string;
  readonly value: TValue;
}

/** 浏览器侧只能消费构建期静态导入的贡献。 */
export interface WebContribution<TValue = unknown> {
  readonly id: string;
  readonly contribution: TValue;
}

/** 模块或贡献释放已获取资源的关闭钩子。 */
export type ModuleCleanup = () => void | Promise<void>;

/**
 * 依赖服务的健康探测。
 *
 * 只描述**部署侧可执行**的探活方式，不写容器内 healthcheck 命令：容器里可用的探测工具随镜像而异，
 * 写错会让服务永久处于 unhealthy 而卡住启动顺序。因此两种形态都锚定在模块已声明的地址键上。
 */
export type DependencyServiceHealthCheck =
  /** HTTP 探活：地址 = 本模块 `envDefinitions` 中 `addressKey` 的取值 + `path`，2xx 视为健康。 */
  | { readonly kind: "http"; readonly addressKey: string; readonly path: string }
  /**
   * 只断言地址可达（TCP 连接成功）。
   *
   * 用于没有公开健康端点的服务（例如 MCP 形态的 Hindsight）：这是**较弱的**断言，不要用它冒充 HTTP 探活。
   */
  | { readonly kind: "tcp"; readonly addressKey: string };

/**
 * 模块声明的依赖服务（数据库、缓存、检索引擎、文档转换、外部网关等）。
 *
 * 消费方有两处，同一份声明同时服务它们：
 * 1. **部署视图**：`orchestration` 与 `composeFile` 标明该依赖的编排归属，供部署方按依赖顺序启动与排障；
 *    编排本身由 `docker/<name>/docker-compose.yml` 承载，由 `docker/deploy.env` 的 feature 开关启停，
 *    本声明不重复定义任何容器（真相只有一份）。
 * 2. **部署前自检（preflight）**：`healthCheck` 与 `required` 决定部署前探活哪些地址、
 *    哪些失败必须阻断（`required: true`）、哪些只告警（`required: false`，例如未部署 RAGFlow
 *    时知识库检索不可用，但主服务必须能起来）。
 *
 * 声明的是「模块依赖什么」，不是「怎么部署它」：镜像与端口只在服务确由本仓编排时声明。
 */
export interface DependencyService {
  /** 服务标识，形如模块 ID（`ragflow` / `gotenberg`）。多个模块声明同一 ID 视为同一依赖，按 ID 合并。 */
  readonly id: string;
  /** 该服务不可用时，本模块的能力是否必然不可用（`true` 表示部署前自检必须探活成功才继续）。 */
  readonly required: boolean;
  /**
   * 编排归属。
   *
   * - `"compose-overlay"`：本仓为该依赖提供了编排与镜像，必须同时声明 `image`；
   * - `"separate"`：自有编排入口在 `composeFile`。第三方产品的独立编排（RAGFlow / Hindsight
   *   一类）与本仓独立部署单元（如 `packages/opensandbox-cluster`）都取此值——**不重复定义**
   *   它们的服务，只记录依赖、探针与入口，避免同一编排出现两份真相。
   */
  readonly orchestration: "compose-overlay" | "separate";
  /** 声明该服务地址的 `envDefinitions` 键；探针与部署配置都按这些键取值。无地址键时省略。 */
  readonly envKeys?: readonly string[];
  /** `orchestration: "compose-overlay"` 的容器镜像。 */
  readonly image?: string;
  /** `orchestration: "compose-overlay"` 的宿主端口映射（`"3200:3000"`），与 `envKeys` 的默认地址相符。 */
  readonly ports?: readonly string[];
  /** `orchestration: "separate"` 的编排入口（仓库相对路径），供部署方按依赖顺序启动与排障。 */
  readonly composeFile?: string;
  readonly healthCheck: DependencyServiceHealthCheck;
  /** 服务的用途、可选性与地址口径；部署方据此判断要不要部署它。 */
  readonly description: string;
}

/** 模块工厂仅获得本模块 env、已创建依赖、装配声明与即时登记资源清理的入口。 */
export interface ModuleFactoryContext {
  readonly env: Readonly<Record<string, unknown>>;
  readonly modules: ReadonlyMap<string, unknown>;
  /**
   * 本次装配启用的全部 manifest（已拓扑排序），供基础模块收集资源模块的**静态声明**。
   *
   * `access-control` 的工厂正是从这里汇总 {@link ModuleManifest.accessControlBindings}：绑定是静态
   * 导出，收集它不需要资源模块的实例，因此「先装配授权、再装配资源模块」的顺序可以在 registry 内
   * 自然成立，而不必让授权模块反过来依赖那四个资源模块（那会构成装配环）。
   */
  readonly declarations: readonly ModuleManifest[];
  /** 每次成功获取资源后立即登记；bootstrap 失败或应用关闭时按逆序执行。 */
  readonly registerCleanup: (cleanup: ModuleCleanup) => void;
}

/**
 * 模块拥有的业务数据迁移的**声明**（§6.3）。
 *
 * 只承载事实：迁移 ID、依赖关系，以及取实现的导出入口。`run` / `verify` / `compensation` 与元信息的实现
 * 留在 owner 包的 `db/data-migrations/`——manifest 是构建期被静态读取、且会被大量位置导入的声明面，
 * 写进去的是「本模块拥有哪些迁移」，不是迁移本身。
 *
 * 声明与实现的一致性由汇总方（部署期入口）在装载时校验：两处各写一份 ID 却允许分歧，等于让
 * `data_migrate_record` 的幂等判据与日志里的迁移名可以各说一套，而 ID 一改就会被判为未应用而重跑。
 */
export interface DataMigrationDeclaration {
  /**
   * 迁移 ID，与实现的 `DataMigration.name` **逐字相同**（既有迁移写已落库的名字，不按命名格式回改）。
   *
   * 落 `data_migrate_record` 即成为发布契约：改名会被 runner 判为未应用而重跑。
   */
  readonly name: string;
  /** 必须已完成的迁移 ID；与实现的 `DataMigration.dependsOn` 同集合，runner 执行前据此校验。 */
  readonly dependsOn: readonly string[];
  /**
   * 取实现的入口：惰性装载 owner 包 `db/data-migrations/` 下的 `DataMigration`。
   *
   * 用函数而不是直接值引用（同 {@link ModuleContribution.value}）：registry 会被装配层大量位置导入，
   * 把迁移模块（连带 Drizzle、包内 schema 与仓储）压到 manifest 的静态导入图上，会让「读装配声明」
   * 这一动作顺带加载数据访问层。
   */
  readonly load: () => Promise<DataMigration>;
}

/** 可装配 package 根目录 `fenix.module.ts` 导出的稳定描述符。 */
export interface ModuleManifest<TInstance = unknown> {
  readonly id: string;
  readonly kind: ModuleKind;
  readonly dependsOn: readonly string[];
  readonly capabilities?: readonly string[];
  readonly envDefinitions?: readonly EnvDefinition[];
  /**
   * 模块依赖的外部服务与探针；未声明表示本模块不依赖任何对外服务。
   *
   * 可选字段，消费方与不变量见 {@link DependencyService}。
   */
  readonly dependencyServices?: readonly DependencyService[];
  /**
   * 资源模块向平台授权实现声明的存储绑定，取自己的 `xxxResource.storage`。
   *
   * 由 `access-control` 的工厂经 {@link ModuleFactoryContext.declarations} 汇总——绑定是**静态**导出
   * （不依赖模块实例化），所以资源模块**不得**为了表达这条边把 `access-control` 写进 `dependsOn`：
   * 授权模块要等这些声明齐全才能构造，反向声明会让两侧互相等待。
   * 未声明的受控资源在授权查询里直接报错，不会退化成「没有归属列」的放宽查询。
   */
  readonly accessControlBindings?: readonly ResourceStorageBinding[];
  /**
   * 本模块拥有的业务数据迁移；未声明表示本模块没有数据迁移。
   *
   * 由部署期入口（`db/data-migration-runner.ts`）按装配汇总后统一执行——模块**不得**自行执行迁移：
   * 一次性数据迁移只由发布任务承担一次（§6.3 / §10.6.2），每个副本启动时各跑一次含文件副作用的迁移
   * 不是幂等并发安全。
   *
   * 这里不构成「本模块依赖某迁移」的装配边：迁移 ID 是发布契约，与模块的启用顺序无关，因此它不参与
   * `dependsOn` 的拓扑排序，只被迁移执行器读取。
   */
  readonly dataMigrations?: readonly DataMigrationDeclaration[];
  readonly create?: (context: ModuleFactoryContext) => TInstance | Promise<TInstance>;
  readonly contributions?: readonly ModuleContribution[];
  readonly web?: WebContribution;
}
