// ChatComposer / CommandMenu 的服务端渲染测试（CE 阶段 2 §1.6 T6c1 从
// `packages/agent-runtime/web/__tests__/chat-composer-ssr.test.tsx` 迁入包内）。
//
// 迁移改动：组件改从包内 `../chat/composer/*` 导入；i18n 从宿主 `@/src/i18n` 单例 + `components.json`
// 换成包内 `createInstance` + `../i18n/locales/en/uiComponents.json`（键前缀由 `chatInput.*` /
// `chatComposer.*` 变为 `chat.components.*`）；`envId` prop 随纯化去掉，附件能力改由
// `supportsImages` 表达。SSR 不需要 DOM 引导，故不引入 happy-dom。
//
// 断言仍保留「译文或 key 两种形态都接受」的口径：本文件自带 i18next 实例，若同进程其他测试
// 改写了 `react-i18next` 的默认实例，`t()` 可能回显 key，元素缺失仍会失败。

import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import { ChatComposer } from "../chat/composer/ChatComposer";
import { CommandMenu } from "../chat/composer/CommandMenu";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

/** 按点号路径读取字典里的字符串；缺键返回 undefined。 */
function lookup(dictionary: unknown, path: string): string | undefined {
  let current: unknown = dictionary;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * 断言渲染结果里出现了某条 composer 文案（命名空间 `uiComponents`，字典见
 * `packages/ui-components/web/i18n/locales/en/uiComponents.json`，key 形如
 * `chat.components.chatInput.placeholder`）。
 *
 * 译文与 key 两种形态都接受：自带 provider 时返回真实译文；同进程其他测试改写默认 i18next 实例时
 * `t()` 会回显 key。元素缺失仍会失败。
 *
 * 与 `chat-composer.test.tsx` 的同名 helper 暂各自维护：两份都断言 HTML 子串，但那份取的是
 * `chat.*` 子树译文、本份取全路径键，待两份合并为统一测试工具时再对齐。
 */
function expectCopy(html: string, key: string) {
  const translated = lookup(en, key);
  const hit = [key, translated].some((candidate) => typeof candidate === "string" && html.includes(candidate));
  expect(hit, `文案 ${key} 既没有以译文也没有以 key 形态出现在渲染结果里`).toBe(true);
}

function renderComposer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ChatComposer, {
      onSubmit: () => {},
      ...props,
    }),
  );
}

describe("ChatComposer 服务端渲染", () => {
  // 空闲输入框应展示占位提示和可发送的主操作，供用户开始新对话。
  test("空闲状态渲染输入框与发送操作", () => {
    const html = renderComposer();

    expectCopy(html, "chat.components.chatInput.placeholder");
    expect(html).toContain("lucide-send");
    expect(html).toContain("<textarea");
  });

  // Agent 尚未报告上下文用量时不展示占位入口，避免用破折号制造无效信息。
  test("无上下文信息时隐藏上下文入口", () => {
    const html = renderComposer();

    expect(html).not.toContain('data-slot="chat-composer-context"');
  });

  // 外部禁用时输入和发送入口都必须禁用，避免将消息提交给不可用的会话。
  test("禁用状态锁定输入与发送操作", () => {
    const html = renderComposer({ disabled: true, placeholder: "会话已锁定" });

    expect(html).toContain("会话已锁定");
    expect(html).toContain('disabled=""');
  });

  // 可取消的运行中 turn 必须展示停止操作，不应退化为新的发送按钮。
  test("可取消运行展示停止操作", () => {
    const html = renderComposer({ isLoading: true, canCancel: true });

    expect(html).toContain("lucide-square");
    expect(html).not.toContain("lucide-send");
  });

  // 取消请求已发出时停止操作保持禁用，避免用户重复发送 cancel RPC。
  test("取消中停止操作禁用", () => {
    const html = renderComposer({ isLoading: true, canCancel: false });

    expect(html).toContain("lucide-square");
    expect(html).toContain('disabled=""');
  });

  // 已选择模型应保留在输入框下方，帮助用户确认当前会话所用模型。
  test("渲染当前模型名称", () => {
    const html = renderComposer({ modelName: "Claude Test" });

    expect(html).toContain("Claude Test");
    expect(html).toContain('data-slot="chat-composer-model"');
  });

  // Peri 运行时模型名称只展示括号内别名，完整原始名称保留在 title 中。
  test("简化 Peri 模型名称", () => {
    const html = renderComposer({ modelName: "opus (peri-haiku)" });

    expect(html).toContain('title="opus (peri-haiku)"');
    expect(html).toContain(">peri-haiku</span>");
    expect(html).not.toContain(">opus (peri-haiku)</span>");
  });

  // 左侧信息依次展示模型与上下文，权限模式则位于右侧操作区。
  test("上下文位于左侧信息末尾且权限模式位于右侧", () => {
    const html = renderComposer({
      modelName: "Claude Test",
      contextUsage: { totalTokens: 12_300, contextWindow: 200_000 },
      availableModes: [{ id: "bypass", name: "Bypass" }],
      currentModeId: "bypass",
    });
    const modelIndex = html.indexOf('data-slot="chat-composer-model"');
    const contextIndex = html.indexOf('data-slot="chat-composer-context"');
    const actionsIndex = html.indexOf('data-slot="chat-composer-meta-actions"');

    expect(modelIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBeGreaterThan(modelIndex);
    expect(actionsIndex).toBeGreaterThan(contextIndex);
    // 只读模式 chip 位于右侧操作区内（源断言的是 `chat-composer-meta-actions` 与
    // `chat-composer-security-policy` 的固定嵌套串，改按渲染顺序断言同一事实）。
    expect(html.indexOf('data-slot="chat-composer-security-policy"')).toBeGreaterThan(actionsIndex);
    expect(html).toContain("Bypass");
  });

  // 可用 slash 命令和工作区存在时应提供真实能力与附件入口。
  test("渲染命令与附件入口", () => {
    const html = renderComposer({
      commands: [{ name: "review", description: "审查代码", input: { hint: "目标文件" } }],
      supportsImages: true,
    });

    expectCopy(html, "chat.components.chatComposer.skillButton");
    expect(html).toContain("lucide-blocks");
    expect(html).toContain("lucide-paperclip");
  });

  // 命令菜单必须可独立渲染，避免键盘导航状态重构残留未定义变量导致整个聊天页崩溃。
  test("命令菜单渲染时不访问未定义的导航状态", () => {
    const html = renderToStaticMarkup(
      createElement(CommandMenu, {
        commands: [{ name: "review", description: "审查代码" }],
        mcps: [{ id: "filesystem", name: "Filesystem", description: "读取工作区" }],
        filter: "",
        showSearch: true,
        onSelect: () => {},
        onClose: () => {},
      }),
    );

    // 技能行不再带 `/` 前缀（改版为图标 + 名称，见 `CommandMenu` 文件头第 2 条），故只断言名称。
    expect(html).toContain("review");
    expect(html).toContain("Filesystem");
    expect(html).toContain('data-active="true"');
  });

  // 协议真实 token 用量只显示绝对值，不伪造上下文百分比。
  test("渲染真实 token 用量与新建会话入口", () => {
    const html = renderComposer({
      contextUsage: { totalTokens: 40_000, inputTokens: 30_000, outputTokens: 10_000 },
      showNewSession: true,
      onNewSession: () => {},
    });

    expect(html).toContain("40.0k");
    expectCopy(html, "chat.components.chatComposer.newSession");
    expect(html).toContain('data-slot="chat-composer-context"');
  });
});
