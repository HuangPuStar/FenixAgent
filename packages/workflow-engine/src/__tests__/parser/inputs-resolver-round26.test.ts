import { expect, test } from "bun:test";
import { evaluateExpression, parseExpression, resolveTemplate } from "../../parser/expression-parser";
import { generatePythonPreamble, generateShellEnvVars, resolveInputs } from "../../parser/inputs-resolver";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";
import type { EvalContext } from "../../types/expression";

const context: EvalContext = {
  nodes: {
    build: {
      output: {
        count: 3,
        enabled: true,
        items: ["zero", "one"],
        plain: { nested: "value" },
        simplified: "summary",
        stdout: "output",
      },
      status: "COMPLETED",
    },
  },
  params: { empty: "", name: "fenix", zero: 0 },
  secrets: { TOKEN: "token-value" },
};

function evaluate(source: string): unknown {
  return evaluateExpression(parseExpression(source), context);
}

// 验证数字字面量协议能够保留整数类型。
test("表达式解析整数", () => {
  expect(evaluate("42")).toBe(42);
});

// 验证负数词法分支能够生成负数值。
test("表达式解析负数", () => {
  expect(evaluate("-1.5")).toBe(-1.5);
});

// 验证单引号字符串可作为协议字面量。
test("表达式解析单引号字符串", () => {
  expect(evaluate("'hello'")).toBe("hello");
});

// 验证双引号字符串可作为协议字面量。
test("表达式解析双引号字符串", () => {
  expect(evaluate('"hello"')).toBe("hello");
});

// 验证 true 关键字解析为布尔真。
test("表达式解析 true", () => {
  expect(evaluate("true")).toBe(true);
});

// 验证 false 关键字解析为布尔假。
test("表达式解析 false", () => {
  expect(evaluate("false")).toBe(false);
});

// 验证 null 关键字解析为空值。
test("表达式解析 null", () => {
  expect(evaluate("null")).toBeNull();
});

// 验证节点状态可通过成员访问读取。
test("表达式读取节点状态", () => {
  expect(evaluate("nodes.build.status")).toBe("COMPLETED");
});

// 验证数组可按数字下标访问。
test("表达式读取数组下标", () => {
  expect(evaluate("nodes.build.output.items[1]")).toBe("one");
});

// 验证对象可按字符串下标访问。
test("表达式读取对象下标", () => {
  expect(evaluate("params['name']")).toBe("fenix");
});

// 验证越界数组访问安全返回 null。
test("表达式越界数组访问返回 null", () => {
  expect(evaluate("nodes.build.output.items[9]")).toBeNull();
});

// 验证数组使用字符串下标时安全返回 null。
test("表达式数组字符串下标返回 null", () => {
  expect(evaluate("nodes.build.output.items['0']")).toBeNull();
});

// 验证不存在的对象字段安全返回 null。
test("表达式不存在字段返回 null", () => {
  expect(evaluate("params.missing")).toBeNull();
});

// 验证缺失根命名空间按空值处理。
test("表达式缺失可选根返回 null", () => {
  expect(evaluateExpression(parseExpression("params.name"), {})).toBeNull();
});

// 验证禁止访问原型链字段。
test("表达式阻止原型链访问", () => {
  expect(() => evaluate("params.__proto__")).toThrow(WorkflowError);
});

// 验证未知根命名空间被拒绝。
test("表达式拒绝未知根命名空间", () => {
  expect(() => evaluate("process.env")).toThrow(WorkflowError);
});

// 验证一元非运算符反转真假值。
test("表达式一元非", () => {
  expect(evaluate("!nodes.build.output.enabled")).toBe(false);
});

// 验证严格相等比较。
test("表达式严格相等比较", () => {
  expect(evaluate("nodes.build.output.count == 3")).toBe(true);
});

// 验证严格不等比较。
test("表达式严格不等比较", () => {
  expect(evaluate("nodes.build.output.count != 3")).toBe(false);
});

// 验证大于比较。
test("表达式大于比较", () => {
  expect(evaluate("nodes.build.output.count > 2")).toBe(true);
});

// 验证小于等于比较。
test("表达式小于等于比较", () => {
  expect(evaluate("nodes.build.output.count <= 3")).toBe(true);
});

// 验证 null 参与排序比较时返回 false。
test("表达式 null 排序比较返回 false", () => {
  expect(evaluate("params.missing > 1")).toBe(false);
});

// 验证字符串拼接包含数字转换。
test("表达式字符串拼接数字", () => {
  expect(evaluate("params.name + '_' + nodes.build.output.count")).toBe("fenix_3");
});

// 验证纯数字加法保留数值语义。
test("表达式数字相加", () => {
  expect(evaluate("nodes.build.output.count + 2")).toBe(5);
});

// 验证逻辑与在左侧为假时返回左侧值。
test("表达式逻辑与短路返回左值", () => {
  expect(evaluate("params.empty && missing.value")).toBe("");
});

// 验证逻辑或在左侧为空时返回右侧值。
test("表达式逻辑或返回右值", () => {
  expect(evaluate("params.empty || params.name")).toBe("fenix");
});

// 验证三元表达式选择真分支。
test("表达式三元选择真分支", () => {
  expect(evaluate("nodes.build.output.enabled ? 'yes' : 'no'")).toBe("yes");
});

// 验证三元表达式选择假分支。
test("表达式三元选择假分支", () => {
  expect(evaluate("params.zero ? 'yes' : 'no'")).toBe("no");
});

// 验证非法字符产生 INVALID_EXPRESSION。
test("表达式非法字符报错", () => {
  try {
    parseExpression("params.name = 'x'");
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe(WorkflowErrorCode.INVALID_EXPRESSION);
  }
});

// 验证未闭合字符串产生解析错误。
test("表达式未闭合字符串报错", () => {
  expect(() => parseExpression("'unterminated")).toThrow("Unterminated string literal");
});

// 验证超长表达式被隔离拒绝。
test("表达式长度上限报错", () => {
  expect(() => parseExpression("x".repeat(1025))).toThrow("Expression exceeds max length");
});

// 验证模板保留没有占位符的普通文本。
test("模板保留普通文本", () => {
  expect(resolveTemplate("plain text", context)).toBe("plain text");
});

// 验证模板可替换多个独立占位符。
test("模板替换多个占位符", () => {
  expect(resolveTemplate("${{ params.name }}-${{ nodes.build.output.count }}", context)).toBe("fenix-3");
});

// 验证模板将 null 替换为空字符串。
test("模板将 null 替换为空字符串", () => {
  expect(resolveTemplate("x${{ params.missing }}y", context)).toBe("xy");
});

// 验证模板对象优先使用 simplified 输出。
test("模板对象优先 simplified", () => {
  expect(resolveTemplate("${{ nodes.build.output }}", context)).toBe("summary");
});

// 验证模板对象没有 simplified 时使用 stdout。
test("模板对象回退 stdout", () => {
  const stdoutContext: EvalContext = { params: { result: { stdout: "log" } } };
  expect(resolveTemplate("${{ params.result }}", stdoutContext)).toBe("log");
});

// 验证模板对象最终回退到 JSON。
test("模板对象回退 JSON", () => {
  expect(resolveTemplate("${{ nodes.build.output.plain }}", context)).toBe('{"nested":"value"}');
});

// 验证模板未闭合时不产生部分结果。
test("模板未闭合报错", () => {
  expect(() => resolveTemplate("before ${{ params.name", context)).toThrow("Unterminated");
});

// 验证单一模板保留对象原始类型。
test("输入单一模板保留对象类型", () => {
  const resolved = resolveInputs({ payload: "${{ nodes.build.output.plain }}" }, context);
  expect(resolved.payload).toEqual({ value: { nested: "value" }, rawExpression: "${{ nodes.build.output.plain }}" });
});

// 验证嵌套模板在内部表达式非法时抛出错误。
test("输入嵌套模板表达式非法时报错", () => {
  expect(() => resolveInputs({ text: "${{ params.name ${{ params.name }} }}" }, context)).toThrow(
    "Unexpected character",
  );
});

// 验证无效纯表达式回退为字面字符串。
test("输入无效表达式回退字面量", () => {
  const resolved = resolveInputs({ title: "workflow title" }, context);
  expect(resolved.title).toEqual({ value: "workflow title", rawExpression: "workflow title" });
});

// 验证输入解析保留每项原始表达式。
test("输入解析保留原始表达式", () => {
  const resolved = resolveInputs({ name: "params.name", token: "secrets.TOKEN" }, context);
  expect(resolved.name.rawExpression).toBe("params.name");
  expect(resolved.token.rawExpression).toBe("secrets.TOKEN");
});

// 验证输入模板中的求值错误会按原错误抛出。
test("输入解析保留 WorkflowError", () => {
  expect(() => resolveInputs({ bad: "${{ unknown.value }}" }, context)).toThrow("Undefined variable");
});

// 验证 Shell 环境变量处理 undefined。
test("Shell 环境变量将 undefined 转为空字符串", () => {
  expect(generateShellEnvVars({ value: { value: undefined, rawExpression: "x" } })).toEqual({ value: "" });
});

// 验证 Shell 环境变量序列化数组。
test("Shell 环境变量序列化数组", () => {
  expect(generateShellEnvVars({ items: { value: [1, "two"], rawExpression: "x" } })).toEqual({ items: '[1,"two"]' });
});

// 验证 Python 前导码处理 undefined。
test("Python 前导码将 undefined 转为 None", () => {
  expect(generatePythonPreamble({ value: { value: undefined, rawExpression: "x" } })).toBe("value = None");
});

// 验证 Python 前导码保留输入声明顺序。
test("Python 前导码保留声明顺序", () => {
  expect(
    generatePythonPreamble({ first: { value: 1, rawExpression: "x" }, second: { value: false, rawExpression: "x" } }),
  ).toBe("first = 1\nsecond = False");
});

// 验证 Python JSON 前导码转义反斜杠与单引号。
test("Python 前导码转义 JSON 字符", () => {
  const code = generatePythonPreamble({ data: { value: { path: "C:\\tmp\\it's" }, rawExpression: "x" } });
  expect(code).toContain("import json");
  expect(code).toContain("json.loads('");
  expect(code).toContain("\\\\");
  expect(code).toContain("\\'");
});
