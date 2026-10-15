import { useEffect, useRef } from "react";

/**
 * 外部输入注入通道（纯化替代源实现的 window CustomEvent 总线）。
 *
 * 来源：从 `packages/agent-runtime/web/components/chat/ChatComposer.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除） 的三个
 * `window.addEventListener` effect 中切出——拆分原因是源文件 597 行超过 500 行红线。
 * 纯化改动点（把「如何订阅」交给宿主，把「订阅到什么」留在包内）：
 * - 源 `chat:apply-suggested-prompt` → `{ type: "suggested-prompt", prompt }`。
 * - 源 `file-tree:reference` → `{ type: "file-reference", file: { name, path } }`；
 *   源实现用 `envId` 过滤事件，该过滤属宿主会话/环境作用域职责，改由宿主在派发前完成。
 * - 源 `chat:quote` → `{ type: "quote", quote: { text } }`；源实现用 `contextScope` 过滤，
 *   同样上移到宿主（包内仍保留 `contextScope` 驱动的「切换会话清空引用」行为）。
 */

/** 宿主可注入的输入岛外部事件。 */
export type ComposerExternalEvent =
  | { type: "suggested-prompt"; prompt: string }
  | { type: "file-reference"; file: { name: string; path: string } }
  | { type: "quote"; quote: { text: string } }
  /**
   * 回填草稿（待发送队列「取回」用）：**只在草稿为空时**写入。
   *
   * 与 `suggested-prompt`（无条件替换正文）分开的原因：取回是「把退回的内容还给用户」，
   * 覆盖用户已经重新打的字等于丢草稿；判定必须发生在持有草稿的一侧（输入岛），调用方
   * 无法读到半受控草稿。
   */
  | { type: "restore-draft"; prompt: string };

/** 订阅函数：注册处理器并返回取消订阅函数（宿主实现通常桥接 window 事件或消息通道）。 */
export type ComposerExternalSubscribe = (handler: (event: ComposerExternalEvent) => void) => () => void;

/** 四类外部事件的处理回调。 */
export interface ComposerExternalHandlers {
  /** 建议提示词（源 `chat:apply-suggested-prompt`）：替换草稿正文。 */
  onSuggestedPrompt: (prompt: string) => void;
  /** 文件树「引用到聊天」（源 `file-tree:reference`）：追加 `@./path` 正文与附件引用。 */
  onFileReference: (file: { name: string; path: string }) => void;
  /** 聊天引用（源 `chat:quote`）：追加一条待发送引用，超限时按配额回调提示。 */
  onQuote: (quote: { text: string }) => void;
  /** 回填草稿（待发送队列「取回」）：草稿非空时不覆盖。 */
  onRestoreDraft: (prompt: string) => void;
}

/**
 * 订阅宿主注入的外部输入事件。
 *
 * 处理器经 ref 转发，因此宿主可以传内联对象而不导致重复订阅；只有 `subscribe` 身份变化时
 * 才重新订阅（源实现对每个事件各自订阅一次，行为等价）。
 */
export function useComposerExternalInput(
  subscribe: ComposerExternalSubscribe | undefined,
  handlers: ComposerExternalHandlers,
): void {
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      const current = handlersRef.current;
      if (event.type === "suggested-prompt") current.onSuggestedPrompt(event.prompt);
      else if (event.type === "file-reference") current.onFileReference(event.file);
      else if (event.type === "restore-draft") current.onRestoreDraft(event.prompt);
      else current.onQuote(event.quote);
    });
  }, [subscribe]);
}
