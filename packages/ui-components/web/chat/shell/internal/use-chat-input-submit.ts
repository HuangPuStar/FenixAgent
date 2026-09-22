/**
 * ChatInterface 的提交与"待发送缓存"逻辑。
 *
 * 来源：从 `packages/chat-channel/web/components/ChatInterface.tsx`（旧路径，已于 2026-09-21 由 8f364c109 删除） 的 `handleChatInputSubmit`、
 * 两个 pending-send effect 与相关 ref 原样抽出（抽出后 ChatInterface 保持在单文件 500 行红线内）。
 * 纯化改动点：
 * - 图片准备失败不再调用 sonner toast，改为把宿主已翻译的文案经 `onNotice` 抛出（hook 不依赖 i18n）。
 * - 补上提交链路上三处「消息被静默丢弃」的失败反馈：会话创建失败、显式发送失败、会话就绪后的自动补发失败。
 *   三者原先只有 `console.error`，用户既看不到提示也拿不回已缓存的 prompt（`pendingSendRef` 已被清空）。
 *   文案同样经 `onNotice` 抛出（沿用上面那条纯化约定，hook 自身不引 i18n）。
 * - 其余顺序与失败语义逐字保留：正文 + 附件引用 → 图片 ContentBlock → 空提交拦截 →
 *   quoteContext / 场景提示词 / 上下文队列 unshift → 无活跃会话时缓存 prompt 并等待会话就绪（10s 超时保护）。
 * - 源在提交路径上还会写 `userCancelledRef.current = false`；该 ref 在源与包内均为只写状态（无读取点），
 *   故未随提交链路搬入 hook，留在 `ChatInterface` 内维护。
 */

import { useCallback, useEffect, useRef } from "react";
import { prepareImageContent } from "../../composer/chat-image-content";
import type { CompressImage } from "../../composer/composer-file-processing";
import { buildPromptText } from "../../composer/composer-prompt";
import type { ChatInputMessage, ContentBlock } from "../../types";
import type { ChatNotice } from "../chat-interface-types";

/** 待发送缓存超时（毫秒）：会话创建失败时清理缓存，避免 prompt 永久挂起。 */
const PENDING_SEND_TIMEOUT_MS = 10_000;

/** useChatInputSubmit 选项。 */
export interface ChatInputSubmitOptions {
  /** 当前是否正在等待 agent 响应 */
  isLoading: boolean;
  /** YJS 投影的活跃会话 ID；为空时提交会先创建会话 */
  activeSessionId: string | null;
  /** 场景提示词（仅首条消息注入，隐藏不显示） */
  scenePrompt?: string;
  /** 上下文队列作用域（传给 `flushContext`） */
  contextScope?: string;
  /**
   * 取出并清空当前作用域的上下文队列（源为宿主 `@/src/lib/context-queue.flushContext`，属有状态模块级队列，
   * 未复制进包内）；未提供时本次提交不注入上下文块。
   */
  flushContext?: (scope?: string) => string | null;
  /**
   * 发送前的图片二次压缩（>2MiB 时归一为 JPEG）。源实现在发送边界无条件压缩；纯化后压缩能力
   * 由宿主注入（`compressImage` 端口），但**输入岛与发送边界必须用同一个端口**：输入岛压缩后
   * 体积仍可能越过 2MiB 阈值，缺这一步就失去源实现「发出图片 ≤2MiB」的保证。未提供时不压缩。
   */
  compressImage?: CompressImage;
  onCreateSession: () => Promise<void>;
  onSendPrompt: (contentBlocks: ContentBlock[]) => Promise<void>;
  /** 图片准备失败时的提示出口（替代 sonner toast） */
  onNotice?: (notice: ChatNotice) => void;
  /** 图片准备失败的提示文案（由组件翻译后传入，hook 自身不依赖 i18n） */
  imagePrepareFailedMessage: string;
  /** 会话创建失败的提示文案（同上，由组件翻译后传入） */
  sessionCreateFailedMessage: string;
  /** 发送 prompt 失败的提示文案（同上；含会话就绪后的自动补发失败） */
  sendPromptFailedMessage: string;
}

/**
 * 返回提交函数 `submit(message)`：把 `ChatInputMessage` 归一化为 `ContentBlock[]` 并发送。
 *
 * 复制自 `ChatInterface.tsx` 的提交链路（抽出为内部 hook）；纯化改动点见文件头。
 */
export function useChatInputSubmit({
  isLoading,
  activeSessionId,
  scenePrompt,
  contextScope,
  flushContext,
  compressImage,
  onCreateSession,
  onSendPrompt,
  onNotice,
  imagePrepareFailedMessage,
  sessionCreateFailedMessage,
  sendPromptFailedMessage,
}: ChatInputSubmitOptions): (message: ChatInputMessage) => Promise<void> {
  // 场景提示词是否已注入（仅首条消息）
  const scenePromptUsedRef = useRef(false);
  // 缓存用户首次发送的 prompt，等 activeSessionId 就绪后自动发送
  const pendingSendRef = useRef<ContentBlock[] | null>(null);
  const pendingSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset scene prompt flag when session changes
  useEffect(() => {
    scenePromptUsedRef.current = false;
  }, []);

  /**
   * 丢弃缓存的 pending prompt 并清掉超时定时器。
   *
   * 2026-09-22 库内去重：本文件此前在「会话就绪后发出」「卸载/contextKey 变化清理」
   * 「建会话失败」三处各写了一份逐字相同的清理块，收敛到此；清理顺序与判空口径不变。
   * 只操作两个 ref，故 `useCallback` 依赖为空、身份稳定。
   */
  const clearPendingSend = useCallback(() => {
    pendingSendRef.current = null;
    if (pendingSendTimerRef.current) {
      clearTimeout(pendingSendTimerRef.current);
      pendingSendTimerRef.current = null;
    }
  }, []);

  // 当 activeSessionId 从无到有时（首次发送自动创建会话），发送缓存的 prompt
  useEffect(() => {
    if (activeSessionId && pendingSendRef.current) {
      const blocks = pendingSendRef.current;
      clearPendingSend();
      onSendPrompt(blocks).catch((err) => {
        console.error("[ChatInterface] Pending send failed:", err);
        // 走到这里说明用户先前提交的消息已被丢弃（pendingSendRef 已清空），必须给回执
        onNotice?.({ level: "error", message: sendPromptFailedMessage });
      });
    }
  }, [activeSessionId, onSendPrompt, onNotice, sendPromptFailedMessage, clearPendingSend]);

  // 组件卸载或 contextKey 变化时清理 pending prompt（避免内存泄漏 / 错误发送）
  useEffect(() => {
    return () => {
      clearPendingSend();
    };
  }, [clearPendingSend]);

  return useCallback(
    async (message: ChatInputMessage) => {
      const draftText = buildPromptText(message).trim();
      const images = message.images || [];
      const attachmentReferences = (message.attachments ?? [])
        .filter((attachment) => !draftText.includes(`@./${attachment.path}`))
        .map((attachment) => `@./${attachment.path}`);
      const text = [draftText, ...attachmentReferences].filter(Boolean).join("\n");

      if ((!text && images.length === 0) || isLoading) return;

      const contentBlocks: ContentBlock[] = [];

      if (text) {
        contentBlocks.push({ type: "text", text });
      }

      // 图片保持 ContentBlock 顺序；单张失败不阻塞其余正文与附件引用。
      for (const image of images) {
        try {
          contentBlocks.push(await prepareImageContent(image, compressImage));
        } catch (error) {
          console.error("[ChatInterface] Failed to prepare image:", error);
          onNotice?.({ level: "error", message: imagePrepareFailedMessage });
          return;
        }
      }

      if (contentBlocks.length === 0) return;

      // 引用属于本次提交，直接随 prompt 原子传递；仍使用 system-reminder 协议供 Agent 识别，
      // 但 Chat 历史投影会隐藏这类内部上下文。
      if (message.quoteContext) {
        contentBlocks.unshift({ type: "text", text: `<system-reminder>\n${message.quoteContext}\n</system-reminder>` });
      }

      // 注入场景提示词（仅第一条消息，隐藏不显示）
      if (scenePrompt && !scenePromptUsedRef.current) {
        contentBlocks.unshift({ type: "text", text: scenePrompt });
        scenePromptUsedRef.current = true;
      }

      // 注入上下文队列（flush 后清空；队列实现由宿主注入）
      const contextBlock = flushContext?.(contextScope);
      if (contextBlock) {
        contentBlocks.unshift({ type: "text", text: contextBlock });
      }

      // 无活跃会话时先创建会话，prompt 缓存到 pendingSendRef，等 activeSessionId 就绪后由上方 effect 自动发送
      if (!activeSessionId) {
        // 已有待发送的 prompt 在等待中，忽略重复提交
        if (pendingSendRef.current) return;
        pendingSendRef.current = contentBlocks;
        // 超时保护：若会话创建失败则清理缓存，避免 prompt 永久挂起
        pendingSendTimerRef.current = setTimeout(() => {
          if (pendingSendRef.current) {
            pendingSendRef.current = null;
            console.warn("[ChatInterface] Session creation timeout, pending send cleared");
          }
        }, PENDING_SEND_TIMEOUT_MS);
        try {
          await onCreateSession();
        } catch (err) {
          console.error("[ChatInterface] Failed to create session:", err);
          onNotice?.({ level: "error", message: sessionCreateFailedMessage });
          clearPendingSend();
        }
        return;
      }

      try {
        await onSendPrompt(contentBlocks);
      } catch (error) {
        console.error("[ChatInterface] Failed to send prompt:", error);
        onNotice?.({ level: "error", message: sendPromptFailedMessage });
      }
    },
    [
      isLoading,
      onSendPrompt,
      scenePrompt,
      activeSessionId,
      onCreateSession,
      contextScope,
      flushContext,
      compressImage,
      onNotice,
      imagePrepareFailedMessage,
      sessionCreateFailedMessage,
      sendPromptFailedMessage,
      clearPendingSend,
    ],
  );
}
