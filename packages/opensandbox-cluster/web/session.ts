const sessionKey = "opensandbox-cluster-session";
const day = 86400000;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Browser credentials have a fixed expiry measured from successful login. */
export interface Session {
  key: string;
  expiresAt: number;
}
/** Forget credentials on logout, expiry or authentication rejection. */
export function clearSession(storage: StoragePort) {
  try {
    storage.removeItem(sessionKey);
  } catch {
    /* Browsers may disable local storage. */
  }
}
/** Restore only a well-formed credential whose original expiry has not passed. */
export function readSession(storage: StoragePort, now = Date.now()): Session | undefined {
  try {
    const value = JSON.parse(storage.getItem(sessionKey) ?? "null");
    if (
      typeof value?.key === "string" &&
      value.key &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt > now &&
      value.expiresAt <= now + day
    )
      return value;
  } catch {
    /* Missing or malformed storage requires a fresh login. */
  }
  clearSession(storage);
  return;
}
/** Persist a verified key; denied storage still permits the current page session. */
export function saveSession(storage: StoragePort, key: string, now = Date.now()): Session {
  const session = { key, expiresAt: now + day };
  try {
    storage.setItem(sessionKey, JSON.stringify(session));
  } catch {
    /* Login remains usable without persistence. */
  }
  return session;
}
