import type { ActionAck, ActionError } from "@fenix/chat-channel";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type LocalCreateBinding, NO_LOCAL_CREATE } from "../hooks/chat-replay-signal";
import { AGENT_CHAT_NS } from "../i18n/namespace";
import { randomUUID } from "../lib/random-uuid";
import type { createYjsWs } from "../yjs/yjs-ws";
import type { ChatPanelCallbacks, PreservedPrompt } from "./chat-panel-runtime-types";
import { createUserInputQueueSendPorts } from "./chat-panel-user-input-queue";

interface Options {
  wsRef: RefObject<ReturnType<typeof createYjsWs> | null>;
  sessionId: string | null;
  /** 本地 create 代次：create 递增、load/resume 归零；scope 绑定由 runtime 在换代帧完成。 */
  localCreateEpochRef: RefObject<number>;
  /** 已消费的 create 归属；create/load/resume/失败时清空，避免下一次 create 复用旧 scope。 */
  localCreateBindingRef: RefObject<LocalCreateBinding>;
  syncDegradedBlocked: boolean;
  returnToLatestHistory?: () => Promise<unknown>;
  showActionError: (error: ActionError) => void;
  clearActionError: (commandId: string) => void;
  noticeScope: string;
}

/** 管理动作身份、创建回执与被拒输入；连接重建不丢失未知结果的幂等键。 */
export function useChatPanelActions({
  wsRef,
  sessionId,
  localCreateEpochRef,
  localCreateBindingRef,
  syncDegradedBlocked,
  returnToLatestHistory,
  showActionError,
  clearActionError,
  noticeScope,
}: Options) {
  const { t } = useTranslation(AGENT_CHAT_NS);
  const commandIds = useRef(new Map<string, { id: string; connectionScoped: boolean }>());
  const pendingCreates = useRef(new Map<string, (id: string | null) => void>());
  const pendingPrompts = useRef(new Map<string, PreservedPrompt>());
  const noticeScopes = useRef(new Map<string, string>());
  const settledNoticeScopes = useRef(new Map<string, string>());
  const noticeScopeRef = useRef(noticeScope);
  noticeScopeRef.current = noticeScope;
  // 在途来源随命令保留；仅淘汰已结算历史，避免繁忙会话丢失仍待回执的反馈。
  const rememberNoticeScope = useCallback((id: string) => {
    const scopes = noticeScopes.current;
    if (!scopes.has(id)) scopes.set(id, settledNoticeScopes.current.get(id) ?? noticeScopeRef.current);
    settledNoticeScopes.current.delete(id);
  }, []);
  const settleNoticeScope = useCallback((id: string) => {
    const scope = noticeScopes.current.get(id);
    if (scope === undefined) return;
    noticeScopes.current.delete(id);
    const settled = settledNoticeScopes.current;
    settled.set(id, scope);
    if (settled.size > 256) {
      const oldest = settled.keys().next().value;
      if (oldest !== undefined) settled.delete(oldest);
    }
  }, []);
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
    for (const [key, value] of commandIds.current) if (value.id === id) commandIds.current.delete(key);
  }, []);
  const settleCreate = useCallback((id: string, result: string | null): boolean => {
    const settle = pendingCreates.current.get(id);
    pendingCreates.current.delete(id);
    settle?.(result);
    return settle !== undefined;
  }, []);
  // 失败/超时/发送失败/结果未知都撤销归属：宁可多一次骨架，也不把后续远端 load 误认成新建。
  const failCreate = useCallback(
    (id: string) => {
      if (!settleCreate(id, null)) return;
      settleNoticeScope(id);
      localCreateEpochRef.current = 0;
      localCreateBindingRef.current = NO_LOCAL_CREATE;
    },
    [settleCreate, settleNoticeScope, localCreateEpochRef, localCreateBindingRef],
  );
  const handleActionAck = useCallback(
    (ack: ActionAck) => {
      if (ack.status !== "committed" && ack.status !== "duplicate") return;
      settleNoticeScope(ack.commandId);
      clearActionError(ack.commandId);
      releaseCommandId(ack.commandId);
      pendingPrompts.current.delete(ack.commandId);
      setPreservedPrompts((current) => current.filter((item) => item.commandId !== ack.commandId));
      settleCreate(ack.commandId, ack.sessionId ?? null);
    },
    [releaseCommandId, settleCreate, clearActionError, settleNoticeScope],
  );
  const handleActionError = useCallback(
    (error: ActionError) => {
      const scope = noticeScopes.current.get(error.commandId) ?? settledNoticeScopes.current.get(error.commandId);
      const unknown = error.error.type === "ACTION.OUTCOME_UNKNOWN";
      // 未知结果的键必须保留；换一个 id 自动重试会绕过服务端副作用保护。
      if (!unknown) {
        releaseCommandId(error.commandId);
        settleNoticeScope(error.commandId);
      }
      const prompt = pendingPrompts.current.get(error.commandId);
      if (prompt) {
        pendingPrompts.current.delete(error.commandId);
        preserve({ ...prompt, outcomeUnknown: unknown });
      }
      failCreate(error.commandId);
      // 接收帧不建立来源，未知或已淘汰的旧命令不能被当前会话重新认领。
      if (scope === noticeScopeRef.current) showActionError(error);
    },
    [releaseCommandId, failCreate, showActionError, preserve, settleNoticeScope],
  );
  const handleConnectionLost = useCallback(() => {
    // load/resume 用于确认本次连接的绑定；旧结果去重不能替代新连接的恢复。
    // prompt/create 等副作用意图仍保留原 ID，不能随连接结束而重新执行。
    for (const [key, identity] of commandIds.current) {
      if (identity.connectionScoped) {
        commandIds.current.delete(key);
        settleNoticeScope(identity.id);
      }
    }
    for (const prompt of pendingPrompts.current.values()) preserve({ ...prompt, outcomeUnknown: true });
    pendingPrompts.current.clear();
    // 断线后 create 回执不会到达：撤销归属，避免重连后的远端 load 被误认成新建。
    if (pendingCreates.current.size > 0) {
      localCreateEpochRef.current = 0;
      localCreateBindingRef.current = NO_LOCAL_CREATE;
    }
  }, [preserve, localCreateEpochRef, localCreateBindingRef, settleNoticeScope]);
  const allocateCommandId = useCallback(() => {
    const epoch = wsRef.current?.getCommandEpoch();
    return epoch ? `${epoch}.${randomUUID()}` : null;
  }, [wsRef]);
  const sendViaWs = useCallback(
    (data: Record<string, unknown>): boolean => {
      const key = commandKey(data);
      const explicitId = typeof data.commandId === "string" ? data.commandId : null;
      const id = explicitId ?? commandIds.current.get(key)?.id ?? allocateCommandId();
      if (id === null) return false;
      rememberNoticeScope(id);
      if (!explicitId) {
        commandIds.current.set(key, {
          id,
          connectionScoped: data.action === "load_session" || data.action === "resume_session",
        });
      }
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
    [commandKey, wsRef, preserve, allocateCommandId, rememberNoticeScope],
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
    const commandId = allocateCommandId();
    if (commandId === null) {
      // 未分配 commandId 同样没有确认结果：撤销 create 归属，避免后续远端 load 被误认。
      localCreateEpochRef.current = 0;
      localCreateBindingRef.current = NO_LOCAL_CREATE;
      toast.error(t("wsSendFailed"));
      return null;
    }
    const receipt = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => failCreate(commandId), 15_000);
      pendingCreates.current.set(commandId, (id) => {
        clearTimeout(timer);
        resolve(id);
      });
    });
    if (!sendAction({ action: "create_session", commandId })) failCreate(commandId);
    return receipt;
  }, [sendAction, failCreate, allocateCommandId, t, localCreateEpochRef, localCreateBindingRef]);
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
    settleNoticeScope(dismissedId);
    setPreservedPrompts((current) => current.filter((prompt) => prompt.commandId !== dismissedId));
  }, [preservedPrompt, releaseCommandId, settleNoticeScope]);
  const callbacks = useMemo(
    (): ChatPanelCallbacks => ({
      onSendPrompt: sendPrompt,
      onCancel: () => {
        sendAction({ action: "cancel", sessionId: sessionId ?? undefined });
      },
      onCreateSession: () => {
        localCreateEpochRef.current += 1;
        localCreateBindingRef.current = NO_LOCAL_CREATE;
        return createSessionWithReceipt();
      },
      onLoadSession: (sid) => {
        localCreateEpochRef.current = 0;
        localCreateBindingRef.current = NO_LOCAL_CREATE;
        return sendAction({ action: "load_session", sessionId: sid });
      },
      onResumeSession: (sid) => {
        localCreateEpochRef.current = 0;
        localCreateBindingRef.current = NO_LOCAL_CREATE;
        return sendAction({ action: "resume_session", sessionId: sid });
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
    [sendPrompt, sendAction, sessionId, localCreateEpochRef, localCreateBindingRef, createSessionWithReceipt],
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
