import type { EnvDefinition } from "../index";

/** 只有 server 进程本身需要的配置；不包含数据库或 Provider 等模块配置。 */
export const serverHostEnv: readonly EnvDefinition[] = [{ moduleId: "server-host", key: "PORT" }];

/**
 * bootstrap 汇总已启用模块的 env 声明后唯一调用此函数。
 * demo 以占位值代替真实 Zod/process.env 读取，重点展示一次校验、一次注入的边界。
 */
export function loadServerEnv(definitions: readonly EnvDefinition[]): Readonly<Record<string, string>> {
  const duplicate = definitions.find(
    (definition, index) => definitions.findIndex((item) => item.key === definition.key) !== index,
  );
  if (duplicate) throw new Error(`环境变量重复声明: ${duplicate.key}`);
  return Object.fromEntries(definitions.map((definition) => [definition.key, `<${definition.key}>`])) as Readonly<
    Record<string, string>
  >;
}
