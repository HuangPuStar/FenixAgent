import { expect, test } from "bun:test";
import { generatePythonPreamble, generateShellEnvVars, resolveInputs } from "../../parser/inputs-resolver";
import type { EvalContext } from "../../types/expression";

const ctx: EvalContext = {
  nodes: {
    fetch: {
      output: { result: "hello", items: [1, 2, 3], count: 42, active: true },
      status: "COMPLETED",
    },
  },
  params: { name: "world" },
  secrets: { API_KEY: "secret123" },
};

// ---------- resolveInputs ----------

test("resolveInputs 解析简单路径引用", () => {
  const result = resolveInputs({ DATA: "nodes.fetch.output.result" }, ctx);
  expect(result.DATA.value).toBe("hello");
});

test("resolveInputs 解析 params 引用", () => {
  const result = resolveInputs({ NAME: "params.name" }, ctx);
  expect(result.NAME.value).toBe("world");
});

test("resolveInputs 解析 secrets 引用", () => {
  const result = resolveInputs({ KEY: "secrets.API_KEY" }, ctx);
  expect(result.KEY.value).toBe("secret123");
});

test("resolveInputs 解析数字值", () => {
  const result = resolveInputs({ COUNT: "nodes.fetch.output.count" }, ctx);
  expect(result.COUNT.value).toBe(42);
});

test("resolveInputs 解析布尔值", () => {
  const result = resolveInputs({ FLAG: "nodes.fetch.output.active" }, ctx);
  expect(result.FLAG.value).toBe(true);
});

test("resolveInputs 解析对象值", () => {
  const result = resolveInputs({ DATA: "nodes.fetch.output" }, ctx);
  expect(result.DATA.value).toEqual({
    result: "hello",
    items: [1, 2, 3],
    count: 42,
    active: true,
  });
});

test("resolveInputs 解析数组值", () => {
  const result = resolveInputs({ ITEMS: "nodes.fetch.output.items" }, ctx);
  expect(result.ITEMS.value).toEqual([1, 2, 3]);
});

test("resolveInputs 解析字符串拼接表达式", () => {
  const result = resolveInputs({ LABEL: "'prefix_' + nodes.fetch.output.result" }, ctx);
  expect(result.LABEL.value).toBe("prefix_hello");
});

test("resolveInputs 路径不存在返回 null", () => {
  const result = resolveInputs({ MISSING: "nodes.fetch.output.nonexistent" }, ctx);
  expect(result.MISSING.value).toBe(null);
});

test("resolveInputs 空输入返回空对象", () => {
  const result = resolveInputs({}, ctx);
  expect(Object.keys(result)).toHaveLength(0);
});

// ---------- generateShellEnvVars ----------

test("generateShellEnvVars 字符串值", () => {
  const env = generateShellEnvVars({ MY_VAR: { value: "hello", rawExpression: "x" } });
  expect(env).toEqual({ MY_VAR: "hello" });
});

test("generateShellEnvVars 数字值转为字符串", () => {
  const env = generateShellEnvVars({ COUNT: { value: 42, rawExpression: "x" } });
  expect(env).toEqual({ COUNT: "42" });
});

test("generateShellEnvVars 布尔值转为字符串", () => {
  const env = generateShellEnvVars({ FLAG: { value: true, rawExpression: "x" } });
  expect(env).toEqual({ FLAG: "true" });
});

test("generateShellEnvVars null 转为空字符串", () => {
  const env = generateShellEnvVars({ VAL: { value: null, rawExpression: "x" } });
  expect(env).toEqual({ VAL: "" });
});

test("generateShellEnvVars 对象值 JSON 序列化", () => {
  const env = generateShellEnvVars({
    DATA: { value: { result: "hello" }, rawExpression: "x" },
  });
  expect(env).toEqual({ DATA: '{"result":"hello"}' });
});

// ---------- generatePythonPreamble ----------

test("generatePythonPreamble 字符串值", () => {
  const code = generatePythonPreamble({ name: { value: "hello", rawExpression: "x" } });
  expect(code).toBe('name = "hello"');
});

test("generatePythonPreamble 数字值", () => {
  const code = generatePythonPreamble({ count: { value: 42, rawExpression: "x" } });
  expect(code).toBe("count = 42");
});

test("generatePythonPreamble 布尔值 True", () => {
  const code = generatePythonPreamble({ flag: { value: true, rawExpression: "x" } });
  expect(code).toBe("flag = True");
});

test("generatePythonPreamble 布尔值 False", () => {
  const code = generatePythonPreamble({ flag: { value: false, rawExpression: "x" } });
  expect(code).toBe("flag = False");
});

test("generatePythonPreamble null", () => {
  const code = generatePythonPreamble({ val: { value: null, rawExpression: "x" } });
  expect(code).toBe("val = None");
});

test("generatePythonPreamble 对象值用 json.loads", () => {
  const code = generatePythonPreamble({
    data: { value: { result: "hello" }, rawExpression: "x" },
  });
  expect(code).toContain("import json");
  expect(code).toContain("data = json.loads(");
});

test("generatePythonPreamble 数组值用 json.loads", () => {
  const code = generatePythonPreamble({
    items: { value: [1, 2, 3], rawExpression: "x" },
  });
  expect(code).toContain("import json");
  expect(code).toContain("items = json.loads(");
});

test("generatePythonPreamble 混合值只生成一个 import json", () => {
  const code = generatePythonPreamble({
    name: { value: "hello", rawExpression: "x" },
    data: { value: { x: 1 }, rawExpression: "x" },
    count: { value: 42, rawExpression: "x" },
  });
  const importCount = (code.match(/import json/g) || []).length;
  expect(importCount).toBe(1);
  expect(code).toContain('name = "hello"');
  expect(code).toContain("count = 42");
  expect(code).toContain("data = json.loads(");
});

test("generatePythonPreamble 字符串含双引号被转义", () => {
  const code = generatePythonPreamble({
    text: { value: 'say "hello"', rawExpression: "x" },
  });
  expect(code).toBe('text = "say \\"hello\\""');
});

test("generatePythonPreamble json.loads 中值含单引号", () => {
  const code = generatePythonPreamble({
    data: { value: { text: "it's fine" }, rawExpression: "x" },
  });
  expect(code).toContain("json.loads('");
  expect(code).toContain("it\\'s fine");
});

test("generatePythonPreamble 空输入返回空字符串", () => {
  const code = generatePythonPreamble({});
  expect(code).toBe("");
});
