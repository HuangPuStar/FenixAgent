import { expect, test } from "bun:test";
import { type Column, DataTable } from "@fenix/ui-components/config/DataTable";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

type Row = {
  id: string;
  name: string;
  status?: string;
};

const i18n = createInstance();

await i18n.init({
  lng: "zh",
  defaultNS: "components",
  ns: ["components"],
  resources: {
    zh: {
      components: {
        dataTable: {
          actions: "操作",
          noData: "暂无数据",
          pagination: "第 {{start}}-{{end}} 条，共 {{total}} 条",
          searchPlaceholder: "搜索数据",
        },
      },
    },
  },
});

function renderTable(props: Parameters<typeof DataTable<Row>>[0]) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(DataTable<Row>, props)));
}

const columns: Column<Row>[] = [
  { key: "name", header: "名称", filterable: true },
  {
    key: "status",
    header: "状态",
    render: (row) => createElement("strong", null, `状态：${row.status ?? "未知"}`),
  },
  { key: "missing", header: "缺失字段" },
];

// 空数据应显示调用方提供的空状态文案，而不是渲染数据行。
test("DataTable SSR：空数据展示空状态", () => {
  const html = renderTable({ columns, data: [], emptyMessage: "没有可展示的记录" });

  expect(html).toContain("名称");
  expect(html).toContain("没有可展示的记录");
  expect(html).not.toContain("状态：");
});

// 有数据时应渲染列标题、默认单元格、自定义单元格和操作内容。
test("DataTable SSR：展示列和数据行", () => {
  const html = renderTable({
    columns,
    data: [{ id: "row-1", name: "SSR 记录", status: "启用" }],
    actions: (row) => createElement("span", null, `操作 ${row.id}`),
  });

  expect(html).toContain("名称");
  expect(html).toContain("状态");
  expect(html).toContain("缺失字段");
  expect(html).toContain("操作");
  expect(html).toContain("SSR 记录");
  expect(html).toContain("状态：启用");
  expect(html).toContain("操作 row-1");
  expect(html).toContain("—");
});

// 搜索框、分页和默认展开均应在 SSR 初始标记中反映对应的纯数据 props。
test("DataTable SSR：展示搜索、分页和默认展开内容", () => {
  const html = renderTable({
    columns: [{ key: "name", header: "名称", filterable: true }],
    data: [
      { id: "first", name: "第一页记录" },
      { id: "second", name: "第二页记录" },
    ],
    defaultExpandAll: true,
    expandableRow: (row) => createElement("div", null, `详情 ${row.id}`),
    pageSize: 1,
    rowKey: (row) => row.id,
    searchable: true,
    searchPlaceholder: "按名称搜索",
  });

  expect(html).toContain('placeholder="按名称搜索"');
  expect(html).toContain("第一页记录");
  expect(html).not.toContain("第二页记录");
  expect(html).toContain("详情 first");
  // 翻页按钮：owner 已归 `@fenix/ui-components/config/DataTable`（§1.6 T8b 删除宿主副本）。
  // 宿主副本此处是硬编码中文「上一页/下一页」（无对应 i18n 键），包内改为英文默认值并在实现处
  // 明文登记为「已知限制：仅这两个按钮的可见文案未本地化，移除条件是消费方提出本地化需求」。
  // 本用例守护的是「pageCount > 1 时翻页控件出现」这条结构，语言差异随 owner 契约走。
  expect(html).toContain("Previous");
  expect(html).toContain("Next");
});
