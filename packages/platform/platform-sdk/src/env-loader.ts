import type { z } from "zod/v4";
import type { EnvDefinition } from "./assembly/module-manifest";

function comparableSchema(schema: z.ZodType): string {
  return JSON.stringify(schema.def);
}

function comparableDefault(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) =>
    typeof nestedValue === "bigint" ? `${nestedValue}n` : nestedValue,
  );
}

function assertDefinitions(definitions: readonly EnvDefinition[]): Map<string, EnvDefinition> {
  const byKey = new Map<string, EnvDefinition>();
  for (const definition of definitions) {
    const existing = byKey.get(definition.key);
    if (!existing) {
      byKey.set(definition.key, definition);
      continue;
    }

    const sameContract =
      comparableSchema(existing.schema) === comparableSchema(definition.schema) &&
      comparableDefault(existing.defaultValue) === comparableDefault(definition.defaultValue) &&
      existing.secret === definition.secret &&
      existing.restartRequired === definition.restartRequired;
    if (!sameContract) {
      throw new Error(`环境变量 ${definition.key} 被模块以不一致的契约重复声明`);
    }
  }
  return byKey;
}

/**
 * 只读取并校验已启用模块声明的环境变量。
 *
 * 返回值按定义拆分前仍是扁平对象，bootstrap 会再按 manifest 注入模块；函数不记录
 * secret 值，也不会把未声明的 process.env 字段带入模块配置。
 */
export function loadDeclaredEnv(
  definitions: readonly EnvDefinition[],
  input: Readonly<Record<string, unknown>> = process.env,
): Readonly<Record<string, unknown>> {
  const byKey = assertDefinitions(definitions);
  const loaded: Record<string, unknown> = {};
  for (const [key, definition] of byKey) {
    const rawValue = input[key];
    const value =
      rawValue === undefined && definition.defaultValue !== undefined
        ? definition.schema.parse(definition.defaultValue)
        : definition.schema.parse(rawValue);
    loaded[key] = value;
  }
  return Object.freeze(loaded);
}
