import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@fenix/ui-components/lib/theme";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { HINDSIGHT_NS, hindsightResources } from "../i18n";
import { Graph2D } from "../pages/hindsight/components/Graph2d";

async function graphTranslations(language: string) {
  const instance = createInstance();
  await instance.init({
    lng: language,
    fallbackLng: "en",
    ns: [HINDSIGHT_NS],
    resources: {
      en: { [HINDSIGHT_NS]: hindsightResources.en },
      zh: { [HINDSIGHT_NS]: hindsightResources.zh },
    },
  });
  return instance.getFixedT(null, NS.HINDSIGHT);
}

describe("记忆图谱运行时翻译", () => {
  // 真实图谱组件在语言切换后重新渲染，操作提示必须来自已加载的资源而不是翻译键。
  test("图谱组件使用已注册资源并响应中英文切换", async () => {
    const instance = createInstance();
    await instance.use(initReactI18next).init({
      lng: "zh",
      fallbackLng: "en",
      ns: [HINDSIGHT_NS],
      resources: {
        en: { [HINDSIGHT_NS]: hindsightResources.en },
        zh: { [HINDSIGHT_NS]: hindsightResources.zh },
      },
    });
    const renderGraph = () =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n: instance },
          createElement(ThemeProvider, {}, createElement(Graph2D, { data: { nodes: [], links: [] } })),
        ),
      );

    expect(renderGraph()).toContain("滚轮缩放 · 拖动平移");
    await instance.changeLanguage("en");
    expect(renderGraph()).toContain("Scroll to zoom · Drag to pan");
    expect(renderGraph()).not.toContain("graph2d.controlsHint");
  });

  // 图谱和星座图应使用 owner 字典的中文说明，而非直接展示翻译键或英文默认值。
  test("中文界面解析图谱与星座图操作提示", async () => {
    const translate = await graphTranslations("zh");

    expect(translate("graph2d.controlsHint")).toBe("滚轮缩放 · 拖动平移");
    expect(translate("constellation.instructions")).toBe("滚轮缩放 · 拖动平移 · 点击节点查看详情");
    expect(translate("constellation.tooltipEntities")).toBe(hindsightResources.zh.constellation.tooltipEntities);
  });

  // 英文界面使用同一命名空间，不能因中文修复破坏另一种受支持语言。
  test("英文界面解析图谱与星座图操作提示", async () => {
    const translate = await graphTranslations("en");

    expect(translate("graph2d.controlsHint")).toBe(hindsightResources.en.graph2d.controlsHint);
    expect(translate("constellation.instructions")).toBe(hindsightResources.en.constellation.instructions);
    expect(translate("constellation.tooltipEntities")).toBe(hindsightResources.en.constellation.tooltipEntities);
  });

  // 区域语言回退到中文基础语言，未支持语言回退到英文，均不应泄露翻译键。
  test("区域语言和未支持语言保留可读的回退提示", async () => {
    const regional = await graphTranslations("zh-CN");
    const fallback = await graphTranslations("fr");

    expect(regional("graph2d.controlsHint")).toBe(hindsightResources.zh.graph2d.controlsHint);
    expect(regional("constellation.instructions")).toBe(hindsightResources.zh.constellation.instructions);
    expect(fallback("graph2d.controlsHint")).toBe(hindsightResources.en.graph2d.controlsHint);
    expect(fallback("constellation.instructions")).toBe(hindsightResources.en.constellation.instructions);
  });
});
