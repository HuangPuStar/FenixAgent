import type { ResolvedAssembly } from "@fenix/platform-sdk";

/** 对浏览器公开的部署能力，不包含配置值或贡献入口说明符。 */
export interface AssemblyModules {
  readonly modules: readonly string[];
  readonly web: readonly string[];
}

/**
 * 部署配置键是否提供了可用值。
 *
 * 空串与纯空白按未配置处理：docker-compose 的 `${VAR:-}` 会透传空串，把它当成「已配置」会让入口
 * 重新出现。这里只判断是否存在，值本身不会进入浏览器清单。
 */
function isConfiguredEnvValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim() !== "";
}

/**
 * 只从 registry 已校验的装配结果投影，避免把 web contribution 的值误当成 ID。
 *
 * `web` 再按模块声明的 `requiresEnv` 收窄：模块仍装配（`modules` 不变），但缺少浏览器面必需的部署
 * 配置时，入口隐藏与路由拦截必须由同一份清单一起关闭，否则会出现「入口可见但页面不可用」。
 */
export function projectAssemblyModules(
  assembly: ResolvedAssembly,
  env: Readonly<Record<string, unknown>>,
): AssemblyModules {
  const web = [...assembly.webContributions.keys()].filter((id) => {
    const declaration = assembly.modules.find((module) => module.web?.id === id)?.web;
    return (declaration?.requiresEnv ?? []).every((key) => isConfiguredEnvValue(env[key]));
  });
  return Object.freeze({
    modules: Object.freeze(assembly.modules.filter((module) => module.kind === "resource").map((module) => module.id)),
    web: Object.freeze(web),
  });
}
