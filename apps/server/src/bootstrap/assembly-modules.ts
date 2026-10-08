import type { ResolvedAssembly } from "@fenix/platform-sdk";

/** 对浏览器公开的部署能力，不包含配置值或贡献入口说明符。 */
export interface AssemblyModules {
  readonly modules: readonly string[];
  readonly web: readonly string[];
}

/** 只从 registry 已校验的装配结果投影，避免把 web contribution 的值误当成 ID。 */
export function projectAssemblyModules(assembly: ResolvedAssembly): AssemblyModules {
  return Object.freeze({
    modules: Object.freeze(assembly.modules.filter((module) => module.kind === "resource").map((module) => module.id)),
    web: Object.freeze([...assembly.webContributions.keys()]),
  });
}
