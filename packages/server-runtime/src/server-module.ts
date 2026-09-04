import type { AnyElysia } from "elysia";

/** 模块成功启动后用于释放其进程级易失资源。 */
export type ModuleDisposer = () => void | Promise<void>;

/** ServerModule 启动时可用的生命周期控制信号。 */
export interface ModuleStartContext {
  readonly signal: AbortSignal;
}

/** 可由 ApplicationProfile 整体增减的服务端装配模块。 */
export interface ServerModule<TRoutes extends AnyElysia = AnyElysia> {
  readonly name: string;
  createRoutes(): TRoutes;
  start?(context: ModuleStartContext): undefined | ModuleDisposer | Promise<undefined | ModuleDisposer>;
}

/** 任意具体路由类型的 ServerModule。 */
export type AnyServerModule = ServerModule<AnyElysia>;
