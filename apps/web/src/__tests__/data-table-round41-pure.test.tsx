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
  name?: string;
  city?: string | null;
  age?: number;
  active?: boolean;
  value?: number | string | null;
};

const rows: Row[] = [
  { id: "a", name: "Alice", city: "Paris", age: 30, active: true, value: 10 },
  { id: "b", name: "bob", city: "Berlin", age: 5, active: false, value: 2 },
  { id: "c", name: "Carol", city: null, age: 18, active: true, value: "3" },
];

const searchableColumns: Column<Row>[] = [
  { key: "name", header: "姓名", filterable: true },
  { key: "city", header: "城市", filterable: true },
  { key: "age", header: "年龄", filterable: false },
];

// 空搜索应返回原始数组，避免不必要的数据复制。
test("filterData：空字符串返回原始数据引用", () => {
  expect(filterData(rows, searchableColumns, "")).toBe(rows);
});

// 仅由空白组成的搜索词也应视为未搜索。
test("filterData：空白搜索返回原始数据引用", () => {
  expect(filterData(rows, searchableColumns, "  \n ")).toBe(rows);
});

// 搜索应忽略英文字母大小写。
test("filterData：名称搜索不区分大小写", () => {
  expect(filterData(rows, searchableColumns, "ALICE")).toEqual([rows[0]]);
});

// 搜索应支持字段值中的子串。
test("filterData：城市子串可匹配", () => {
  expect(filterData(rows, searchableColumns, "erl")).toEqual([rows[1]]);
});

// 不存在的关键词不应产生结果。
test("filterData：无匹配时返回空数组", () => {
  expect(filterData(rows, searchableColumns, "Tokyo")).toEqual([]);
});

// 标记为不可筛选的列不能参与全文搜索。
test("filterData：忽略不可筛选列", () => {
  expect(filterData(rows, searchableColumns, "30")).toEqual([]);
});

// 数值字段在可筛选时应按字符串形式参与匹配。
test("filterData：可搜索数值字段", () => {
  const columns: Column<Row>[] = [{ key: "age", header: "年龄", filterable: true }];
  expect(filterData(rows, columns, "18")).toEqual([rows[2]]);
});

// null 值不能转成字符串后误匹配 null。
test("filterData：跳过 null 字段值", () => {
  expect(filterData(rows, searchableColumns, "null")).toEqual([]);
});

// 缺失字段与 null 一样应安全跳过。
test("filterData：跳过缺失字段值", () => {
  expect(filterData([{ id: "missing" }], searchableColumns, "undefined")).toEqual([]);
});

// 没有可筛选列时，非空搜索应没有结果。
test("filterData：无可筛选列时返回空数组", () => {
  expect(filterData(rows, [{ key: "name", header: "姓名" }], "Alice")).toEqual([]);
});

// 一个行对象可因任一可筛选列命中而被保留。
test("filterData：跨列命中保留行", () => {
  expect(filterData(rows, searchableColumns, "par")).toEqual([rows[0]]);
});

// 升序数值排序应从较小数值开始。
test("sortData：数值升序", () => {
  expect(sortData(rows, "age", "asc").map((row) => row.id)).toEqual(["b", "c", "a"]);
});

// 降序数值排序应反转数值顺序。
test("sortData：数值降序", () => {
  expect(sortData(rows, "age", "desc").map((row) => row.id)).toEqual(["a", "c", "b"]);
});

// 字符串排序使用字符串比较规则。
test("sortData：字符串升序", () => {
  expect(sortData(rows, "name", "asc").map((row) => row.id)).toEqual(["a", "b", "c"]);
});

// 字符串降序应反转字符串比较结果。
test("sortData：字符串降序", () => {
  expect(sortData(rows, "name", "desc").map((row) => row.id)).toEqual(["c", "b", "a"]);
});

// 混合类型字段应走字符串化比较分支。
test("sortData：混合类型按字符串排序", () => {
  expect(sortData(rows, "value", "asc").map((row) => row.id)).toEqual(["b", "a", "c"]);
});

// 不存在的键会按空字符串比较，且排序不应抛错。
test("sortData：缺失键保持稳定顺序", () => {
  expect(sortData(rows, "unknown", "asc").map((row) => row.id)).toEqual(["a", "b", "c"]);
});

// 排序实现必须复制数组，不能修改调用方数据顺序。
test("sortData：不修改输入数组", () => {
  const input = [rows[2], rows[0], rows[1]];
  const result = sortData(input, "age", "asc");
  expect(result).not.toBe(input);
  expect(input.map((row) => row.id)).toEqual(["c", "a", "b"]);
});

// 第一页应从第一个元素开始截取。
test("paginateData：第一页返回首个页面", () => {
  expect(paginateData(rows, 1, 2)).toEqual({ items: [rows[0], rows[1]], total: 3 });
});

// 最后一页允许少于 page size 的剩余数据。
test("paginateData：最后一页返回剩余项", () => {
  expect(paginateData(rows, 2, 2)).toEqual({ items: [rows[2]], total: 3 });
});

// 超出末页时应保持总数并返回空项。
test("paginateData：超出范围的页为空", () => {
  expect(paginateData(rows, 3, 2)).toEqual({ items: [], total: 3 });
});

// 页大小为零时 slice 不应返回项目。
test("paginateData：零页大小返回空项", () => {
  expect(paginateData(rows, 1, 0)).toEqual({ items: [], total: 3 });
});

// 空数据的分页总数应为零。
test("paginateData：空数据保留零总数", () => {
  expect(paginateData([], 1, 10)).toEqual({ items: [], total: 0 });
});

// 未提供 rowKey 时应使用数组索引作为展开状态键。
test("buildInitialExpandedState：默认索引键全部展开", () => {
  expect(buildInitialExpandedState(rows)).toEqual({ "0": true, "1": true, "2": true });
});

// 自定义 rowKey 时应使用业务键而非数组索引。
test("buildInitialExpandedState：使用自定义行键", () => {
  expect(buildInitialExpandedState(rows, (row) => row.id)).toEqual({ a: true, b: true, c: true });
});

// 空数据没有任何可展开行。
test("buildInitialExpandedState：空数据返回空状态", () => {
  expect(buildInitialExpandedState<Row>([])).toEqual({});
});

// 重复行键最终仍应形成一个有效展开键。
test("buildInitialExpandedState：重复行键合并为单个状态", () => {
  expect(buildInitialExpandedState([{ id: "same" }, { id: "same" }], (row) => row.id)).toEqual({ same: true });
});
