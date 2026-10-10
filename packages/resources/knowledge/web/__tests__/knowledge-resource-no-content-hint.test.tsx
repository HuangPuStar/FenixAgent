// AOS-BUG-003 的展示层口径：解析任务结束但零分块的资源（`status = empty`）必须在资源表里给出**可见**的
// 处理建议，而不是只留一个看起来正常的胶囊——现场就是「列表显示就绪、0 分块、没有任何提示」。
//
// 被钉住的三条只在渲染分支里成立，读服务端源码断言不到：
//   1. 状态词走字典（`status.empty` = 无可用内容），不再是「就绪」；
//   2. 建议句随状态上屏（`resources.noContentHint` / `resources.failedHint`），把「重新上传」这一步说出来；
//   3. 远端 `progress_msg` 原文只作为 `title` 诊断信息，不占据版面、也不作为状态结论。
//
// 只做 SSR 断言（`react-dom/server`）：这条分支没有任何交互，唯一的契约就是「哪些文案上屏、哪些不上屏」
// 以及胶囊的语义色调；用真实 i18next 实例挂本包字典，断言与渲染取同一份文案，字典改了用例跟着走
// （同款先例：`knowledge-access-denied.test.tsx` 的 SSR 口径、`agent-knowledge-bases-page-states.test.tsx`
// 的真实字典实例）。
//
// `react-i18next` 替身必须自己注册并**先于**被测组件加载：`bun test packages/` 是单进程，同批文件
// 注册的是 `t: (key) => key` 的替身，不注册会拿到 key 回显（语义与理由见 `react-i18next-stub.ts`）。

import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { createElement, createRef, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { KNOWLEDGE_NS, knowledgeResources } from "../i18n";
import type { KnowledgeResourceInfo } from "../types/knowledge";
import { registerReactI18nextStub } from "./react-i18next-stub";

/**
 * 用例期望的文案全部取自本包字典；渲染走真实 i18next 实例并挂同一份字典，
 * 因此「字典已登记该键」与「该分支真的渲染了这句文案」被绑在一起。
 */
const TEXT = knowledgeResources.en;

/**
 * 渲染用的真实 i18next 实例：挂本包 en 字典。
 * `resources` 的形状必须是 `{ [语言]: { [命名空间]: 字典 } }`——少一层语言维度时 `t()` 会静默回退为 key。
 */
const i18n = createInstance();
void i18n.init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: KNOWLEDGE_NS,
  initAsync: false,
  resources: { en: { [KNOWLEDGE_NS]: knowledgeResources.en } },
});

registerReactI18nextStub(i18n);

const { AgentKnowledgeResources } = await import("../pages/agent-panel/pages/agent-knowledge-resources");

/** 资源行夹具：默认是一份正常就绪的文档，用例只覆盖差异字段。 */
function resource(overrides: Partial<KnowledgeResourceInfo> = {}): KnowledgeResourceInfo {
  return {
    id: "resource-1",
    knowledgeBaseId: "kb-1",
    sourceName: "sample.pdf",
    sourceType: "upload",
    sourcePath: "/tmp/sample.pdf",
    remoteId: "remote-resource-1",
    status: "ready",
    lastError: null,
    chunkCount: 1,
    runStatus: "DONE",
    createdAt: 1787097600,
    updatedAt: 1787097600,
    ...overrides,
  };
}

/** 渲染资源表（表格本身无交互，SSR 足以断言文案与胶囊色调）。 */
function renderResources(resources: KnowledgeResourceInfo[]): string {
  const node: ReactElement = createElement(AgentKnowledgeResources, {
    resources,
    canManage: true,
    uploading: false,
    deletingResourceId: null,
    reparsingResourceId: null,
    fileInputRef: createRef<HTMLInputElement>(),
    onFilesSelected: () => {},
    onOpenChunks: () => {},
    onToggleEnabled: () => {},
    onReparse: () => {},
    onPreview: () => {},
    onDelete: () => {},
  });
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, node));
}

describe("零分块资源的展示口径", () => {
  // 解析结束但零分块的文档不得显示成「就绪」：状态词换成「无可用内容」，并给出重新上传的建议。
  test("零分块资源显示无可用内容与处理建议", () => {
    const html = renderResources([
      resource({
        status: "empty",
        chunkCount: 0,
        lastError: "No chunk built from demo-truncated.pdf",
      }),
    ]);

    expect(html).toContain(TEXT.status.empty);
    expect(html).toContain(TEXT.resources.noContentHint);
    expect(html).not.toContain(TEXT.status.ready);
    // 语义色调是告警（琥珀）而不是就绪（绿）：`StatusBadge` 把判定结果写在 `data-tone` 上。
    expect(html).toContain('data-tone="warning"');
    // 远端原文只作悬停诊断，不当作结论上屏。
    expect(html).toContain('title="No chunk built from demo-truncated.pdf"');
    // 「检查文件」这条建议必须可执行：预览入口（取源文件，与分块无关）不能随状态一起消失。
    expect(html).toContain(TEXT.preview.btn);
  });

  // 正常解析出分块的资源语义不变：仍是就绪，且不出现任何异常建议（修复不得误伤正常文件）。
  test("正常就绪资源仍显示就绪且不带建议", () => {
    const html = renderResources([resource()]);

    expect(html).toContain(TEXT.status.ready);
    expect(html).not.toContain(TEXT.resources.noContentHint);
    expect(html).not.toContain(TEXT.resources.failedHint);
  });

  // 解析失败的资源给的是「重新解析」这条建议（与零分块的「重新上传」区分开），失败原文同样可悬停查看。
  test("解析失败资源显示失败建议并保留原文诊断", () => {
    const html = renderResources([
      resource({ status: "error", chunkCount: 0, lastError: "Task failed: unexpected end of stream" }),
    ]);

    expect(html).toContain(TEXT.status.error);
    expect(html).toContain(TEXT.resources.failedHint);
    expect(html).not.toContain(TEXT.resources.noContentHint);
    expect(html).toContain('title="Task failed: unexpected end of stream"');
  });
});
