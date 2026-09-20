import type { IdentityDirectory } from "@fenix/platform-sdk";
import { createIdentityDirectory } from "./services/identity-directory";

/**
 * Identity 模块的运行时表面。
 *
 * 目前只暴露身份目录：它是模块间唯一的合法读取口，也是装配期唯一需要"对象身份"（而非纯函数）
 * 的能力。认证解析、路由工厂与系统管理引导都是宿主显式调用的入口，不需要经过模块实例，
 * 因此不在这里重复包装——等 1.7 收敛 env 与 preflight、真正由 registry 驱动装配时再按需要扩展。
 */
export interface IdentityModule {
  readonly id: "identity";
  readonly directory: IdentityDirectory;
}

/** 创建 Identity 模块实例。 */
export function createIdentityModule(): IdentityModule {
  return { id: "identity", directory: createIdentityDirectory() };
}
