import type { z } from "zod/v4";

/** 构建期 registry 支持的模块类别。 */
export type ModuleKind = "access-control" | "agent-runtime" | "resource";

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
  readonly value: TValue;
}

/** 浏览器侧只能消费构建期静态导入的贡献。 */
export interface WebContribution<TValue = unknown> {
  readonly id: string;
  readonly contribution: TValue;
}

/** 模块或贡献释放已获取资源的关闭钩子。 */
export type ModuleCleanup = () => void | Promise<void>;

/** 模块工厂仅获得本模块 env、已创建依赖，以及即时登记资源清理的入口。 */
export interface ModuleFactoryContext {
  readonly env: Readonly<Record<string, unknown>>;
  readonly modules: ReadonlyMap<string, unknown>;
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
  readonly create?: (context: ModuleFactoryContext) => TInstance | Promise<TInstance>;
  readonly contributions?: readonly ModuleContribution[];
  readonly web?: WebContribution;
}
