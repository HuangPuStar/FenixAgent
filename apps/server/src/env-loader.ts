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
 * server 唯一环境加载边界：先解析宿主配置，再解析静态 assembly 启用模块声明。
 * 模块只能消费返回对象，不能在 factory 内读取 process.env。
 */
export function loadServerEnv(
  definitions: readonly EnvDefinition[],
  input: Readonly<Record<string, unknown>> = process.env,
): Readonly<Record<string, unknown>> & Env {
  const hostEnv = parseEnv(input);
  const moduleEnv = loadDeclaredEnv(definitions, input);
  return Object.freeze({ ...hostEnv, ...moduleEnv });
}
