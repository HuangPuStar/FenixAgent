/**
 * Inputs 解析器 — 解析 inputs 表达式并生成 Shell 环境变量 / Python 变量注入代码。
 */

import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { EvalContext } from "../types/expression";
import { evaluateExpression, parseExpression, resolveTemplate } from "./expression-parser";

/** 解析后的单个 input */
export interface ResolvedInput {
  value: unknown;
  rawExpression: string;
}

/**
 * 检测字符串是否完全由单个 `${{ expr }}` 包裹。
 * 命中时返回内部表达式（保留原始类型）；否则返回 null。
 *
 * 例：`${{ params.x }}` → "params.x"；`${{ params.x }}/y` → null（需要模板拼接）
 */
function matchSingleTemplate(raw: string): string | null {
  const trimmed = raw.trim();
  // 注意 DOTALL：表达式内可能跨行
  const m = trimmed.match(/^\$\{\{([\s\S]+)\}\}$/);
  if (!m) return null;
  // 排除 "${{ a }} ${{ b }}" 这种多模板情形：内部不能再含 ${{ 或 }}，否则视为模板拼接
  const inner = m[1];
  if (inner.includes("${{") || inner.includes("}}")) return null;
  return inner.trim();
}

/**
 * 解析 inputs 映射中的所有表达式，返回解析结果。
 *
 * 兼容四种写法（让 yaml 既可写 `${{ }}` 模板也可写表达式，体验对齐 resolveTemplate）：
 * 1. 纯表达式：`params.x`、`nodes.fetch.output.count`、`'prefix_' + params.x`
 *    — 走 parseExpression，**保留求值原类型**（string/number/boolean/object）
 * 2. 单一模板：`${{ params.x }}` — 等价于纯表达式，保留原类型
 * 3. 拼接模板：`${{ params.x }}/path/${{ params.y }}.fq.gz` — 走 resolveTemplate，
 *    **结果一定是 string**
 * 4. 纯字面字符串：`PE RNA-Seq Report` — 不含 `${{ }}` 且不是合法表达式时，
 *    作为字面字符串返回（带 warn 日志，便于发现用户笔误）
 */
export function resolveInputs(inputs: Record<string, string>, context: EvalContext): Record<string, ResolvedInput> {
  const resolved: Record<string, ResolvedInput> = {};
  for (const [key, expr] of Object.entries(inputs)) {
    try {
      let value: unknown;
      const singleInner = matchSingleTemplate(expr);
      if (singleInner !== null) {
        // 单一 ${{ }} 模板 → 提取内部表达式求值，保留原类型
        const ast = parseExpression(singleInner);
        value = evaluateExpression(ast, context);
      } else if (expr.includes("${{")) {
        // 含 ${{ }} 但非单一模板 → 字符串拼接模板，结果是 string
        value = resolveTemplate(expr, context);
      } else {
        // 纯表达式（向后兼容旧 yaml 写法）
        // parseExpression 失败时 fallback 到字面字符串：兼容 yaml 中直接写
        // title: "PE RNA-Seq Report" 这种不带 ${{ }} 的字面值（用户友好）
        try {
          const ast = parseExpression(expr);
          value = evaluateExpression(ast, context);
        } catch (parseErr) {
          console.warn(
            `[resolveInputs] input '${key}' is not a valid expression, treating as literal string: ${(parseErr as Error).message}`,
          );
          value = expr;
        }
      }
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
