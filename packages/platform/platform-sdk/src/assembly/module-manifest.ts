import type { z } from "zod/v4";
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
  readonly value: TValue;
}

/** 浏览器侧只能消费构建期静态导入的贡献。 */
export interface WebContribution<TValue = unknown> {
  readonly id: string;
  readonly contribution: TValue;
}

/** 模块或贡献释放已获取资源的关闭钩子。 */
export type ModuleCleanup = () => void | Promise<void>;

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

/** 可装配 package 根目录 `fenix.module.ts` 导出的稳定描述符。 */
export interface ModuleManifest<TInstance = unknown> {
  readonly id: string;
  readonly kind: ModuleKind;
  readonly dependsOn: readonly string[];
  readonly capabilities?: readonly string[];
  readonly envDefinitions?: readonly EnvDefinition[];
  /**
   * 资源模块向平台授权实现声明的存储绑定，取自己的 `xxxResource.storage`。
   *
   * 由 `access-control` 的工厂经 {@link ModuleFactoryContext.declarations} 汇总——绑定是**静态**导出
   * （不依赖模块实例化），所以资源模块**不得**为了表达这条边把 `access-control` 写进 `dependsOn`：
   * 授权模块要等这些声明齐全才能构造，反向声明会让两侧互相等待。
   * 未声明的受控资源在授权查询里直接报错，不会退化成「没有归属列」的放宽查询。
   */
  readonly accessControlBindings?: readonly ResourceStorageBinding[];
  readonly create?: (context: ModuleFactoryContext) => TInstance | Promise<TInstance>;
  readonly contributions?: readonly ModuleContribution[];
  readonly web?: WebContribution;
}
