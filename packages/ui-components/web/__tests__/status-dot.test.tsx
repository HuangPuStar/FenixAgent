// StatusDot（`ui/status-dot`）的契约测试：色调 → 填充色、呼吸动画、读屏行为。
//
// 为什么用服务端渲染：本组件是纯展示件（无状态、无 i18n、无 Portal），标记即契约；
// 不需要 happy-dom 与交互模拟，断言的取值来源就是渲染出的 HTML。
//
// 读屏契约是本文件的重点：`label` 的有无必须同时决定「念不念」——纯装饰圆点若被念出来，
// 每次渲染都是一次噪音播报；反过来，只有圆点承担状态表达时又不能不念。

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusDot } from "../ui/status-dot";

/** 渲染单个圆点，返回标记；`props` 省略时用组件默认值。 */
function render(props: Parameters<typeof StatusDot>[0] = {}): string {
  return renderToStaticMarkup(createElement(StatusDot, props));
}

describe("StatusDot", () => {
  // 五个色调各自对应一个 token 填充色：配色是组件库的知识，调用方只给语义。
  test("色调映射到 token 填充色，默认中性", () => {
    expect(render({ tone: "success" })).toContain("bg-status-running");
    expect(render({ tone: "info" })).toContain("bg-status-idle");
    expect(render({ tone: "warning" })).toContain("bg-status-warning");
    expect(render({ tone: "danger" })).toContain("bg-status-error");
    expect(render({ tone: "neutral" })).toContain("bg-text-muted");
    expect(render()).toContain("bg-text-muted");
  });

  // 尺寸默认 8px；其它刻度（如列表项 6px）由调用方 className 覆盖，且同族类名要被合并成一份。
  test("默认 8px，className 可覆盖尺寸且不残留默认刻度", () => {
    const markup = render({ className: "size-1.5" });

    expect(markup).toContain("size-1.5");
    expect(markup).not.toContain("size-2 ");
    expect(markup).not.toContain('class="inline-block size-2 shrink-0');
  });

  // 过渡态（启动中 / 连接中）才加呼吸动画，终态不加——动画被当成"还在动"会被误读成"还在进行"。
  test("pulse 仅在被显式要求时渲染呼吸动画", () => {
    expect(render({ pulse: true })).toContain("animate-pulse");
    expect(render()).not.toContain("animate-pulse");
  });

  // 有 label → 可访问名；无 label → 纯装饰，整块对读屏隐藏（不念空状态）。
  test("label 决定读屏：给了就念，没给就 aria-hidden", () => {
    const labelled = render({ label: "运行中" });

    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="运行中"');
    expect(labelled).not.toContain("aria-hidden");

    const decorative = render();

    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain("role=");
    expect(decorative).not.toContain("aria-label");
  });
});
