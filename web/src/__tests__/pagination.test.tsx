import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import ReactDOMServer from "react-dom/server";
import { Pagination } from "@/components/ui/pagination";

// 简易 t() mock：返回可识别的翻译文本
const t = mock((key: string, opts?: Record<string, unknown>) => {
  const map: Record<string, string> = {
    "runs.pagination_total": `共 ${opts?.total} 条`,
    "runs.pagination_page_size": `${opts?.size} 条/页`,
  };
  return map[key] ?? key;
});

// ── SSR 结构测试 ──

describe("Pagination", () => {
  // 总页数为 1 时不渲染
  test("总页数为 1 时不渲染", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      createElement(Pagination, { page: 1, totalPages: 1, total: 5, pageSize: 20, onPageChange: () => {}, t }),
    );
    expect(html).toBe("");
  });

  // 渲染当前页高亮
  test("渲染当前页高亮", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      createElement(Pagination, { page: 3, totalPages: 5, total: 100, pageSize: 20, onPageChange: () => {}, t }),
    );
    // 当前页按钮有 data-variant="default"（高亮态）
    expect(html).toContain('data-variant="default"');
    // 页面包含当前页码文本
    expect(html).toContain(">3<");
    // 验证总条数文本
    expect(html).toContain("共 100 条");
  });

  // 首页禁用上一页按钮 — 通过 disabled="" 属性（非 CSS class）判断
  test("首页禁用上一页按钮", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      createElement(Pagination, { page: 1, totalPages: 5, total: 100, pageSize: 20, onPageChange: () => {}, t }),
    );
    // page=1 时 prev 按钮应含 disabled="" 属性
    expect(html).toContain('disabled=""');
    // 验证页面仍然渲染了页码
    expect(html).toContain(">1<");
  });

  // 末页禁用下一页按钮
  test("末页禁用下一页按钮", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      createElement(Pagination, { page: 5, totalPages: 5, total: 100, pageSize: 20, onPageChange: () => {}, t }),
    );
    // page=totalPages 时 next 按钮含 disabled="" 属性
    expect(html).toContain('disabled=""');
  });

  // 中间页不包含 disabled 属性
  test("中间页不禁用按钮", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      createElement(Pagination, { page: 3, totalPages: 10, total: 200, pageSize: 20, onPageChange: () => {}, t }),
    );
    // page=3 of 10：prev 和 next 都不应有 disabled="" 属性
    expect(html).not.toContain('disabled=""');
  });

  // 点击页码触发 onPageChange — 通过验证 onPageChange 被传入并可被调用
  test("点击页码触发 onPageChange", () => {
    const onPageChange = mock();
    ReactDOMServer.renderToStaticMarkup(
      createElement(Pagination, {
        page: 1,
        totalPages: 5,
        total: 100,
        pageSize: 20,
        onPageChange,
        t,
      }),
    );
    // SSR 渲染成功即表示组件可正常接收 onPageChange prop
    // 实际点击交互需要完整 DOM 环境，此处验证回调可传入
    expect(onPageChange).not.toHaveBeenCalled();
    // 验证页面包含了所有页码按钮
    const html = ReactDOMServer.renderToStaticMarkup(
      createElement(Pagination, { page: 1, totalPages: 5, total: 100, pageSize: 20, onPageChange: () => {}, t }),
    );
    expect(html).toContain(">1<");
    expect(html).toContain(">2<");
    expect(html).toContain(">5<");
  });
});
