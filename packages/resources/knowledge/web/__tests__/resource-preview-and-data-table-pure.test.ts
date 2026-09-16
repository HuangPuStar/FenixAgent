import { describe, expect, test } from "bun:test";
import type { Column } from "../../components/config/DataTable";
import { buildInitialExpandedState, filterData, paginateData, sortData } from "../../components/config/DataTable";
import { getFileCategory } from "../../components/knowledge/ResourcePreviewContent";

interface Row {
  id: string;
  name: string;
  age: number;
  enabled: boolean;
  note?: string | null;
}

const rows: Row[] = [
  { id: "row-1", name: "Alpha", age: 20, enabled: true, note: "First record" },
  { id: "row-2", name: "beta", age: 3, enabled: false, note: null },
  { id: "row-3", name: "Gamma", age: 11, enabled: true },
];

const columns: Column<Row>[] = [
  { key: "name", header: "Name", filterable: true },
  { key: "age", header: "Age", filterable: true },
  { key: "enabled", header: "Enabled" },
  { key: "note", header: "Note", filterable: true },
];

describe("资源预览文件分类", () => {
  // PDF 扩展名应映射为独立预览类别，并忽略文件名大小写。
  test("getFileCategory 识别大小写混合的 PDF 文件", () => {
    expect(getFileCategory("report.FiNaL.PDF")).toBe("pdf");
  });

  // 常用图片格式应归为 image，以便走浏览器原生图片预览。
  test("getFileCategory 识别图片格式", () => {
    expect(getFileCategory("diagram.webp")).toBe("image");
  });

  // Markdown 的两个扩展名均应复用 Markdown 渲染路径。
  test("getFileCategory 识别 Markdown 扩展名", () => {
    expect(getFileCategory("guide.md")).toBe("markdown");
    expect(getFileCategory("guide.markdown")).toBe("markdown");
  });

  // CSV 与 Excel 文件应使用前端表格解析，而不是 Office PDF 转换。
  test("getFileCategory 将表格文件归类为 spreadsheet", () => {
    expect(getFileCategory("data.csv")).toBe("spreadsheet");
    expect(getFileCategory("budget.XLSM")).toBe("spreadsheet");
  });

  // 源代码与配置文本应归为 text，供文本内容请求和展示使用。
  test("getFileCategory 识别可读取的文本文件", () => {
    expect(getFileCategory("service.tsx")).toBe("text");
    expect(getFileCategory("runtime.env")).toBe("text");
  });

  // 无扩展名和未知扩展名不得误判为可预览文件。
  test("getFileCategory 将未知文件归类为 other", () => {
    expect(getFileCategory("LICENSE")).toBe("other");
    expect(getFileCategory("archive.tar.gz")).toBe("other");
  });
});

describe("DataTable 纯数据处理", () => {
  // 空白查询不应复制或筛除数据，避免输入框初始状态改变结果。
  test("filterData 对空白查询返回原始数据引用", () => {
    expect(filterData(rows, columns, "  ")).toBe(rows);
  });

  // 过滤应忽略大小写，并只检索标记为 filterable 的列。
  test("filterData 按可过滤列进行不区分大小写的匹配", () => {
    expect(filterData(rows, columns, "ALP")).toEqual([rows[0]]);
    expect(filterData(rows, columns, "true")).toEqual([]);
  });

  // null、undefined 字段不应导致字符串转换异常，也不能错误匹配查询。
  test("filterData 安全跳过空字段", () => {
    expect(filterData(rows, columns, "record")).toEqual([rows[0]]);
    expect(filterData(rows, columns, "null")).toEqual([]);
  });

  // 数字列应以数值顺序排序，且不能变更调用方提供的数组。
  test("sortData 对数字字段排序且保持原数组不变", () => {
    const sorted = sortData(rows, "age", "asc");

    expect(sorted.map((row) => row.id)).toEqual(["row-2", "row-3", "row-1"]);
    expect(rows.map((row) => row.id)).toEqual(["row-1", "row-2", "row-3"]);
  });

  // 降序字符串排序应处理大小写不同的名称，并按反向比较结果返回。
  test("sortData 支持字符串字段降序排序", () => {
    expect(sortData(rows, "name", "desc").map((row) => row.name)).toEqual(["Gamma", "beta", "Alpha"]);
  });

  // 分页应同时返回总条数，并在最后一页不足页大小时截取剩余数据。
  test("paginateData 返回末页剩余项和完整总数", () => {
    expect(paginateData(rows, 2, 2)).toEqual({ items: [rows[2]], total: 3 });
  });

  // 展开状态默认使用行索引，自定义键时必须改用稳定的业务标识。
  test("buildInitialExpandedState 支持默认索引和自定义行键", () => {
    expect(buildInitialExpandedState(rows)).toEqual({ 0: true, 1: true, 2: true });
    expect(buildInitialExpandedState(rows, (row) => row.id)).toEqual({ "row-1": true, "row-2": true, "row-3": true });
  });
});
