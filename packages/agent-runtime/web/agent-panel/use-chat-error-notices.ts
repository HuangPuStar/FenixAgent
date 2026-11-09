import type { ActionError, PublicErrorInfo } from "@fenix/chat-channel";
import { useCallback, useEffect, useRef, useState } from "react";
import { isSyncError } from "./chat-error-presentation";

/** 会话范围内的临时提示；已确认回执与连接恢复分别结算自己的故障。 */
export function useChatErrorNotices(scope: string) {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [connection, setConnection] = useState<{ scope: string; error: PublicErrorInfo | null } | null>(null);
  const [actions, setActions] = useState<Array<{ scope: string; error: ActionError }>>([]);
  const lastDiagnostic = useRef<string | null>(null);
  useEffect(() => {
    setConnection((current) => (current?.scope === scope ? current : null));
    setActions((current) => current.filter((item) => item.scope === scope));
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
    setActions((current) =>
      current.some((item) => item.scope === scopeRef.current && item.error.error.id === error.error.id)
        ? current
        : [...current, { scope: scopeRef.current, error }],
    );
  }, []);
  const clearActionError = useCallback((commandId: string) => {
    setActions((current) => current.filter((item) => item.error.commandId !== commandId));
  }, []);
  const dismissActionError = useCallback((errorId: string) => {
    setActions((current) => current.filter((item) => item.error.error.id !== errorId));
  }, []);
  const clearRecoveredConnectionError = useCallback(() => {
    setConnection((current) =>
      current?.scope === scopeRef.current &&
      (current.error?.type === "SYNC_RELAY.CONNECTION_LOST" || current.error?.type === "SYNC_RELAY.KEEPALIVE_TIMEOUT")
        ? null
        : current,
    );
  }, []);
  return {
    classifiedError: connection?.scope === scope ? connection.error : null,
    actionErrors: actions.filter((item) => item.scope === scope).map((item) => item.error),
    setClassifiedError,
    showActionError,
    clearActionError,
    dismissActionError,
    clearRecoveredConnectionError,
  };
}
