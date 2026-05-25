/**
 * Inputs 解析器 — 解析 inputs 表达式并生成 Shell 环境变量 / Python 变量注入代码。
 */

import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { EvalContext } from "../types/expression";
import { evaluateExpression, parseExpression } from "./expression-parser";

/** 解析后的单个 input */
export interface ResolvedInput {
  value: unknown;
  rawExpression: string;
}

/**
 * 解析 inputs 映射中的所有表达式，返回解析结果。
 */
export function resolveInputs(inputs: Record<string, string>, context: EvalContext): Record<string, ResolvedInput> {
  const resolved: Record<string, ResolvedInput> = {};
  for (const [key, expr] of Object.entries(inputs)) {
    try {
      const ast = parseExpression(expr);
      const value = evaluateExpression(ast, context);
      resolved[key] = { value, rawExpression: expr };
    } catch (err) {
      if (err instanceof WorkflowError) throw err;
      throw new WorkflowError(
        `Failed to resolve input '${key}': ${(err as Error).message}`,
        WorkflowErrorCode.INVALID_EXPRESSION,
        { key, expression: expr },
      );
    }
  }
  return resolved;
}

/**
 * 将解析后的 inputs 转为 Shell 环境变量映射。
 * 所有值统一转为字符串。
 */
export function generateShellEnvVars(resolved: Record<string, ResolvedInput>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, { value }] of Object.entries(resolved)) {
    if (value === null || value === undefined) {
      env[key] = "";
    } else if (typeof value === "object") {
      env[key] = JSON.stringify(value);
    } else {
      env[key] = String(value);
    }
  }
  return env;
}

/**
 * 将解析后的 inputs 生成为 Python 变量赋值代码。
 * - 简单值（字符串/数字/布尔/null）用 Python 字面量
 * - 复杂值（对象/数组）用 json.loads()
 */
export function generatePythonPreamble(resolved: Record<string, ResolvedInput>): string {
  const entries = Object.entries(resolved);
  if (entries.length === 0) return "";

  const lines: string[] = [];
  let needsJsonImport = false;

  for (const [varName, { value }] of entries) {
    if (value === null || value === undefined) {
      lines.push(`${varName} = None`);
    } else if (typeof value === "string") {
      lines.push(`${varName} = ${JSON.stringify(value)}`);
    } else if (typeof value === "number") {
      lines.push(`${varName} = ${value}`);
    } else if (typeof value === "boolean") {
      lines.push(`${varName} = ${value ? "True" : "False"}`);
    } else {
      needsJsonImport = true;
      const jsonStr = JSON.stringify(value);
      const escaped = jsonStr.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      lines.push(`${varName} = json.loads('${escaped}')`);
    }
  }

  if (needsJsonImport) {
    lines.unshift("import json");
  }

  return lines.join("\n");
}
