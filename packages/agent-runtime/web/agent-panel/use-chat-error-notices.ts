import type { ActionError, PublicErrorInfo } from "@fenix/chat-channel";
import { useCallback, useEffect, useRef, useState } from "react";
import { isSyncError } from "./chat-error-presentation";

/** 会话范围内的临时提示；已确认回执与连接恢复分别结算自己的故障。 */
export function useChatErrorNotices(scope: string) {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [connection, setConnection] = useState<{ scope: string; error: PublicErrorInfo | null } | null>(null);
  const [actions, setActions] = useState<{
    entries: Array<{ scope: string; error: ActionError }>;
    dismissed: Array<{ scope: string; id: string }>;
  }>({ entries: [], dismissed: [] });
  const lastDiagnostic = useRef<string | null>(null);
  useEffect(() => {
    setConnection((current) => (current?.scope === scope ? current : null));
    setActions((current) => ({
      entries: current.entries.filter((item) => item.scope === scope),
      dismissed: current.dismissed.filter((item) => item.scope === scope),
    }));
  }, [scope]);
  const setClassifiedError = useCallback((error: PublicErrorInfo | null) => {
    setConnection({ scope: scopeRef.current, error });
    const diagnostic = JSON.stringify([scopeRef.current, error?.id]);
    if (error && isSyncError(error) && lastDiagnostic.current !== diagnostic) {
      lastDiagnostic.current = diagnostic;
      console.warn("[chat] sync diagnostic", { errorType: error.type, errorId: error.id, stage: "connection" });
    }
  }, []);
  const showActionError = useCallback((error: ActionError) => {
    const scope = scopeRef.current;
    setActions((current) =>
      current.entries.some((item) => item.scope === scope && item.error.error.id === error.error.id) ||
      current.dismissed.some((item) => item.scope === scope && item.id === error.error.id)
        ? current
        : { ...current, entries: [...current.entries, { scope, error }] },
    );
  }, []);
  const clearActionError = useCallback((commandId: string) => {
    setActions((current) => ({
      ...current,
      entries: current.entries.filter((item) => item.error.commandId !== commandId),
    }));
  }, []);
  const dismissActionError = useCallback((errorId: string) => {
    const scope = scopeRef.current;
    setActions((current) => ({
      entries: current.entries.filter((item) => item.scope !== scope || item.error.error.id !== errorId),
      // 保留近期关闭记录，避免晚到的重复帧撤销用户操作；切会话时回收。
      dismissed: [
        ...current.dismissed.filter((item) => item.scope !== scope || item.id !== errorId),
        { scope, id: errorId },
      ].slice(-256),
    }));
  }, []);
  const clearRecoveredConnectionError = useCallback((primarySyncRecovered = false) => {
    const scope = scopeRef.current;
    setConnection((current) =>
      current?.scope === scope &&
      (current.error?.type === "SYNC_RELAY.CONNECTION_LOST" ||
        current.error?.type === "SYNC_RELAY.KEEPALIVE_TIMEOUT" ||
        (primarySyncRecovered && current.error?.type === "SYNC_RELAY.SYNC_FAILED"))
        ? null
        : current,
    );
  }, []);
  return {
    classifiedError: connection?.scope === scope ? connection.error : null,
    actionErrors: actions.entries.filter((item) => item.scope === scope).map((item) => item.error),
    setClassifiedError,
    showActionError,
    clearActionError,
    dismissActionError,
    clearRecoveredConnectionError,
  };
}
