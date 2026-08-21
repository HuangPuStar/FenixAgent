import { describe, expect, test } from "bun:test";
import type { Column } from "../../components/config/DataTable";
import { buildInitialExpandedState, filterData, paginateData, sortData } from "../../components/config/DataTable";
import { getFileCategory } from "../../components/knowledge/ResourcePreviewContent";

interface RecordRow {
  id: string;
  name: string;
  score: number;
  active: boolean;
  note?: string | null;
  mixed?: string | number | null;
}

const records: RecordRow[] = [
  { id: "r-1", name: "Alpha", score: 20, active: true, note: "第一条", mixed: "zebra" },
  { id: "r-2", name: "beta", score: 3, active: false, note: null, mixed: 10 },
  { id: "r-3", name: "Gamma", score: 11, active: true, mixed: "20" },
  { id: "r-4", name: "delta", score: -5, active: false, note: "末尾记录", mixed: null },
];

const columns: Column<RecordRow>[] = [
  { key: "name", header: "名称", filterable: true },
  { key: "score", header: "分数", filterable: true },
  { key: "active", header: "启用" },
  { key: "note", header: "备注", filterable: true },
  { key: "mixed", header: "混合", filterable: true },
];

const categories = [
  ["报告.PDF", "pdf"],
  ["archive.final.pdf", "pdf"],
  ["photo.png", "image"],
  ["photo.JPG", "image"],
  ["photo.jpeg", "image"],
  ["animation.gif", "image"],
  ["art.webp", "image"],
  ["vector.svg", "image"],
  ["bitmap.bmp", "image"],
  ["favicon.ico", "image"],
  ["README.md", "markdown"],
  ["说明.MarkDown", "markdown"],
  ["index.html", "html"],
  ["legacy.HTM", "html"],
  ["movie.mp4", "video"],
  ["movie.webm", "video"],
  ["movie.ogg", "video"],
  ["movie.mov", "video"],
  ["movie.mkv", "video"],
  ["movie.avi", "video"],
  ["movie.flv", "video"],
  ["movie.wmv", "video"],
  ["movie.m4v", "video"],
  ["sheet.xlsx", "spreadsheet"],
  ["sheet.xls", "spreadsheet"],
  ["sheet.XLSM", "spreadsheet"],
  ["sheet.csv", "spreadsheet"],
  ["notes.txt", "text"],
  ["data.json", "text"],
  ["data.xml", "text"],
  ["config.yaml", "text"],
  ["config.yml", "text"],
  ["main.js", "text"],
  ["main.ts", "text"],
  ["main.tsx", "text"],
  ["main.jsx", "text"],
  ["main.py", "text"],
  ["main.go", "text"],
  ["main.rs", "text"],
  ["script.sh", "text"],
  ["script.bash", "text"],
  ["query.sql", "text"],
  ["style.css", "text"],
  ["server.log", "text"],
  ["runtime.env", "text"],
  ["document.docx", "office"],
  ["document.doc", "office"],
  ["slides.pptx", "office"],
  ["slides.ppt", "office"],
] as const;

describe("ResourcePreviewContent 已导出的文件分类纯逻辑", () => {
  for (const [filename, expected] of categories) {
    test(`文件 ${filename} 应分类为 ${expected}`, () => {
      expect(getFileCategory(filename)).toBe(expected);
    });
  }

  test("无扩展名应归类为 other", () => {
    expect(getFileCategory("LICENSE")).toBe("other");
  });

  test("点号结尾的文件名应归类为 other", () => {
    expect(getFileCategory("trailing.")).toBe("other");
  });

  test("未知扩展名应归类为 other", () => {
    expect(getFileCategory("archive.tar.gz")).toBe("other");
  });

  test("前导点文件不应将名称误判为扩展名", () => {
    expect(getFileCategory(".gitignore")).toBe("other");
  });

  test("带路径分隔符的文件名按最后扩展名分类", () => {
    expect(getFileCategory("目录/报告.PDF")).toBe("pdf");
  });
});

describe("DataTable 已导出的过滤纯逻辑", () => {
  test("空字符串返回原数组引用", () => {
    expect(filterData(records, columns, "")).toBe(records);
  });

  test("纯空白查询返回原数组引用", () => {
    expect(filterData(records, columns, "  \n\t")).toBe(records);
  });

  test("名称过滤忽略大小写", () => {
    expect(filterData(records, columns, "ALPha")).toEqual([records[0]]);
  });

  test("数字字段可按字符串片段过滤", () => {
    expect(filterData(records, columns, "1")).toEqual([records[1], records[2]]);
  });

  test("负数符号可参与分数过滤", () => {
    expect(filterData(records, columns, "-")).toEqual([records[3]]);
  });

  test("可过滤备注字段支持中文匹配", () => {
    expect(filterData(records, columns, "末尾")).toEqual([records[3]]);
  });

  test("null 备注不会被转为字符串匹配", () => {
    expect(filterData(records, columns, "null")).toEqual([]);
  });

  test("未标记为可过滤的布尔字段不会命中", () => {
    expect(filterData(records, columns, "true")).toEqual([]);
  });

  test("混合字段中的数字会被字符串化后匹配", () => {
    expect(filterData(records, columns, "10")).toEqual([records[1]]);
  });

  test("查询前后空格属于实际查询内容", () => {
    expect(filterData(records, columns, " alpha ")).toEqual([]);
  });

  test("没有可过滤列时非空查询返回空数组", () => {
    expect(filterData(records, [{ key: "name", header: "名称" }], "alpha")).toEqual([]);
  });

  test("过滤不会变更原数组顺序", () => {
    filterData(records, columns, "a");
    expect(records.map((record) => record.id)).toEqual(["r-1", "r-2", "r-3", "r-4"]);
  });
});

describe("DataTable 已导出的排序纯逻辑", () => {
  test("数字升序按数值而非字符串排序", () => {
    expect(sortData(records, "score", "asc").map((record) => record.score)).toEqual([-5, 3, 11, 20]);
  });

  test("数字降序按数值反转", () => {
    expect(sortData(records, "score", "desc").map((record) => record.score)).toEqual([20, 11, 3, -5]);
  });

  test("字符串升序使用 localeCompare", () => {
    expect(sortData(records, "name", "asc").map((record) => record.name)).toEqual(["Alpha", "beta", "delta", "Gamma"]);
  });

  test("字符串降序使用 localeCompare 的反向结果", () => {
    expect(sortData(records, "name", "desc").map((record) => record.name)).toEqual(["Gamma", "delta", "beta", "Alpha"]);
  });

  test("缺失字段按空字符串参与排序", () => {
    expect(sortData(records, "unknown", "asc")).toEqual(records);
  });

  test("混合类型按字符串表示排序", () => {
    expect(sortData(records, "mixed", "asc").map((record) => record.id)).toEqual(["r-4", "r-2", "r-3", "r-1"]);
  });

  test("null 混合字段按空字符串排序在前", () => {
    expect(sortData(records, "mixed", "asc")[0]).toBe(records[3]);
  });

  test("排序返回新数组", () => {
    expect(sortData(records, "score", "asc")).not.toBe(records);
  });

  test("排序不会变更原数组", () => {
    sortData(records, "score", "desc");
    expect(records.map((record) => record.score)).toEqual([20, 3, 11, -5]);
  });

  test("相同数值保持原有相对顺序", () => {
    const equalScores = [
      { id: "first", score: 1 },
      { id: "second", score: 1 },
      { id: "third", score: 2 },
    ];
    expect(sortData(equalScores, "score", "asc").map((record) => record.id)).toEqual(["first", "second", "third"]);
  });
});

describe("DataTable 已导出的分页与展开状态纯逻辑", () => {
  test("第一页返回指定页大小", () => {
    expect(paginateData(records, 1, 2)).toEqual({ items: [records[0], records[1]], total: 4 });
  });

  test("第二页返回剩余项目", () => {
    expect(paginateData(records, 2, 3)).toEqual({ items: [records[3]], total: 4 });
  });

  test("超出范围的页返回空项目", () => {
    expect(paginateData(records, 9, 2)).toEqual({ items: [], total: 4 });
  });

  test("页大小超过总数时返回全部项目", () => {
    expect(paginateData(records, 1, 99)).toEqual({ items: records, total: 4 });
  });

  test("零页码遵循 slice 的负起点行为", () => {
    expect(paginateData(records, 0, 2)).toEqual({ items: [], total: 4 });
  });

  test("分页不会变更原数组", () => {
    paginateData(records, 2, 2);
    expect(records.map((record) => record.id)).toEqual(["r-1", "r-2", "r-3", "r-4"]);
  });

  test("空数据返回零总数和空项目", () => {
    expect(paginateData([], 1, 10)).toEqual({ items: [], total: 0 });
  });

  test("默认展开状态使用索引键", () => {
    expect(buildInitialExpandedState(records)).toEqual({ "0": true, "1": true, "2": true, "3": true });
  });

  test("自定义行键使用业务标识", () => {
    expect(buildInitialExpandedState(records, (record) => record.id)).toEqual({
      "r-1": true,
      "r-2": true,
      "r-3": true,
      "r-4": true,
    });
  });

  test("空数据生成独立的空展开状态", () => {
    const first = buildInitialExpandedState<RecordRow>([]);
    const second = buildInitialExpandedState<RecordRow>([]);
    expect(first).toEqual({});
    expect(first).not.toBe(second);
  });

  test("展开状态构建不会变更原数组", () => {
    buildInitialExpandedState(records, (record) => record.id);
    expect(records.map((record) => record.id)).toEqual(["r-1", "r-2", "r-3", "r-4"]);
  });
});
