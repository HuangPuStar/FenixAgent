import { expect, test } from "bun:test";
import { evaluateExpression, parseExpression, resolveTemplate } from "../../parser/expression-parser";
import { type WorkflowError, WorkflowErrorCode } from "../../types/errors";
import type { EvalContext } from "../../types/expression";

const ctx: EvalContext = {
  nodes: {
    step1: { output: { stdout: "hello", exit_code: 0 }, status: "COMPLETED" },
    step2: { output: { stdout: "world", exit_code: 1 }, status: "FAILED" },
  },
  params: { input: "foo", count: 42 },
  secrets: { API_KEY: "secret123" },
};

// ---------- parseExpression ----------

// 解析标识符
test("解析标识符", () => {
  const ast = parseExpression("params");
  expect(ast.kind).toBe("identifier");
  expect((ast as { kind: "identifier"; name: string }).name).toBe("params");
});

// 解析成员访问
test("解析成员访问", () => {
  const ast = parseExpression("params.input");
  expect(ast.kind).toBe("member_access");
  const m = ast as { kind: "member_access"; object: unknown; property: string };
  expect(m.property).toBe("input");
});

// 解析深层成员访问
test("解析深层成员访问 nodes.step1.output.stdout", () => {
  const ast = parseExpression("nodes.step1.output.stdout");
  expect(ast.kind).toBe("member_access");
  const m = ast as { kind: "member_access"; property: string; object: unknown };
  expect(m.property).toBe("stdout");
});

// 解析数组索引
test("解析数组索引", () => {
  const ast = parseExpression("items[0]");
  expect(ast.kind).toBe("index_access");
});

// 解析比较运算
test("解析比较运算 ==", () => {
  const ast = parseExpression("params.count == 42");
  expect(ast.kind).toBe("binary");
  const b = ast as { kind: "binary"; op: string };
  expect(b.op).toBe("==");
});

// 解析逻辑运算
test("解析逻辑运算 &&", () => {
  const ast = parseExpression("a && b");
  expect(ast.kind).toBe("binary");
  const b = ast as { kind: "binary"; op: string };
  expect(b.op).toBe("&&");
});

// 解析三元表达式
test("解析三元表达式", () => {
  const ast = parseExpression("a ? b : c");
  expect(ast.kind).toBe("ternary");
});

// 解析非运算
test("解析非运算 !", () => {
  const ast = parseExpression("!a");
  expect(ast.kind).toBe("unary");
  const u = ast as { kind: "unary"; op: string };
  expect(u.op).toBe("!");
});

// 解析字符串字面量
test("解析字符串字面量", () => {
  const ast = parseExpression('"hello"');
  expect(ast.kind).toBe("literal");
  expect((ast as { kind: "literal"; value: unknown }).value).toBe("hello");
});

// 解析数字字面量
test("解析数字字面量", () => {
  const ast = parseExpression("42");
  expect(ast.kind).toBe("literal");
  expect((ast as { kind: "literal"; value: unknown }).value).toBe(42);
});

// 解析 null
test("解析 null", () => {
  const ast = parseExpression("null");
  expect(ast.kind).toBe("literal");
  expect((ast as { kind: "literal"; value: unknown }).value).toBe(null);
});

// 解析布尔值
test("解析布尔值 true/false", () => {
  const astTrue = parseExpression("true");
  expect((astTrue as { kind: "literal"; value: unknown }).value).toBe(true);
  const astFalse = parseExpression("false");
  expect((astFalse as { kind: "literal"; value: unknown }).value).toBe(false);
});

// 表达式过长
test("表达式超过 1024 字符报错", () => {
  const longExpr = "a".repeat(1025);
  try {
    parseExpression(longExpr);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.EXPRESSION_TOO_LONG);
  }
});

// 无效语法
test("无效语法报 INVALID_EXPRESSION", () => {
  try {
    parseExpression("..invalid");
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_EXPRESSION);
  }
});

// ---------- evaluateExpression ----------

// 求值 params 引用
test("求值 params.input", () => {
  const ast = parseExpression("params.input");
  expect(evaluateExpression(ast, ctx)).toBe("foo");
});

// 求值 params.count 数字
test("求值 params.count", () => {
  const ast = parseExpression("params.count");
  expect(evaluateExpression(ast, ctx)).toBe(42);
});

// 求值 nodes.step1.output.stdout
test("求值 nodes.step1.output.stdout", () => {
  const ast = parseExpression("nodes.step1.output.stdout");
  expect(evaluateExpression(ast, ctx)).toBe("hello");
});

// 求值 nodes.step1.status
test("求值 nodes.step1.status", () => {
  const ast = parseExpression("nodes.step1.status");
  expect(evaluateExpression(ast, ctx)).toBe("COMPLETED");
});

// 求值 secrets.KEY
test("求值 secrets.API_KEY", () => {
  const ast = parseExpression("secrets.API_KEY");
  expect(evaluateExpression(ast, ctx)).toBe("secret123");
});

// null 语义：不存在的属性返回 null
test("不存在的属性返回 null", () => {
  const ast = parseExpression("params.nonexistent");
  expect(evaluateExpression(ast, ctx)).toBe(null);
});

// null 语义：null 在其他比较中 → false
test("null 在其他比较中为 false", () => {
  const ast = parseExpression("null > 0");
  expect(evaluateExpression(ast, ctx)).toBe(false);
});

// null 排序比较语义：null 参与任何 > < >= <= 比较一律返回 false
test("null > 任何值返回 false", () => {
  expect(evaluateExpression(parseExpression("null > -1"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null > 0"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null > 1"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null > null"), ctx)).toBe(false);
});

test("null < 任何值返回 false", () => {
  expect(evaluateExpression(parseExpression("null < -1"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null < 0"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null < 1"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null < null"), ctx)).toBe(false);
});

test("null >= 任何值返回 false", () => {
  expect(evaluateExpression(parseExpression("null >= -1"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null >= 0"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null >= 1"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null >= null"), ctx)).toBe(false);
});

test("null <= 任何值返回 false", () => {
  expect(evaluateExpression(parseExpression("null <= -1"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null <= 0"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null <= 1"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null <= null"), ctx)).toBe(false);
});

// null 等值比较语义：null == null → true，null != null → false，null == 其他 → false
test("null == null 为 true", () => {
  expect(evaluateExpression(parseExpression("null == null"), ctx)).toBe(true);
});

test("null != null 为 false", () => {
  expect(evaluateExpression(parseExpression("null != null"), ctx)).toBe(false);
});

test("null == 字符串返回 false", () => {
  expect(evaluateExpression(parseExpression('null == "string"'), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression('null == ""'), ctx)).toBe(false);
});

test("null == 数字返回 false", () => {
  expect(evaluateExpression(parseExpression("null == 0"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("null == 1"), ctx)).toBe(false);
});

test("null != 非null值返回 true", () => {
  expect(evaluateExpression(parseExpression('null != "string"'), ctx)).toBe(true);
  expect(evaluateExpression(parseExpression("null != 0"), ctx)).toBe(true);
  expect(evaluateExpression(parseExpression("null != false"), ctx)).toBe(true);
});

// 比较运算
test("比较运算 > < >= <=", () => {
  expect(evaluateExpression(parseExpression("params.count > 10"), ctx)).toBe(true);
  expect(evaluateExpression(parseExpression("params.count < 10"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("params.count >= 42"), ctx)).toBe(true);
  expect(evaluateExpression(parseExpression("params.count <= 42"), ctx)).toBe(true);
});

// 等值运算
test("等值运算 == !=", () => {
  expect(evaluateExpression(parseExpression('params.input == "foo"'), ctx)).toBe(true);
  expect(evaluateExpression(parseExpression('params.input != "bar"'), ctx)).toBe(true);
});

// 逻辑运算
test("逻辑运算 && ||", () => {
  expect(evaluateExpression(parseExpression("true && true"), ctx)).toBe(true);
  expect(evaluateExpression(parseExpression("true && false"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("false || true"), ctx)).toBe(true);
  expect(evaluateExpression(parseExpression("false || false"), ctx)).toBe(false);
});

// 非运算
test("非运算 !", () => {
  expect(evaluateExpression(parseExpression("!true"), ctx)).toBe(false);
  expect(evaluateExpression(parseExpression("!false"), ctx)).toBe(true);
  expect(evaluateExpression(parseExpression("!null"), ctx)).toBe(true);
});

// 三元表达式
test("三元表达式", () => {
  expect(evaluateExpression(parseExpression('true ? "yes" : "no"'), ctx)).toBe("yes");
  expect(evaluateExpression(parseExpression('false ? "yes" : "no"'), ctx)).toBe("no");
});

// 字符串拼接
test("字符串拼接 +", () => {
  expect(evaluateExpression(parseExpression('"hello" + " " + "world"'), ctx)).toBe("hello world");
});

// 混合类型拼接（字符串 + null）
test("字符串拼接 null", () => {
  expect(evaluateExpression(parseExpression('"value: " + params.nonexistent'), ctx)).toBe("value: ");
});

// 数组索引
test("数组索引访问", () => {
  const arrCtx: EvalContext = {
    params: { items: ["a", "b", "c"] },
  };
  expect(evaluateExpression(parseExpression("params.items[0]"), arrCtx)).toBe("a");
  expect(evaluateExpression(parseExpression("params.items[2]"), arrCtx)).toBe("c");
});

// 超出范围索引返回 null
test("超出范围索引返回 null", () => {
  const arrCtx: EvalContext = {
    params: { items: ["a"] },
  };
  expect(evaluateExpression(parseExpression("params.items[5]"), arrCtx)).toBe(null);
});

// 负数索引返回 null（不泄漏 undefined）
test("负数索引返回 null", () => {
  const arrCtx: EvalContext = {
    params: { items: ["a", "b", "c"] },
  };
  expect(evaluateExpression(parseExpression("params.items[-1]"), arrCtx)).toBe(null);
  expect(evaluateExpression(parseExpression("params.items[-999]"), arrCtx)).toBe(null);
});

// 未定义变量
test("未定义的命名空间报错", () => {
  try {
    evaluateExpression(parseExpression("undefined_var"), ctx);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.UNDEFINED_VARIABLE);
  }
});

// __proto__ 访问被阻止
test("__proto__ 访问被阻止", () => {
  try {
    evaluateExpression(parseExpression("params.__proto__"), ctx);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.UNDEFINED_VARIABLE);
  }
});

// constructor 访问被阻止
test("constructor 访问被阻止", () => {
  try {
    evaluateExpression(parseExpression("params.constructor"), ctx);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.UNDEFINED_VARIABLE);
  }
});

// prototype 访问被阻止
test("prototype 访问被阻止", () => {
  try {
    evaluateExpression(parseExpression("params.prototype"), ctx);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.UNDEFINED_VARIABLE);
  }
});

// 访问深度限制
test("超过最大访问深度报错", () => {
  let expr = "params";
  for (let i = 0; i < 12; i++) {
    expr += ".x";
  }
  const ast = parseExpression(expr);
  try {
    evaluateExpression(ast, ctx);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.EXPRESSION_TOO_DEEP);
  }
});

// ---------- resolveTemplate ----------

// 简单模板解析
test("解析简单模板", () => {
  const result = resolveTemplate("Hello ${{ params.input }}!", ctx);
  expect(result).toBe("Hello foo!");
});

// 多个表达式
test("解析多个表达式", () => {
  const result = resolveTemplate("${{ params.input }}-${{ params.count }}", ctx);
  expect(result).toBe("foo-42");
});

// null 值替换为空字符串
test("null 值替换为空字符串", () => {
  const result = resolveTemplate("value: ${{ params.nonexistent }}", ctx);
  expect(result).toBe("value: ");
});

// 无表达式原样返回
test("无表达式原样返回", () => {
  const result = resolveTemplate("plain text", ctx);
  expect(result).toBe("plain text");
});

// 节点输出引用
test("节点输出引用", () => {
  const result = resolveTemplate("Result: ${{ nodes.step1.output.stdout }}", ctx);
  expect(result).toBe("Result: hello");
});

// 节点状态引用
test("节点状态引用", () => {
  const result = resolveTemplate("Status: ${{ nodes.step1.status }}", ctx);
  expect(result).toBe("Status: COMPLETED");
});

// 复杂表达式在模板中
test("复杂表达式在模板中", () => {
  const result = resolveTemplate('Count is ${{ params.count > 10 ? "big" : "small" }}', ctx);
  expect(result).toBe("Count is big");
});

// 未闭合的 ${{ 报错
test("未闭合的 ${{ 报错", () => {
  try {
    resolveTemplate("hello ${{ unclosed", ctx);
    expect(true).toBe(false);
  } catch (e) {
    expect((e as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_EXPRESSION);
  }
});

// 空上下文
test("空上下文求值返回 null", () => {
  const emptyCtx: EvalContext = {};
  expect(evaluateExpression(parseExpression("params.x"), emptyCtx)).toBe(null);
  expect(evaluateExpression(parseExpression("nodes.a.output.stdout"), emptyCtx)).toBe(null);
});
