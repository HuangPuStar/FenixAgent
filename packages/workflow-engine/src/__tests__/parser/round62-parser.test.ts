import { expect, test } from "bun:test";
import { evaluateExpression, parseExpression, resolveTemplate } from "../../parser/expression-parser";

const context = {
  nodes: {
    completed: { output: { stdout: "node-output", simplified: "node-summary" }, status: "COMPLETED" },
  },
  params: {
    decimal: 1.5,
    nested: { label: "nested-value", "hyphen-key": "indexed-value" },
    stdoutOnly: { stdout: "parameter-output" },
    items: ["first", "second"],
    empty: [],
  },
  secrets: { TOKEN: "local-token" },
};

// 验证负小数会被词法分析为单个数值字面量。
test("解析负小数", () => {
  expect(evaluateExpression(parseExpression("-1.25"), context)).toBe(-1.25);
});

// 验证表达式首尾和运算符附近的空白不改变求值结果。
test("忽略表达式空白", () => {
  expect(evaluateExpression(parseExpression("  params.decimal  +  0.5 "), context)).toBe(2);
});

// 验证括号可以改变连接与比较前的求值顺序。
test("括号控制拼接优先级", () => {
  expect(evaluateExpression(parseExpression('( "v" + 1 ) + 2'), context)).toBe("v12");
});

// 验证纯数字加法保留数值而非转换为字符串。
test("数字加法返回数值", () => {
  expect(evaluateExpression(parseExpression("2 + 3"), context)).toBe(5);
});

// 验证数组索引表达式可由三元表达式动态决定。
test("三元表达式可作为数组索引", () => {
  expect(evaluateExpression(parseExpression("params.items[true ? 1 : 0]"), context)).toBe("second");
});

// 验证对象支持以字符串索引访问包含连字符的键。
test("对象支持字符串索引", () => {
  expect(evaluateExpression(parseExpression('params.nested["hyphen-key"]'), context)).toBe("indexed-value");
});

// 验证对象使用数值索引时安全地返回 null。
test("对象数值索引返回 null", () => {
  expect(evaluateExpression(parseExpression("params.nested[0]"), context)).toBeNull();
});

// 验证数组使用字符串索引时安全地返回 null。
test("数组字符串索引返回 null", () => {
  expect(evaluateExpression(parseExpression('params.items["0"]'), context)).toBeNull();
});

// 验证空数组的边界索引不会泄漏 undefined。
test("空数组索引返回 null", () => {
  expect(evaluateExpression(parseExpression("params.empty[0]"), context)).toBeNull();
});

// 验证逻辑与短路时直接返回左侧的假值。
test("逻辑与返回左侧假值", () => {
  expect(evaluateExpression(parseExpression('"" && undefined_name'), context)).toBe("");
});

// 验证逻辑与仅在左侧真值时求值右侧。
test("逻辑与会求值右侧", () => {
  expect(() => evaluateExpression(parseExpression("true && undefined_name"), context)).toThrow("Undefined variable");
});

// 验证逻辑或短路时直接返回左侧的真值。
test("逻辑或返回左侧真值", () => {
  expect(evaluateExpression(parseExpression('"fallback" || undefined_name'), context)).toBe("fallback");
});

// 验证逻辑或仅在左侧假值时求值右侧。
test("逻辑或会求值右侧", () => {
  expect(() => evaluateExpression(parseExpression("false || undefined_name"), context)).toThrow("Undefined variable");
});

// 验证三元表达式不会求值未选择的错误分支。
test("三元表达式隔离未选择分支", () => {
  expect(evaluateExpression(parseExpression('true ? "safe" : undefined_name'), context)).toBe("safe");
});

// 验证嵌套三元表达式按右结合规则解析。
test("嵌套三元表达式右结合", () => {
  expect(evaluateExpression(parseExpression('false ? "a" : true ? "b" : "c"'), context)).toBe("b");
});

// 验证单独的按位与字符会被拒绝而非静默接受。
test("拒绝单独的与字符", () => {
  expect(() => parseExpression("true & false")).toThrow("Unexpected character");
});

// 验证单独的按位或字符会被拒绝而非静默接受。
test("拒绝单独的或字符", () => {
  expect(() => parseExpression("true | false")).toThrow("Unexpected character");
});

// 验证成员访问后的非标识符会产生语法错误。
test("拒绝无效成员名", () => {
  expect(() => parseExpression("params.1")).toThrow("Expected Ident");
});

// 验证比较表达式后的多余 token 不会被忽略。
test("拒绝表达式尾部多余 token", () => {
  expect(() => parseExpression("true false")).toThrow("Unexpected token after expression");
});

// 验证未闭合的双引号字符串会在词法阶段失败。
test("拒绝未闭合双引号字符串", () => {
  expect(() => parseExpression('"unterminated')).toThrow("Unterminated string literal");
});

// 验证对象模板值优先使用 simplified 字段。
test("模板对象优先使用 simplified", () => {
  expect(resolveTemplate("${{ nodes.completed.output }}", context)).toBe("node-summary");
});

// 验证仅含 stdout 的对象模板值使用 stdout 字段。
test("模板对象回退使用 stdout", () => {
  expect(resolveTemplate("${{ params.stdoutOnly }}", context)).toBe("parameter-output");
});

// 验证普通对象模板值回退为 JSON 字符串。
test("模板普通对象序列化为 JSON", () => {
  expect(resolveTemplate("${{ params.nested }}", context)).toBe(
    '{"label":"nested-value","hyphen-key":"indexed-value"}',
  );
});

// 验证布尔模板值会稳定转换为文本。
test("模板布尔值转换为文本", () => {
  expect(resolveTemplate("enabled=${{ true }}", context)).toBe("enabled=true");
});

// 验证相邻模板表达式分别求值且保留中间文本。
test("相邻模板表达式独立替换", () => {
  expect(resolveTemplate("${{ params.items[0] }}:${{ secrets.TOKEN }}", context)).toBe("first:local-token");
});

// 验证嵌套模板定界符不会被当作完整表达式静默解析。
test("拒绝嵌套模板定界符", () => {
  expect(() => resolveTemplate("${{ {{ params.decimal }} }}", context)).toThrow();
});

// 验证缺少结束定界符的模板会显式报错。
test("拒绝未结束模板", () => {
  expect(() => resolveTemplate("prefix ${{ params.decimal", context)).toThrow("Unterminated");
});
