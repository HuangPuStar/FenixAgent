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

/**
 * 分区按组件层级编排，导航顺序即层级顺序：
 * Design Tokens → Base UI P1/P2/P3（页面骨架 → 通用容器 → 基础控件）
 * → Chat L1–L4（外壳 → 主区 → 会话元件 → 消息基元）
 * → 各业务域 L 系列（File / Preview / Workbench / Data / Agent）。
 * 分区 id 同时是 `sections.<id>` 与 `sectionHints.<id>` 的文案键。
 */
const demoEn = {
  appTitle: "Fenix UI Components",
  language: "Language",
  sections: {
    designTokens: "Design Tokens",
    baseUiP1: "Base UI P1",
    baseUiP2: "Base UI P2",
    baseUiP3: "Base UI P3",
    chatL1: "Chat L1",
    chatL2: "Chat L2",
    chatL3: "Chat L3",
    chatL4: "Chat L4",
    fileL1: "File L1",
    fileL2: "File L2",
    previewL1: "Preview L1",
    previewL2: "Preview L2",
    workbenchL1: "Workbench L1",
    workbenchL2: "Workbench L2",
    dataL1: "Data L1",
    dataL2: "Data L2",
    agentL1: "Agent L1",
  },
  sectionHints: {
    designTokens: "Design variables: colors, radius, typography and the light/dark scopes they live in.",
    baseUiP1: "Page frame: the page-level scroll boundary and header baseline.",
    baseUiP2: "Generic dialog containers: confirm and form flows.",
    baseUiP3:
      "Base controls: buttons, form controls, overlays and display primitives, plus the generic pieces sunk from Chat.",
    chatL1: "Session shell: the whole conversation surface.",
    chatL2: "Session body: session list, message stream and composer.",
    chatL3: "Session parts: bubbles and message pieces, tool timeline, command menu and permission/question panels.",
    chatL4: "Message primitives: prompt input, reasoning and tool call.",
    fileL1: "File tree: the tree container and node interactions.",
    fileL2: "Tree interactions: create / rename dialogs layered on the tree.",
    previewL1: "Preview container: empty, loading and content states.",
    previewL2: "Previewers: file content rendering and its plugins.",
    workbenchL1: "Master-detail workbench shell.",
    workbenchL2: "Workbench panel surface.",
    dataL1: "Data table: sorting, pagination and row selection.",
    dataL2: "Table surroundings: batch bar, empty states, status and file-type affordances.",
    agentL1: "Agent card list.",
  },
};

/** 以 demoEn 约束 zh 资源，保证两种语言的键结构一致（缺键会在编译期暴露）。 */
const demoZh: typeof demoEn = {
  appTitle: "Fenix UI Components",
  language: "语言",
  sections: {
    designTokens: "Design Tokens",
    baseUiP1: "Base UI P1",
    baseUiP2: "Base UI P2",
    baseUiP3: "Base UI P3",
    chatL1: "Chat L1",
    chatL2: "Chat L2",
    chatL3: "Chat L3",
    chatL4: "Chat L4",
    fileL1: "File L1",
    fileL2: "File L2",
    previewL1: "Preview L1",
    previewL2: "Preview L2",
    workbenchL1: "Workbench L1",
    workbenchL2: "Workbench L2",
    dataL1: "Data L1",
    dataL2: "Data L2",
    agentL1: "Agent L1",
  },
  sectionHints: {
    designTokens: "设计变量：颜色、圆角、字号，以及它们所处的明暗作用域。",
    baseUiP1: "页面骨架：页面级滚动边界与标题基线。",
    baseUiP2: "通用对话框容器：确认与表单流程。",
    baseUiP3: "基础控件：按钮、表单、浮层与展示基元，以及从 Chat 下沉的通用元件。",
    chatL1: "会话外壳层：整个会话界面的骨架。",
    chatL2: "会话主区层：会话列表、消息流与输入岛。",
    chatL3: "会话元件层：气泡与消息部件、工具时间线、命令菜单与权限 / 问答面板。",
    chatL4: "消息基元层：提示词输入、推理与工具调用。",
    fileL1: "文件树：树容器与节点交互。",
    fileL2: "树交互层：叠在树上的新建 / 重命名对话框。",
    previewL1: "预览容器：空态、加载态与内容切换。",
    previewL2: "预览器：文件内容渲染与渲染插件。",
    workbenchL1: "主从工作台骨架。",
    workbenchL2: "工作台面板表面。",
    dataL1: "数据表格：排序、分页与行选择。",
    dataL2: "表格周边：批量操作、空态、状态徽标与文件类型图标。",
    agentL1: "智能体卡片列表。",
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
