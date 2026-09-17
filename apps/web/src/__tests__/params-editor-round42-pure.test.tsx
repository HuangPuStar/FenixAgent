import { expect, test } from "bun:test";

import {
  buildInitialExpandedState,
  type Column,
  filterData,
  paginateData,
  sortData,
} from "../../components/config/DataTable";

type Row = {
  id: string;
  name?: string | null;
  enabled?: boolean;
  score?: number | null;
  tag?: string;
};

const rows: Row[] = [
  { id: "alpha", name: "Alpha", enabled: true, score: 20, tag: "[stable]" },
  { id: "beta", name: "Beta", enabled: false, score: 5, tag: "draft" },
  { id: "empty", name: null, score: null },
];

const searchableColumns: Column<Row>[] = [
  { key: "name", header: "名称", filterable: true },
  { key: "enabled", header: "启用", filterable: true },
  { key: "tag", header: "标签", filterable: true },
];

// 搜索词本身的空格是查询内容的一部分，不能被静默裁剪。
test("filterData：保留非空搜索词两侧空格", () => {
  expect(filterData(rows, searchableColumns, " Alpha ")).toEqual([]);
});

// 布尔值应经字符串化后参与可搜索字段匹配。
test("filterData：匹配 true 布尔值", () => {
  expect(filterData(rows, searchableColumns, "true")).toEqual([rows[0]]);
});

// false 也是有效字段值，不能因假值而被跳过。
test("filterData：匹配 false 布尔值", () => {
  expect(filterData(rows, searchableColumns, "false")).toEqual([rows[1]]);
});

// 搜索文本中的正则字符只应按普通文本处理。
test("filterData：按字面量匹配方括号", () => {
  expect(filterData(rows, searchableColumns, "[stable]")).toEqual([rows[0]]);
});

// 可搜索字段的值为 null 时必须安全跳过，而不影响其他字段的命中。
test("filterData：跳过 null 后继续匹配同一行其他字段", () => {
  expect(filterData(rows, searchableColumns, "draft")).toEqual([rows[1]]);
});

// 过滤产生的新数组不应改变调用方数组的顺序。
test("filterData：过滤不修改输入数组", () => {
  const input = [...rows];

  filterData(input, searchableColumns, "a");

  expect(input.map((row) => row.id)).toEqual(["alpha", "beta", "empty"]);
});

// 未标记 filterable 的列即使值相同也不能贡献匹配结果。
test("filterData：忽略默认不可搜索列", () => {
  const columns: Column<Row>[] = [{ key: "score", header: "分数" }];

  expect(filterData(rows, columns, "20")).toEqual([]);
});

// 数字与字符串混合时使用字符串比较，数值字符串应按字典序排序。
test("sortData：混合数值和字符串使用字典序", () => {
  const input = [
    { id: "ten", value: 10 },
    { id: "two", value: "2" },
    { id: "three", value: 3 },
  ];

  expect(sortData(input, "value", "asc").map((row) => row.id)).toEqual(["ten", "two", "three"]);
});

// 缺失值应按空字符串参与升序比较，排在有值之前。
test("sortData：升序时缺失值排在字符串前", () => {
  expect(sortData(rows, "name", "asc").map((row) => row.id)).toEqual(["empty", "alpha", "beta"]);
});

// 缺失值在降序分支中应随比较结果反转到末尾。
test("sortData：降序时缺失值排在字符串后", () => {
  expect(sortData(rows, "name", "desc").map((row) => row.id)).toEqual(["beta", "alpha", "empty"]);
});

// 两个 null 值比较相等时，稳定排序应保留它们的相对顺序。
test("sortData：相等的空值保持原始相对顺序", () => {
  const input = [
    { id: "first", value: null },
    { id: "second", value: null },
    { id: "text", value: "z" },
  ];

  expect(sortData(input, "value", "asc").map((row) => row.id)).toEqual(["first", "second", "text"]);
});

// 数字排序必须正确处理负数和零，而不是按字符串顺序排列。
test("sortData：数值分支处理负数与零", () => {
  const input = [
    { id: "zero", value: 0 },
    { id: "negative", value: -2 },
    { id: "positive", value: 1 },
  ];

  expect(sortData(input, "value", "asc").map((row) => row.id)).toEqual(["negative", "zero", "positive"]);
});

// page 为零时 slice 的负起点与零结束位置形成空区间。
test("paginateData：第零页返回空项目", () => {
  expect(paginateData(rows, 0, 2)).toEqual({ items: [], total: 3 });
});

// 负页码会按 slice 的负索引语义从数组头部截取相应范围。
test("paginateData：负页码遵循负索引截取", () => {
  expect(paginateData(rows, -1, 2)).toEqual({ items: [rows[0]], total: 3 });
});

// 小数页码传给 slice 时会按整数截断，行为应保持确定。
test("paginateData：小数页码按 slice 规则截断", () => {
  expect(paginateData(rows, 1.5, 2)).toEqual({ items: [rows[1], rows[2]], total: 3 });
});

// 负页大小会形成反向区间，仍须如实返回 slice 的结果。
test("paginateData：负页大小遵循 slice 负结束索引", () => {
  expect(paginateData(rows, 1, -1)).toEqual({ items: [rows[0], rows[1]], total: 3 });
});

// 分页应创建项目数组副本，避免调用方修改返回数组时影响原数组。
test("paginateData：返回独立的项目数组", () => {
  const result = paginateData(rows, 1, 3);

  expect(result.items).not.toBe(rows);
  expect(result.items).toEqual(rows);
});

// 自定义行键的返回值即使为空字符串也应作为有效展开状态键。
test("buildInitialExpandedState：保留空字符串自定义行键", () => {
  expect(buildInitialExpandedState([{ id: "one" }], () => "")).toEqual({ "": true });
});

// 自定义行键应按数据顺序调用，使含状态的键生成器结果可预测。
test("buildInitialExpandedState：按输入顺序调用行键函数", () => {
  const visited: string[] = [];

  buildInitialExpandedState(rows, (row) => {
    visited.push(row.id);
    return row.id;
  });

  expect(visited).toEqual(["alpha", "beta", "empty"]);
});

// 构造展开状态不能给原始行对象写入额外属性。
test("buildInitialExpandedState：不修改行对象", () => {
  const input = [{ id: "safe" }];
  const before = structuredClone(input);

  buildInitialExpandedState(input, (row) => row.id);

  expect(input).toEqual(before);
});

// 默认索引键使用字符串形式，十项以上也必须保持完整索引。
test("buildInitialExpandedState：双位索引仍转换为字符串键", () => {
  const input = Array.from({ length: 11 }, (_, index) => ({ id: `row-${index}` }));

  expect(buildInitialExpandedState(input)).toMatchObject({ "0": true, "10": true });
});

// 空数组不会触发自定义行键函数，避免调用方的无意义副作用。
test("buildInitialExpandedState：空数组不调用行键函数", () => {
  let calls = 0;

  expect(
    buildInitialExpandedState<Row>([], () => {
      calls += 1;
      return "unused";
    }),
  ).toEqual({});
  expect(calls).toBe(0);
});
