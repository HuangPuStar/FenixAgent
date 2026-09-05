/** 模块声明的最小 env 定义；真实项目以 Zod 合并并在启动时一次性校验。 */
export interface EnvDefinition {
  readonly moduleId: string;
  readonly key: string;
  readonly secret?: boolean;
}

export const postgresEnv: readonly EnvDefinition[] = [{ moduleId: "postgres", key: "DATABASE_URL", secret: true }];

/** app 汇总静态装配模块；模块内部不直接读取 process.env。 */
export function loadServerEnv(definitions: readonly EnvDefinition[]): Readonly<Record<string, string>> {
  const duplicate = definitions.find(
    (definition, index) => definitions.findIndex((item) => item.key === definition.key) !== index,
  );
  if (duplicate) throw new Error(`环境变量重复声明: ${duplicate.key}`);
  return Object.fromEntries(definitions.map((definition) => [definition.key, `<${definition.key}>`])) as Readonly<
    Record<string, string>
  >;
}
