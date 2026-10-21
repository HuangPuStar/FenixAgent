import type { ActionAck, ActionError } from "@fenix/chat-channel";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AGENT_CHAT_NS } from "../i18n/namespace";
import { randomUUID } from "../lib/random-uuid";
import type { createYjsWs } from "../yjs/yjs-ws";
import type { ChatPanelCallbacks, PreservedPrompt } from "./chat-panel-runtime-types";
import { createUserInputQueueSendPorts } from "./chat-panel-user-input-queue";

interface Options {
  wsRef: RefObject<ReturnType<typeof createYjsWs> | null>;
  sessionId: string | null;
  noReplaySessionRef: RefObject<boolean>;
  syncDegradedBlocked: boolean;
  returnToLatestHistory?: () => Promise<unknown>;
  showActionError: (error: ActionError) => void;
}

/** 管理动作身份、创建回执与被拒输入；连接重建不丢失未知结果的幂等键。 */
export function useChatPanelActions({
  wsRef,
  sessionId,
  noReplaySessionRef,
  syncDegradedBlocked,
  returnToLatestHistory,
  showActionError,
}: Options) {
  const { t } = useTranslation(AGENT_CHAT_NS);
  const commandIds = useRef(new Map<string, string>());
  const pendingCreates = useRef(new Map<string, (id: string | null) => void>());
  const pendingPrompts = useRef(new Map<string, PreservedPrompt>());
  const [preservedPrompts, setPreservedPrompts] = useState<PreservedPrompt[]>([]);
  const preservedPrompt = preservedPrompts[0] ?? null;
  const preserve = useCallback((prompt: PreservedPrompt) => {
    setPreservedPrompts((current) => [...current.filter((item) => item.commandId !== prompt.commandId), prompt]);
  }, []);
  const commandKey = useCallback((data: Record<string, unknown>) => {
    const { commandId: _ignored, ...intent } = data;
    return JSON.stringify(intent);
  }, []);
  const releaseCommandId = useCallback((id: string) => {
    for (const [key, value] of commandIds.current) if (value === id) commandIds.current.delete(key);
  }, []);
  const settleCreate = useCallback((id: string, result: string | null) => {
    const settle = pendingCreates.current.get(id);
    pendingCreates.current.delete(id);
    settle?.(result);
  }, []);
  const handleActionAck = useCallback(
    (ack: ActionAck) => {
      if (ack.status !== "committed" && ack.status !== "duplicate") return;
      releaseCommandId(ack.commandId);
      pendingPrompts.current.delete(ack.commandId);
      setPreservedPrompts((current) => current.filter((item) => item.commandId !== ack.commandId));
      settleCreate(ack.commandId, ack.sessionId ?? null);
    },
    [releaseCommandId, settleCreate],
  );
  const handleActionError = useCallback(
    (error: ActionError) => {
      const unknown = error.error.type === "ACTION.OUTCOME_UNKNOWN";
      // 未知结果的键必须保留；换一个 id 自动重试会绕过服务端副作用保护。
      if (!unknown) releaseCommandId(error.commandId);
      const prompt = pendingPrompts.current.get(error.commandId);
      if (prompt) {
        pendingPrompts.current.delete(error.commandId);
        preserve({ ...prompt, outcomeUnknown: unknown });
      }
      settleCreate(error.commandId, null);
      showActionError(error);
    },
    [releaseCommandId, settleCreate, showActionError, preserve],
  );
  const handleConnectionLost = useCallback(() => {
    for (const prompt of pendingPrompts.current.values()) preserve({ ...prompt, outcomeUnknown: true });
    pendingPrompts.current.clear();
  }, [preserve]);
  const sendViaWs = useCallback(
    (data: Record<string, unknown>): boolean => {
      const key = commandKey(data);
      const explicitId = typeof data.commandId === "string" ? data.commandId : null;
      const id = explicitId ?? commandIds.current.get(key) ?? randomUUID();
      if (!explicitId) commandIds.current.set(key, id);
      if (data.action === "send_prompt" && Array.isArray(data.content)) {
        pendingPrompts.current.set(id, {
          commandId: id,
          sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
          content: structuredClone(data.content),
          outcomeUnknown: false,
        });
      }
      const sent = wsRef.current?.isConnected() === true && wsRef.current.send({ ...data, commandId: id });
      if (!sent) {
        const prompt = pendingPrompts.current.get(id);
        if (prompt) {
          pendingPrompts.current.delete(id);
          preserve(prompt);
        }
      }
      return sent;
    },
    [commandKey, wsRef, preserve],
  );
  const sendAction = useCallback(
    (data: Record<string, unknown>) => {
      const ok = sendViaWs(data);
      if (!ok) toast.error(t("wsSendFailed"));
      return ok;
    },
    [sendViaWs, t],
  );
  const createSessionWithReceipt = useCallback(async () => {
    const commandId = randomUUID();
    const receipt = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => settleCreate(commandId, null), 15_000);
      pendingCreates.current.set(commandId, (id) => {
        clearTimeout(timer);
        resolve(id);
      });
    });
    if (!sendAction({ action: "create_session", commandId })) settleCreate(commandId, null);
    return receipt;
  }, [sendAction, settleCreate]);
  useEffect(() => {
    const pending = pendingCreates.current;
    return () => {
      for (const settle of pending.values()) settle(null);
      pending.clear();
    };
  }, []);
  const sendPrompt = useCallback(
    (content: unknown[]) => {
      if (syncDegradedBlocked) return;
      returnToLatestHistory?.().catch(() => false);
      sendAction({ action: "send_prompt", content, sessionId: sessionId ?? undefined });
    },
    [syncDegradedBlocked, returnToLatestHistory, sendAction, sessionId],
  );
  const retryPreservedPrompt = useCallback(() => {
    if (!preservedPrompt || preservedPrompt.outcomeUnknown || syncDegradedBlocked || !sessionId) return;
    // 用户显式确认当前目标后才建立新意图，旧输入的文本、图片与附件保持原样。
    const prompt = preservedPrompt;
    setPreservedPrompts((current) => current.filter((item) => item.commandId !== prompt.commandId));
    sendPrompt(prompt.content);
  }, [preservedPrompt, syncDegradedBlocked, sessionId, sendPrompt]);
  const dismissPreservedPrompt = useCallback(() => {
    if (!preservedPrompt) return;
    const dismissedId = preservedPrompt.commandId;
    releaseCommandId(dismissedId);
    setPreservedPrompts((current) => current.filter((prompt) => prompt.commandId !== dismissedId));
  }, [preservedPrompt, releaseCommandId]);
  const callbacks = useMemo(
    (): ChatPanelCallbacks => ({
      onSendPrompt: sendPrompt,
      onCancel: () => {
        sendAction({ action: "cancel", sessionId: sessionId ?? undefined });
      },
      onCreateSession: () => {
        noReplaySessionRef.current = true;
        return createSessionWithReceipt();
      },
      onLoadSession: (sid) => {
        noReplaySessionRef.current = false;
        sendAction({ action: "load_session", sessionId: sid });
      },
      onResumeSession: (sid) => {
        noReplaySessionRef.current = false;
        sendAction({ action: "resume_session", sessionId: sid });
      },
      onRenameSession: (sid, title) => {
        sendAction({ action: "rename_session", sessionId: sid, title });
      },
      onDeleteSession: (sid) => {
        sendAction({ action: "delete_session", sessionId: sid });
      },
      onRespondPermission: (requestId, optionId) => {
        sendAction({ action: "respond_permission", requestId, optionId });
      },
      onRespondQuestion: (questionId, answers) => {
        sendAction({ action: "respond_question", questionId, answers });
      },
      onSetMode: (modeId) => {
        sendAction({ action: "set_session_mode", modeId });
      },
      ...createUserInputQueueSendPorts(sendAction),
    }),
    [sendPrompt, sendAction, sessionId, noReplaySessionRef, createSessionWithReceipt],
  );
  return {
    sendViaWs,
    handleActionAck,
    handleActionError,
    handleConnectionLost,
    callbacks,
    preservedPrompt,
    retryPreservedPrompt,
    dismissPreservedPrompt,
  };
}
