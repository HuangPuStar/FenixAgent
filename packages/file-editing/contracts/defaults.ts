/** Shared editing budgets; deployment only exposes the document URL and JWT secret. */
export const EDITING_DEFAULTS = Object.freeze({
  textMaxBytes: 2 * 1024 * 1024,
  maxBuffers: 50,
  maxBufferBytes: 32 * 1024 * 1024,
  maxFileBytes: 92 * 1024 * 1024,
  timeoutMs: 120_000,
  pollIntervalMs: 3_000,
  idleTtlMs: 2 * 60 * 60 * 1000,
  maxSessionAgeMs: 24 * 60 * 60 * 1000,
  closingGraceMs: 120_000,
  maxUserSessions: 10,
  maxSessions: 200,
  maxDownloads: 4,
  receiptTtlMs: 10 * 60 * 1000,
});
