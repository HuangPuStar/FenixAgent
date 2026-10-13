import { z } from "zod/v4";

const moduleIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

const assemblyProfileSchema = z.strictObject({
  /**
   * Identity 模块 ID。
   *
   * 必填：`packages/platform/identity` 是身份、组织与成员的唯一 owner，`AccessControlModule`
   * 需要经它产出可信 `ActorContext`（成员关系与系统托管租户），因此任何 profile 都不能
   * 以"无身份模块"的形态启动。
   */
  identity: moduleIdSchema,
  accessControl: moduleIdSchema,
  agentRuntime: moduleIdSchema,
  webShell: moduleIdSchema,
  resources: z.array(moduleIdSchema),
  web: z.array(moduleIdSchema),
});

/** CE、EE 与客户版本共用的静态装配 profile。 */
export interface AssemblyProfile {
  /** 见 {@link assemblyProfileSchema} 中 `identity` 的必填说明。 */
  readonly identity: string;
  readonly accessControl: string;
  readonly agentRuntime: string;
  readonly webShell: string;
  readonly resources: readonly string[];
  readonly web: readonly string[];
}

function assertUnique(ids: readonly string[], category: "资源" | "Web"): void {
  if (new Set(ids).size !== ids.length) {
    const label = category === "Web" ? " Web 模块" : `${category}模块`;
    throw new Error(`装配配置包含重复${label} ID`);
  }
}

/**
 * 解析部署侧提供的 profile。
 *
 * 该边界只接受稳定模块 ID；路径、URL、包名、表达式和额外加载字段都会被拒绝。
 */
export function parseAssemblyProfile(input: unknown): AssemblyProfile {
  const result = assemblyProfileSchema.safeParse(input);
  if (!result.success) throw new Error("装配配置格式非法", { cause: result.error });
  assertUnique(result.data.resources, "资源");
  assertUnique(result.data.web, "Web");
  return result.data;
}

/** 判断字符串是否符合静态装配 ID 约束。 */
export function isModuleId(value: string): boolean {
  return moduleIdSchema.safeParse(value).success;
}
