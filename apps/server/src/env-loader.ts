import { type EnvDefinition, loadDeclaredEnv } from "@fenix/platform-sdk";
import { type Env, parseEnv } from "../../../src/env";

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
