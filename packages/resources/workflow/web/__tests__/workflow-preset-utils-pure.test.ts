import { describe, expect, test } from "bun:test";
import { syncExpressionOnKeyRename, syncOutputOnRename } from "../pages/workflow/preset-utils";

describe("工作流 Transform output 改名同步", () => {
  // 应替换表达式中的独立标识符并同时改写同名 output key。
  test("替换简单字段引用", () => {
    expect(syncExpressionOnKeyRename({ result: "data.name" }, "name", "title")).toEqual({ result: "data.title" });
  });

  // 被改名的 output key 本身必须切换到新 key。
  test("改写同名 output key", () => {
    expect(syncExpressionOnKeyRename({ name: "name" }, "name", "title")).toEqual({ title: "title" });
  });

  // 无关联表达式应保持原文。
  test("保留无关表达式", () => {
    expect(syncExpressionOnKeyRename({ result: "data.age" }, "name", "title")).toEqual({ result: "data.age" });
  });

  // 空 output 是合法边界，改名不应产生字段。
  test("处理空 output", () => {
    expect(syncExpressionOnKeyRename({}, "name", "title")).toEqual({});
  });

  // 标识符前缀相同但不是完整词时不应误替换。
  test("不替换更长标识符的前缀", () => {
    expect(syncExpressionOnKeyRename({ result: "username + name" }, "name", "title")).toEqual({
      result: "username + title",
    });
  });

  // 标识符后缀相同但不是完整词时不应误替换。
  test("不替换更长标识符的后缀", () => {
    expect(syncExpressionOnKeyRename({ result: "nameTag + name" }, "name", "title")).toEqual({
      result: "nameTag + title",
    });
  });

  // 下划线属于词字符，避免替换 snake_case 的局部片段。
  test("不替换下划线标识符中的局部字段", () => {
    expect(syncExpressionOnKeyRename({ result: "user_name + name" }, "name", "title")).toEqual({
      result: "user_name + title",
    });
  });

  // 数字属于词字符，避免替换字段版本号的一部分。
  test("不替换数字相邻的局部字段", () => {
    expect(syncExpressionOnKeyRename({ result: "name2 + name" }, "name", "title")).toEqual({
      result: "name2 + title",
    });
  });

  // 点访问后的字段应被识别为独立标识符。
  test("替换点访问字段", () => {
    expect(syncExpressionOnKeyRename({ result: "record.name" }, "name", "title")).toEqual({ result: "record.title" });
  });

  // 方括号内未加引号的字段应被替换。
  test("替换方括号表达式字段", () => {
    expect(syncExpressionOnKeyRename({ result: "record[name]" }, "name", "title")).toEqual({ result: "record[title]" });
  });

  // 比较表达式两侧的字段引用都应同步。
  test("替换比较表达式字段", () => {
    expect(syncExpressionOnKeyRename({ result: "name >= name" }, "name", "title")).toEqual({
      result: "title >= title",
    });
  });

  // 多次出现的独立字段必须全部替换。
  test("替换表达式中的全部出现位置", () => {
    expect(syncExpressionOnKeyRename({ result: "name + name + name" }, "name", "title")).toEqual({
      result: "title + title + title",
    });
  });

  // 嵌套函数调用中的字段引用应同步。
  test("替换函数调用参数", () => {
    expect(syncExpressionOnKeyRename({ result: "trim(name).toLowerCase()" }, "name", "title")).toEqual({
      result: "trim(title).toLowerCase()",
    });
  });

  // 对象字面量的属性简写引用应同步。
  test("替换对象字面量简写字段", () => {
    expect(syncExpressionOnKeyRename({ result: "({ name })" }, "name", "title")).toEqual({ result: "({ title })" });
  });

  // 多个 output 字段中的引用都应同步。
  test("同步多个 output 表达式", () => {
    expect(syncExpressionOnKeyRename({ first: "name", second: "name.length" }, "name", "title")).toEqual({
      first: "title",
      second: "title.length",
    });
  });

  // 仅 key 命中时仍应改名，即使表达式不引用旧 key。
  test("仅改名不相关表达式的 key", () => {
    expect(syncExpressionOnKeyRename({ name: "constant" }, "name", "title")).toEqual({ title: "constant" });
  });

  // 新旧 key 相同时，内容和值应稳定。
  test("相同 key 改名保持稳定", () => {
    expect(syncExpressionOnKeyRename({ name: "name" }, "name", "name")).toEqual({ name: "name" });
  });

  // 含正则元字符的旧 key 需要按字面量处理。
  test("转义点号元字符", () => {
    expect(syncExpressionOnKeyRename({ result: "a.b + aXb" }, "a.b", "next")).toEqual({ result: "next + aXb" });
  });

  // 非词字符 key 无法满足标识符词边界约束，因此保持原表达式。
  test("星号 key 不跨越标识符边界", () => {
    expect(syncExpressionOnKeyRename({ result: "item* + item" }, "item*", "next")).toEqual({ result: "item* + item" });
  });

  // 加号不可被当作量词，必须按字面量匹配。
  test("转义加号元字符", () => {
    expect(syncExpressionOnKeyRename({ result: "a+b + ab" }, "a+b", "next")).toEqual({ result: "next + ab" });
  });

  // 非词字符 key 无法满足标识符词边界约束，因此保持原表达式。
  test("问号 key 不跨越标识符边界", () => {
    expect(syncExpressionOnKeyRename({ result: "item? + item" }, "item?", "next")).toEqual({ result: "item? + item" });
  });

  // 非词字符 key 无法满足标识符词边界约束，因此保持原表达式。
  test("圆括号 key 不跨越标识符边界", () => {
    expect(syncExpressionOnKeyRename({ result: "item(1) + item1" }, "item(1)", "next")).toEqual({
      result: "item(1) + item1",
    });
  });

  // 非词字符 key 无法满足标识符词边界约束，因此保持原表达式。
  test("方括号 key 不跨越标识符边界", () => {
    expect(syncExpressionOnKeyRename({ result: "item[1] + item1" }, "item[1]", "next")).toEqual({
      result: "item[1] + item1",
    });
  });

  // 非词字符 key 无法满足标识符词边界约束，因此保持原表达式。
  test("花括号 key 不跨越标识符边界", () => {
    expect(syncExpressionOnKeyRename({ result: "item{1} + item" }, "item{1}", "next")).toEqual({
      result: "item{1} + item",
    });
  });

  // 竖线不可形成分支，必须按字面量匹配。
  test("转义竖线元字符", () => {
    expect(syncExpressionOnKeyRename({ result: "left|right + left" }, "left|right", "next")).toEqual({
      result: "next + left",
    });
  });

  // 反斜杠不可改变匹配语义，必须按字面量匹配。
  test("转义反斜杠元字符", () => {
    expect(syncExpressionOnKeyRename({ result: String.raw`a\\b + ab` }, String.raw`a\\b`, "next")).toEqual({
      result: "next + ab",
    });
  });

  // 当前规则使用 ASCII 词边界，Unicode 字段不会被当作独立标识符而保持原样。
  test("中文 key 不跨越 ASCII 词边界", () => {
    expect(syncExpressionOnKeyRename({ result: "姓名 + 姓名" }, "姓名", "标题")).toEqual({ result: "姓名 + 姓名" });
  });

  // 连字符两侧是词边界，字段引用应被同步。
  test("替换连字符相邻字段", () => {
    expect(syncExpressionOnKeyRename({ result: "name-value" }, "name", "title")).toEqual({ result: "title-value" });
  });

  // 原始输入对象必须不被函数写入。
  test("单次改名不修改输入对象", () => {
    const output = { name: "name", other: "name.length" };
    const snapshot = { ...output };
    syncExpressionOnKeyRename(output, "name", "title");
    expect(output).toEqual(snapshot);
  });

  // 返回对象应独立于输入对象，避免调用方写入结果时污染原值。
  test("单次改名返回新对象", () => {
    const output = { name: "name" };
    expect(syncExpressionOnKeyRename(output, "name", "title")).not.toBe(output);
  });

  // 无改名发生时应保留新 output 的全部字段。
  test("无差异时保留新 output", () => {
    expect(syncOutputOnRename({ name: "name" }, { name: "name", age: "age" })).toEqual({ name: "name", age: "age" });
  });

  // 单一删除和新增字段按位置形成一组改名映射。
  test("检测单个 key 改名", () => {
    expect(syncOutputOnRename({ name: "name" }, { title: "name" })).toEqual({ title: "title" });
  });

  // 改名应同步未改名字段表达式中的旧引用。
  test("同步其他字段对已改名 key 的引用", () => {
    expect(syncOutputOnRename({ name: "source", result: "name" }, { title: "source", result: "name" })).toEqual({
      title: "source",
      result: "title",
    });
  });

  // 多个删除和新增字段必须按对象键顺序一一映射。
  test("按键顺序同步多个改名", () => {
    expect(
      syncOutputOnRename({ first: "first + second", second: "second" }, { alpha: "first + second", beta: "second" }),
    ).toEqual({ alpha: "alpha + beta", beta: "beta" });
  });

  // 当新增 key 多于删除 key 时，多余 key 不应触发虚构改名。
  test("新增 key 多于删除 key 时只同步可配对项", () => {
    expect(syncOutputOnRename({ name: "name" }, { title: "name", extra: "name" })).toEqual({
      title: "title",
      extra: "title",
    });
  });

  // 当删除 key 多于新增 key 时，只处理可配对的首个字段。
  test("删除 key 多于新增 key 时只同步可配对项", () => {
    expect(syncOutputOnRename({ first: "first + second", second: "second" }, { title: "first + second" })).toEqual({
      title: "title + second",
    });
  });

  // 删除而未新增时不应改写现存输出。
  test("仅删除 key 时保留新 output 内容", () => {
    expect(syncOutputOnRename({ name: "name", result: "name" }, { result: "name" })).toEqual({ result: "name" });
  });

  // 仅新增而未删除时不应重写表达式。
  test("仅新增 key 时保留表达式", () => {
    expect(syncOutputOnRename({ result: "name" }, { result: "name", title: "name" })).toEqual({
      result: "name",
      title: "name",
    });
  });

  // 空旧 output 添加字段时应直接返回新字段。
  test("空旧 output 添加字段", () => {
    expect(syncOutputOnRename({}, { title: "source" })).toEqual({ title: "source" });
  });

  // 空新 output 删除字段时应返回空映射。
  test("空新 output 删除字段", () => {
    expect(syncOutputOnRename({ title: "source" }, {})).toEqual({});
  });

  // 两个空映射是合法边界。
  test("两个空 output 保持为空", () => {
    expect(syncOutputOnRename({}, {})).toEqual({});
  });

  // 未变更 key 的表达式若引用旧 key，必须随改名同步。
  test("保留 key 的表达式引用会同步", () => {
    expect(syncOutputOnRename({ source: "source", result: "source" }, { target: "source", result: "source" })).toEqual({
      target: "target",
      result: "target",
    });
  });

  // 改名链中的后续同步应作用于前一次的转换结果。
  test("多个改名按顺序级联同步", () => {
    expect(
      syncOutputOnRename({ first: "first + second", second: "second" }, { alpha: "first + second", beta: "second" }),
    ).toEqual({ alpha: "alpha + beta", beta: "beta" });
  });

  // 新 key 恰好等于另一个旧 key 时，不应将其误判为新增。
  test("新 key 复用旧 key 时不触发错误映射", () => {
    expect(syncOutputOnRename({ first: "first", second: "second" }, { second: "second", third: "first" })).toEqual({
      second: "second",
      third: "third",
    });
  });

  // 旧 output 不应因同步过程而被修改。
  test("批量改名不修改旧 output", () => {
    const oldOutput = { name: "name", result: "name" };
    const oldSnapshot = { ...oldOutput };
    syncOutputOnRename(oldOutput, { title: "name", result: "name" });
    expect(oldOutput).toEqual(oldSnapshot);
  });

  // 新 output 不应因同步过程而被修改。
  test("批量改名不修改新 output", () => {
    const newOutput = { title: "name", result: "name" };
    const newSnapshot = { ...newOutput };
    syncOutputOnRename({ name: "name", result: "name" }, newOutput);
    expect(newOutput).toEqual(newSnapshot);
  });

  // 批量同步必须返回独立对象，保证上层状态更新可安全复用输入。
  test("批量改名返回新对象", () => {
    const newOutput = { title: "name" };
    expect(syncOutputOnRename({ name: "name" }, newOutput)).not.toBe(newOutput);
  });

  // 特殊字符 key 在批量改名中同样需要字面量匹配。
  test("批量改名转义特殊字符", () => {
    expect(syncOutputOnRename({ "a.b": "a.b + aXb" }, { next: "a.b + aXb" })).toEqual({ next: "next + aXb" });
  });

  // 批量改名应处理表达式内多次出现的字段。
  test("批量改名替换全部表达式引用", () => {
    expect(syncOutputOnRename({ name: "name" }, { title: "name + name + name" })).toEqual({
      title: "title + title + title",
    });
  });

  // 批量改名不应替换包含旧 key 的更长标识符。
  test("批量改名保留更长标识符", () => {
    expect(syncOutputOnRename({ name: "name" }, { title: "username + nameTag + name" })).toEqual({
      title: "username + nameTag + title",
    });
  });

  // 批量改名需支持 key 只是表达式中的数组索引。
  test("批量改名同步数组索引字段", () => {
    expect(syncOutputOnRename({ index: "index" }, { position: "items[index]" })).toEqual({
      position: "items[position]",
    });
  });

  // 批量改名的空表达式仍应改写 output key。
  test("批量改名处理空表达式", () => {
    expect(syncOutputOnRename({ name: "" }, { title: "" })).toEqual({ title: "" });
  });

  // 任意正常字符串输入都不应因转换过程抛出异常。
  test("改名转换不抛出异常", () => {
    expect(() => syncExpressionOnKeyRename({ result: "value" }, "value", "next")).not.toThrow();
  });
});
