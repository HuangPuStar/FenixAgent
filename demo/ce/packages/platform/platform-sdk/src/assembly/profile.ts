/**
 * CE、EE 与客户版本共用的部署装配 profile 契约。
 * 它只校验稳定的通用结构；模块是否存在、依赖是否合法由各 app 对生成 registry 校验。
 */
export interface AssemblyProfile {
  readonly accessControl: string;
  readonly runtime: string;
  readonly webShell: string;
  readonly resources: readonly string[];
  readonly web: readonly string[];
}

/**
 * 解析 JSON/YAML 后的 profile。profile 只允许声明稳定模块 ID，不能变成任意代码加载入口。
 */
export function parseAssemblyProfile(input: unknown): AssemblyProfile {
  if (!input || typeof input !== "object") throw new Error("装配配置必须是对象");
  const config = input as Record<string, unknown>;
  const isModuleIdList = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
  if (
    typeof config.accessControl !== "string" ||
    typeof config.runtime !== "string" ||
    typeof config.webShell !== "string" ||
    !isModuleIdList(config.resources) ||
    !isModuleIdList(config.web)
  ) {
    throw new Error("装配配置格式非法");
  }
  return {
    accessControl: config.accessControl,
    runtime: config.runtime,
    webShell: config.webShell,
    resources: config.resources,
    web: config.web,
  };
}
