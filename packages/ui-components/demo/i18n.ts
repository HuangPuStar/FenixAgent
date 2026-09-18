import { createInstance, type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next/initReactI18next";

import en from "../web/i18n/locales/en/uiComponents.json";
import zh from "../web/i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../web/lib/i18n";

/**
 * demo 自带的 i18n 实例。
 *
 * 与真实消费方的接入方式保持一致：包内组件只通过 `useTranslation(UI_COMPONENTS_NS)` 取文案，
 * 文案资源必须由消费方注册 —— demo 直接 import 包内 locale JSON 注册到同名命名空间，
 * 这正是 README「i18n」一节描述的消费方职责。
 *
 * 使用 `createInstance` 的独立实例而非 i18next 全局单例，避免展示页污染同页面中其它 i18n 状态；
 * `initReactI18next` 仍会把该实例登记为 react-i18next 的默认实例，因此包内那些没有显式包裹
 * `I18nextProvider` 的组件也能读到同一份资源。
 *
 * demo 自身的界面文案（导航、语言标签）放在 `demo` 命名空间：它们属于展示页，不属于组件包。
 */

export const DEMO_NS = "demo";

export type DemoLanguage = "en" | "zh";

/** demo 界面文案（英文）。 */
const demoEn = {
  appTitle: "Fenix UI Components",
  language: "Language",
  sections: {
    primitives: "Primitives",
    forms: "Forms",
    data: "Data display",
    feedback: "Feedback",
    overlay: "Overlay",
    ai: "AI elements",
    composite: "Composite",
    theme: "Theme",
  },
};

/** 以 demoEn 约束 zh 资源，保证两种语言的键结构一致（缺键会在编译期暴露）。 */
const demoZh: typeof demoEn = {
  appTitle: "Fenix UI Components",
  language: "语言",
  sections: {
    primitives: "基础控件",
    forms: "表单",
    data: "数据展示",
    feedback: "反馈",
    overlay: "布局与浮层",
    ai: "AI 元素",
    composite: "综合",
    theme: "主题",
  },
};

export const demoI18n: I18nInstance = createInstance();

/**
 * 幂等初始化 i18n 实例并返回它。
 *
 * 资源是内联对象（无异步 backend），因此用 `initAsync: false` 让 init 同步完成，
 * 避免首帧渲染出未翻译的原始 key。
 */
export function setupDemoI18n(): I18nInstance {
  if (demoI18n.isInitialized) return demoI18n;

  void demoI18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: [DEMO_NS, UI_COMPONENTS_NS],
    defaultNS: DEMO_NS,
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: {
      en: { [DEMO_NS]: demoEn, [UI_COMPONENTS_NS]: en },
      zh: { [DEMO_NS]: demoZh, [UI_COMPONENTS_NS]: zh },
    },
  });

  return demoI18n;
}

/** 切换 demo 语言；只接受 en / zh 两个语言码。 */
export function changeDemoLanguage(language: DemoLanguage): Promise<unknown> {
  return demoI18n.changeLanguage(language);
}

/** 读取当前生效语言；未初始化或语言码未知时回退 en（与 fallbackLng 一致）。 */
export function getDemoLanguage(): DemoLanguage {
  return demoI18n.resolvedLanguage === "zh" ? "zh" : "en";
}
