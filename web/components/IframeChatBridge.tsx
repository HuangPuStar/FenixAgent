import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

export interface IframeChatBridgeProps {
  /** iframe 源地址 */
  src: string;
  /** 面板是否展开 */
  chatOpen: boolean;
  /** 工作流上下文提示 */
  scenePrompt?: string;
  /** 上下文标识（workflowId），变化时重新加载 iframe */
  contextKey?: string;
  /** 会话完成后的回调，如刷新草稿 */
  onPromptComplete?: () => void;
}

/**
 * 外部 Chat 系统 iframe 桥接组件。
 *
 * 用于将独立的 agent-chat-ui 前端以 iframe 嵌入 Workflow 编辑器，
 * 通过 postMessage 传递 scenePrompt、Context Queue，接收完成回调。
 *
 * 通信协议：
 *   Parent → iframe: { type: "workflow:context", payload: {...} }
 *   iframe → Parent: { type: "workflow:ready" }
 *   iframe → Parent: { type: "workflow:complete", payload: { timestamp } }
 */
export function IframeChatBridge({ src, chatOpen, scenePrompt, contextKey, onPromptComplete }: IframeChatBridgeProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);

  // 监听 iframe 发来的消息
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // 安全检查：只接受来自 localhost 的消息（开发环境）
      if (!event.origin.match(/^https?:\/\/localhost:/)) return;

      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "workflow:ready":
          readyRef.current = true;
          sendContext();
          break;
        case "workflow:complete":
          onPromptComplete?.();
          break;
        default:
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onPromptComplete, scenePrompt, contextKey],
  );

  // 发送上下文到 iframe
  const sendContext = useCallback(() => {
    if (!iframeRef.current?.contentWindow || !readyRef.current) return;
    if (!scenePrompt && !contextKey) return;

    iframeRef.current.contentWindow.postMessage(
      {
        type: "workflow:context",
        payload: {
          scenePrompt: scenePrompt ?? "",
          workflowId: contextKey ?? "",
          timestamp: Date.now(),
        },
      },
      "*",
    );
  }, [scenePrompt, contextKey]);

  // contextKey 变化时，重置就绪状态
  useEffect(() => {
    readyRef.current = false;
  }, [contextKey]);

  // 监听 postMessage
  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // scenePrompt 或 contextKey 变化时，重新发送上下文
  useEffect(() => {
    if (readyRef.current) {
      sendContext();
    }
  }, [sendContext]);

  if (!chatOpen) {
    return null;
  }

  return (
    <div
      style={{
        width: 400,
        minWidth: 400,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--color-border-subtle)",
        background: "#fff",
      }}
    >
      <iframe
        ref={iframeRef}
        src={src}
        title={t("metaAgent.chat_title")}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
        }}
      />
    </div>
  );
}
