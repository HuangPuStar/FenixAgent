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
 * 「声明键」的唯一读取入口（路线 A）。
 *
 * `loadServerEnv` 已经把各模块 `envDefinitions` 声明的键合并进返回对象，但 `ServerEnv` 的类型是
 * `Readonly<Record<string, unknown>> & Env`——声明键在类型上落回 `unknown`，宿主消费点直接 `env[key]`
 * 拿不到可用类型。本函数把这层窄化收敛到一处，供 C 块的全部消费点（C2–C18）统一使用。
 *
 * 只做类型收敛、**不二次校验**：值的校验已由 `loadServerEnv` 在启动期用声明方给出的 zod schema 完成，
 * 校验失败即启动失败，因此这里再 parse 一次只会重复同一份判定，并把「校验时机」这件事分裂成两处。
 * 类型参数 `T` 由调用方按 `EnvDefinition.schema` 的推断结果显式给出；调用方传错类型不会在运行期被兜住，
 * 这是为避免在每个消费点散布断言的取舍（注解里的 `as` 是全仓唯一一处声明键断言）。
 *
 * 不使用 `as any`：断言目标是调用方声明的具体类型，属 CLAUDE.md 允许的最小范围类型收窄
 * （第三方缺陷以外的 `any` 一律禁止）。
 *
 * 路线 A 下 `envDefinitions` 只承担「启动期校验 + 汇总」，值仍由宿主经 `bootstrap/module-configs.ts`
 * 手工投影成模块配置；本函数是宿主侧消费点（例如 `bootstrap/host-startup.ts` 的 Hermes 网关地址）
 * 读取声明键的通道。
 */
export function readDeclaredEnv<T>(env: ServerEnv, key: string): T {
  return env[key] as T;
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
