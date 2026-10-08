import { describe, expect, test } from "bun:test";
import { isCatalogType, isContainerType, uiSpecCatalog } from "../chat/ui-spec/catalog";
import { parseUISpec, resolveElement } from "../chat/ui-spec/parse";
import { UI_SPEC_LIMITS as L } from "../chat/ui-spec/spec";

/** 生成 rows：行数 rows 行、每行 cols 个单元格。 */
function cells(rows: number, cols: number): string[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => "x"));
}

describe("uiSpecCatalog：目录与类型名", () => {
  // 切片 1 只宣传 Stack / Text / Table：多一个类型就意味着 skill 文档与实际能力不一致
  test("目录键集合为 Stack / Table / Text", () => {
    expect(Object.keys(uiSpecCatalog).sort()).toEqual(["Stack", "Table", "Text"]);
  });

  // 原型名不是已知类型：查表必须用 own-property，不能顺原型链误判
  test("原型名不算已知类型", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(isCatalogType(name)).toBe(false);
    }
    expect(isCatalogType("Stack")).toBe(true);
  });

  // 只有 Stack 是容器：叶节点不能带非空 children（该规则在 parse 层整块校验）
  test("容器标记只有 Stack", () => {
    expect(isContainerType("Stack")).toBe(true);
    expect(isContainerType("Text")).toBe(false);
    expect(isContainerType("Table")).toBe(false);
    expect(isContainerType("__proto__")).toBe(false);
  });
});

describe("resolveElement：目录判定", () => {
  // 未收录 type → unsupported：占位显示受限类型名，原类型名原样回传
  test("未知 type → unsupported", () => {
    expect(resolveElement({ type: "Chart" })).toEqual({ status: "unsupported", type: "Chart" });
    expect(resolveElement({ type: "__proto__" })).toEqual({ status: "unsupported", type: "__proto__" });
    expect(resolveElement({ type: "Grid" })).toEqual({ status: "unsupported", type: "Grid" });
  });

  // 已收录 type 的未知字段不被剥离：strict schema 直接判 invalid-props（禁止用 raw props 渲染）
  test("未知 props 字段 → invalid-props", () => {
    expect(resolveElement({ type: "Text", props: { text: "hi", onClick: "x" } })).toEqual({
      status: "invalid-props",
      type: "Text",
    });
    expect(resolveElement({ type: "Stack", props: { gap: "md", envId: "other" } })).toEqual({
      status: "invalid-props",
      type: "Stack",
    });
  });

  // 枚举/类型错误同样 invalid-props，不静默回退默认值
  test("枚举与类型错误 → invalid-props", () => {
    expect(resolveElement({ type: "Stack", props: { gap: "xl" } })).toEqual({ status: "invalid-props", type: "Stack" });
    expect(resolveElement({ type: "Stack", props: { gap: 2 } })).toEqual({ status: "invalid-props", type: "Stack" });
    expect(resolveElement({ type: "Text", props: { text: "hi", tone: "warning" } })).toEqual({
      status: "invalid-props",
      type: "Text",
    });
    expect(resolveElement({ type: "Text", props: { text: 1 } })).toEqual({ status: "invalid-props", type: "Text" });
  });

  // 空内容不静默丢：空 Text / 空 Table 都占位（props 省略按 {}）
  test("空 Text / 空 Table → invalid-props", () => {
    expect(resolveElement({ type: "Text" })).toEqual({ status: "invalid-props", type: "Text" });
    expect(resolveElement({ type: "Text", props: {} })).toEqual({ status: "invalid-props", type: "Text" });
    expect(resolveElement({ type: "Text", props: { text: "" } })).toEqual({ status: "invalid-props", type: "Text" });
    expect(resolveElement({ type: "Table", props: {} })).toEqual({ status: "invalid-props", type: "Table" });
    expect(resolveElement({ type: "Table", props: { columns: [], rows: [] } })).toEqual({
      status: "invalid-props",
      type: "Table",
    });
    expect(resolveElement({ type: "Table", props: { columns: ["a"] } })).toEqual({
      status: "invalid-props",
      type: "Table",
    });
  });

  // 省略 gap / tone 时按目录默认值补齐，渲染层不再自己补默认值
  test("默认值归一：gap→md、tone→default", () => {
    expect(resolveElement({ type: "Stack" })).toEqual({
      status: "ok",
      type: "Stack",
      props: { gap: "md" },
      children: [],
    });
    expect(resolveElement({ type: "Text", props: { text: "hi" } })).toEqual({
      status: "ok",
      type: "Text",
      props: { text: "hi", tone: "default" },
      children: [],
    });
    expect(resolveElement({ type: "Stack", props: { gap: "lg" } })).toEqual({
      status: "ok",
      type: "Stack",
      props: { gap: "lg" },
      children: [],
    });
  });

  // children 缺省按 []，且回传拷贝，渲染层拿不到解析结果内部的数组引用
  test("children 归一为数组拷贝", () => {
    const children = ["a"];
    const resolved = resolveElement({ type: "Stack", children });
    expect(resolved).toEqual({ status: "ok", type: "Stack", props: { gap: "md" }, children: ["a"] });
    expect(resolved.status === "ok" ? resolved.children : []).not.toBe(children);
  });
});

describe("resolveElement：Table 跨字段约束", () => {
  // 表格必须矩形：每行长度等于列数，否则元素占位（兄弟继续）
  test("表格非矩形 → invalid-props", () => {
    expect(resolveElement({ type: "Table", props: { columns: ["a", "b"], rows: [["1"]] } })).toEqual({
      status: "invalid-props",
      type: "Table",
    });
    expect(resolveElement({ type: "Table", props: { columns: ["a"], rows: [["1", "2"]] } })).toEqual({
      status: "invalid-props",
      type: "Table",
    });
  });

  // align 缺省按全 left；存在时长度必须等于列数
  test("align 缺省与长度约束", () => {
    expect(resolveElement({ type: "Table", props: { columns: ["a", "b"], rows: [["1", "2"]] } })).toEqual({
      status: "ok",
      type: "Table",
      props: { columns: ["a", "b"], rows: [["1", "2"]], align: ["left", "left"] },
      children: [],
    });
    expect(
      resolveElement({ type: "Table", props: { columns: ["a", "b"], rows: [["1", "2"]], align: ["right"] } }),
    ).toEqual({ status: "invalid-props", type: "Table" });
    expect(
      resolveElement({ type: "Table", props: { columns: ["a", "b"], rows: [["1", "2"]], align: ["right", "left"] } })
        .status,
    ).toBe("ok");
  });

  // 行列超限属于 L3 元素级占位（整块限额在 parse 层另有口径）
  test("行列超限 → 元素占位", () => {
    expect(resolveElement({ type: "Table", props: { columns: ["a"], rows: cells(L.maxTableRows + 1, 1) } })).toEqual({
      status: "invalid-props",
      type: "Table",
    });
    expect(resolveElement({ type: "Table", props: { columns: ["a"], rows: cells(L.maxTableRows, 1) } }).status).toBe(
      "ok",
    );

    const tooManyCols = Array.from({ length: L.maxTableCols + 1 }, (_, index) => `c${index}`);
    expect(
      resolveElement({ type: "Table", props: { columns: tooManyCols, rows: cells(1, tooManyCols.length) } }),
    ).toEqual({ status: "invalid-props", type: "Table" });
  });

  // 表格文本各自的长度上限：caption / 列名 / 单元格
  test("caption 与单元格文本上限 → invalid-props", () => {
    const base = { columns: ["a"], rows: [["1"]] };
    expect(resolveElement({ type: "Table", props: { ...base, caption: "c".repeat(201) } })).toEqual({
      status: "invalid-props",
      type: "Table",
    });
    expect(resolveElement({ type: "Table", props: { columns: ["h".repeat(81)], rows: [["1"]] } })).toEqual({
      status: "invalid-props",
      type: "Table",
    });
    expect(resolveElement({ type: "Table", props: { columns: ["a"], rows: [["1".repeat(501)]] } })).toEqual({
      status: "invalid-props",
      type: "Table",
    });
    expect(resolveElement({ type: "Table", props: { ...base, caption: "c".repeat(200) } }).status).toBe("ok");
  });

  // 合法表格保留 caption，供渲染层输出说明文字
  test("合法表格保留 caption 与列顺序", () => {
    const resolved = resolveElement({
      type: "Table",
      props: { caption: "明细", columns: ["名称", "数量"], rows: [["甲", "1"]], align: ["left", "right"] },
    });
    expect(resolved).toEqual({
      status: "ok",
      type: "Table",
      props: {
        caption: "明细",
        columns: ["名称", "数量"],
        rows: [["甲", "1"]],
        align: ["left", "right"],
      },
      children: [],
    });
  });
});

describe("resolveElement：数据边界", () => {
  // 字符串一律是数据：HTML / 脚本片段原样保留，解析层不解析、不转义、不执行
  test("HTML 与脚本片段按文本原样保留", () => {
    const payload = '</script><img src=x onerror="alert(1)">';
    expect(resolveElement({ type: "Text", props: { text: payload } })).toEqual({
      status: "ok",
      type: "Text",
      props: { text: payload, tone: "default" },
      children: [],
    });
  });

  // props 里的 __proto__ 键只是数据：strict schema 拒绝它，且不污染任何对象原型
  test("props 的 __proto__ 键不污染原型", () => {
    const polluted = JSON.parse('{"__proto__":{"pollutedBySpec":true}}') as Record<string, unknown>;
    expect(resolveElement({ type: "Stack", props: polluted })).toEqual({ status: "invalid-props", type: "Stack" });
    expect(({} as Record<string, unknown>).pollutedBySpec).toBeUndefined();
  });

  // 纯逻辑层的端到端：parse 成功产物逐元素 resolve，未知类型只占位、兄弟继续
  test("parse 产物逐元素 resolve", () => {
    const code =
      '{"version":1,"root":"root","elements":{"root":{"type":"Stack","children":["t","c"]},' +
      '"t":{"type":"Text","props":{"text":"hi"}},"c":{"type":"Chart"}}}';
    const parsed = parseUISpec(code);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(resolveElement(parsed.spec.elements.root)).toEqual({
      status: "ok",
      type: "Stack",
      props: { gap: "md" },
      children: ["t", "c"],
    });
    expect(resolveElement(parsed.spec.elements.t).status).toBe("ok");
    expect(resolveElement(parsed.spec.elements.c)).toEqual({ status: "unsupported", type: "Chart" });
  });
});
