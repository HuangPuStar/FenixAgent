// web/__tests__/iframe-preview-sandbox.test.tsx
// `IframePreview` 的沙箱与 src 协议白名单守卫（前端规范 §6.2 / §6.5 的已收口项）。
//
// 这个组件是 Markdown 里 `<iframe>` 的唯一出口（`message.tsx` 把它挂成 streamdown 的 iframe 渲染器），
// 来源因此是 Agent / LLM 输出——不可信输入。三条不变量在本文件里被钉住：
//   1. 两处 iframe 都不带 `allow-same-origin`（与 `allow-scripts` 组合可逃逸沙箱）；
//   2. 模型自带的 `sandbox` 属性不能覆盖组件固定的取值；
//   3. 不合规协议的 `src` 整块不渲染（`javascript:` / `vbscript:` / `file:` / 未知 scheme）。
//
// 渲染走 SSR：Dialog 的内容在关闭态不渲染，而**两处** iframe 的沙箱取值由末条源码断言覆盖
// （Radix 弹窗的 portal 在 happy-dom 下不挂载，展开态取不到——与 knowledge 侧的既有结论一致）。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstance, type i18n as I18nInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import { IframePreview } from "../chat/primitives/iframe-preview";
import en from "../i18n/locales/en/uiComponents.json";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const i18n: I18nInstance = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: {
    en: { [UI_COMPONENTS_NS]: en },
    zh: { [UI_COMPONENTS_NS]: zh },
  },
});

/** 组件经 `useTranslation` 读包内命名空间，渲染统一包 `I18nextProvider`。 */
function renderMarkup(element: ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

describe("IframePreview 沙箱与 src 校验", () => {
  // 合法 https 地址要能渲染，且 sandbox 里不能出现 allow-same-origin。
  test("https 来源照常渲染，sandbox 只放行脚本与弹窗", () => {
    const html = renderMarkup(<IframePreview src="https://example.com/a.html" title="site" />);
    expect(html).toContain('src="https://example.com/a.html"');
    expect(html).toContain('sandbox="allow-scripts allow-popups"');
    expect(html).not.toContain("allow-same-origin");
  });

  // 同源相对地址（file-proxy 预览、urlTransform 改写后的 `user/...`）必须继续可用——
  // 它正是「同源内容 + allow-same-origin」曾能逃逸沙箱的那条路径，去掉 allow-same-origin 后仍要能看。
  test("同源相对地址仍可渲染", () => {
    for (const src of ["/web/environments/e1/fs/user/a.html?preview=true", "user/a.html", "./a.md", "a.html"]) {
      const html = renderMarkup(<IframePreview src={src} />);
      expect(html).toContain(`src="${src}"`);
      expect(html).not.toContain("allow-same-origin");
    }
  });

  // 模型可以往 markdown 里写 `<iframe src="data:...">`：data: 在 opaque origin 里跑，不与父页面同源，
  // 因此保留放行（理由与移除条件见组件内 ALLOWED_IFRAME_PROTOCOLS 的注释）。
  test("data: 内联文档保留放行（opaque origin，不与父页面同源）", () => {
    const html = renderMarkup(<IframePreview src="data:text/html,<p>hi</p>" />);
    expect(html).toContain('sandbox="allow-scripts allow-popups"');
  });

  // 危险与未知协议必须整块不渲染；control 字符绕过（`java\nscript:`）也在拒绝之列。
  test("危险与未知协议一律不渲染 iframe", () => {
    const rejected = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\nscript:alert(1)",
      "  javascript:alert(1)  ",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/9f1",
      "about:blank",
      "chrome-extension://abc/x.html",
      "",
      "   ",
    ];
    for (const src of rejected) {
      const html = renderMarkup(<IframePreview src={src} title="t" />);
      expect(html).not.toContain("<iframe");
    }
  });

  // 沙箱策略归组件所有：模型自带 sandbox 属性不能把 allow-same-origin 加回来。
  test("模型传入的 sandbox 属性不生效", () => {
    const html = renderMarkup(
      <IframePreview src="https://example.com/a.html" sandbox="allow-scripts allow-same-origin" />,
    );
    expect(html).toContain('sandbox="allow-scripts allow-popups"');
    expect(html).not.toContain("allow-same-origin");
  });

  // 展开弹窗里的第二处 iframe 取不到（portal 在 happy-dom / SSR 下都不出），用源码断言补齐：
  // 只认 `sandbox="…"` 属性本身（注释里提到 allow-same-origin 是在解释为什么不能留它），
  // 两处 iframe 的取值必须逐字相同且不含 allow-same-origin。
  test("源码里两处 iframe 的 sandbox 取值一致且不含 allow-same-origin", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "chat/primitives/iframe-preview.tsx"), "utf8");
    expect(source.match(/sandbox="[^"]*"/g) ?? []).toEqual([
      'sandbox="allow-scripts allow-popups"',
      'sandbox="allow-scripts allow-popups"',
    ]);
  });
});
