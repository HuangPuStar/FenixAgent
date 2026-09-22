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
 * 把一次校验失败渲染成可定位的消息。
 *
 * 逐键 `schema.parse(单值)` 时 zod 的 `issue.path` 恒为空数组，错误消息里因此**不含键名**——宿主
 * `envSchema.parse(整个 input)` 天然带 path，声明键不能在同一条诊断上退化。这里把键名与声明模块补回来，
 * 并保留逐条 issue 的文案（zod 自己的 `error.message` 是整段 JSON，启动日志里不可读）。
 */
function describeParseFailure(key: string, moduleId: string, error: unknown): string {
  let details = `  - ${error instanceof Error ? error.message : String(error)}`;
  if (typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues)) {
    details = error.issues
      .map((issue: unknown) =>
        typeof issue === "object" && issue !== null && "message" in issue
          ? `  - ${String(issue.message)}`
          : "  - 校验失败",
      )
      .join("\n");
  }
  return `环境变量 ${key}（由模块 ${moduleId} 声明）校验失败:\n${details}`;
}

/**
 * 只读取并校验已启用模块声明的环境变量。
 *
 * 返回值按定义拆分前仍是扁平对象，bootstrap 会再按 manifest 注入模块；函数不记录
 * secret 值，也不会把未声明的 process.env 字段带入模块配置。
 *
 * 校验失败抛出的消息**必须含键名与声明模块**：声明键的校验在启动期是唯一的失败点，消息里没有键名会让
 * 部署只能靠逐个排除定位（见 `describeParseFailure` 的说明）。错误原样挂在 `cause` 上，调用方需要结构化
 * 的 zod issue 时可以取回。
 */
export function loadDeclaredEnv(
  definitions: readonly EnvDefinition[],
  input: Readonly<Record<string, unknown>> = process.env,
): Readonly<Record<string, unknown>> {
  const byKey = assertDefinitions(definitions);
  const loaded: Record<string, unknown> = {};
  for (const [key, definition] of byKey) {
    const rawValue = input[key];
    try {
      loaded[key] =
        rawValue === undefined && definition.defaultValue !== undefined
          ? definition.schema.parse(definition.defaultValue)
          : definition.schema.parse(rawValue);
    } catch (error) {
      throw new Error(describeParseFailure(key, definition.moduleId, error), { cause: error });
    }
  }
  return Object.freeze(loaded);
}
