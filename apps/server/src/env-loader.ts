import { type EnvDefinition, loadDeclaredEnv } from "@fenix/platform-sdk";
import { type Env, parseEnv } from "./env";

/**
 * 宿主已加载的 env：宿主 schema 声明的字段（`Env`）+ 启用的模块声明的字段（`Record<string, unknown>`）。
 *
 * 装配层只应消费本类型，不要退回裸 `Env`——那会丢掉模块声明的那部分字段，也会让「某个键到底由谁声明」
 * 在类型上被抹平。
 */
export type ServerEnv = ReturnType<typeof loadServerEnv>;

/**
 * 拒绝宿主与模块声明同一个键。
 *
 * 合并顺序（模块值在后）会让重名时**静默**覆盖宿主值：同一个变量出现两个默认值/两套校验，
 * 谁生效取决于求值顺序而不是设计。§5.2 只规定了模块之间的契约冲突，这里把口径收紧到「同名即失败」，
 * 理由是 §10.1.1 要求 app 与 package 不出现重复实现——迁移模块专属变量时同批从
 * `apps/server/src/env.ts` 删除，再交给对应模块声明。
 */
function assertNoHostKeyOverride(
  definitions: readonly EnvDefinition[],
  hostEnv: Readonly<Record<string, unknown>>,
): void {
  const collisions = definitions.filter((definition) => Object.hasOwn(hostEnv, definition.key));
  if (collisions.length > 0) {
    throw new Error(
      `环境变量 ${collisions.map((definition) => definition.key).join("、")} 同时由宿主 env schema 与模块声明提供；` +
        "同一变量只能有一个声明处，请从 apps/server/src/env.ts 删除后交由对应模块声明",
    );
  }
}

/**
 * server 唯一环境加载边界：先解析宿主配置，再解析静态 assembly 启用模块声明。
 * 模块只能消费返回对象，不能在 factory 内读取 process.env。
 */
export function loadServerEnv(
  definitions: readonly EnvDefinition[],
  input: Readonly<Record<string, unknown>> = process.env,
): Readonly<Record<string, unknown>> & Env {
  const hostEnv = parseEnv(input);
  assertNoHostKeyOverride(definitions, hostEnv);
  const moduleEnv = loadDeclaredEnv(definitions, input);
  return Object.freeze({ ...hostEnv, ...moduleEnv });
}
