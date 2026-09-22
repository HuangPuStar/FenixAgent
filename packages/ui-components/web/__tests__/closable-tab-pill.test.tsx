// web/__tests__/closable-tab-pill.test.tsx
// ClosableTabPill 的展示契约：两处消费方（宿主 FileTabsBar 的主 tab、agent-config 的 SiteTabsBar）
// 的真实差异都经 props 表达，库内钉住的是「差异 → DOM」这段映射。
//
// 关键点：选中/未选中的配色、hover 显隐关闭按钮的 group 名、`selectRole` 决定的无障碍角色、
// 关闭按钮的文案与尺寸类覆盖。前两者是两处此前逐字重复的类串，后两者是迁移时必须保持的差异。

import { describe, expect, test } from "bun:test";
import { ClosableTabPill } from "@fenix/ui-components/components/ClosableTabPill";
import ReactDOMServer from "react-dom/server";

const render = (props: Parameters<typeof ClosableTabPill>[0]) =>
  ReactDOMServer.renderToString(<ClosableTabPill {...props} />);

describe("ClosableTabPill", () => {
  test("选中与未选中的配色分属两支，标签与图标原样渲染", () => {
    const active = render({ active: true, label: "a.ts", onSelect: () => {} });
    expect(active).toContain("bg-surface-2");
    expect(active).not.toContain("hover:bg-surface-2/60");
    expect(active).toContain("a.ts");

    const inactive = render({ active: false, label: "b.ts", icon: <span>ICON</span>, onSelect: () => {} });
    expect(inactive).toContain("hover:bg-surface-2/60");
    expect(inactive).toContain("ICON");
  });

  test("不传 onClose 时不渲染关闭按钮", () => {
    const html = render({ active: false, label: "a.ts", onSelect: () => {} });
    expect(html).not.toContain("aria-label");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  test("关闭按钮带无障碍名与悬停提示，尺寸类由调用方覆盖", () => {
    const html = render({
      active: false,
      label: "a.ts",
      onSelect: () => {},
      onClose: () => {},
      closeLabel: "关闭标签页",
      closeTitle: "卸载站点",
      closeClassName: "h-5 w-5 hover:bg-border/40",
    });
    expect(html).toContain('aria-label="关闭标签页"');
    expect(html).toContain('title="卸载站点"');
    expect(html).toContain("h-5 w-5 hover:bg-border/40");
  });

  test("默认关闭按钮 hover 才现（命名 group），调用方可用 opacity-100 覆盖成常显", () => {
    const hoverOnly = render({
      active: false,
      label: "a.ts",
      onSelect: () => {},
      onClose: () => {},
      closeLabel: "关闭",
    });
    expect(hoverOnly).toContain("group-hover/tab:opacity-100");

    const always = render({
      active: true,
      label: "a.ts",
      onSelect: () => {},
      onClose: () => {},
      closeLabel: "关闭",
      closeClassName: "opacity-100",
    });
    // tailwind-merge 解析冲突：调用方的 opacity-100 胜出，hover 变体保留但不再影响可见性。
    expect(always).not.toMatch(/class="[^"]*\bopacity-0\b/);
    expect(always).toContain("opacity-100");
  });

  test("selectRole=tab 时才补 role/aria-selected，否则保持原生 button 语义", () => {
    const tab = render({ active: true, label: "站点", onSelect: () => {}, selectRole: "tab" });
    expect(tab).toContain('role="tab"');
    expect(tab).toContain('aria-selected="true"');

    const plain = render({ active: true, label: "a.ts", onSelect: () => {} });
    expect(plain).not.toContain('role="tab"');
    expect(plain).not.toContain("aria-selected");
  });

  test("trailing 渲染在标签与关闭按钮之间，className 与 title 落到整枚 pill 上", () => {
    const html = render({
      active: false,
      label: "站点",
      trailing: <span>TRAILING</span>,
      onSelect: () => {},
      onClose: () => {},
      closeLabel: "卸载",
      title: "站点全名",
      className: "max-w-[220px] transition-colors",
    });
    expect(html).toContain('title="站点全名"');
    expect(html).toContain("max-w-[220px] transition-colors");
    expect(html.indexOf("TRAILING")).toBeLessThan(html.indexOf('aria-label="卸载"'));
  });
});
