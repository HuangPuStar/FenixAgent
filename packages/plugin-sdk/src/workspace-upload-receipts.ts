import type { WorkspaceUploadOptions } from "./secure-workspace-upload";

const RECEIPT_TTL_MS = 10 * 60_000;
const MAX_RECEIPTS = 1024;
const receipts = new Map<string, { fingerprint: string; expiresAt: number; result: { version: string } }>();
const locks = new Map<string, Promise<void>>();

/** Serialize in-process saves and bound retry receipts by target and operation identity. */
export async function runWorkspaceUpload(
  target: string,
  options: WorkspaceUploadOptions,
  version: string,
  save: () => Promise<{ version: string }>,
): Promise<{ version: string }> {
  const previous = locks.get(target) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(target, current);
  await previous;
  try {
    const now = Date.now();
    for (const [key, receipt] of receipts) if (receipt.expiresAt <= now) receipts.delete(key);
    const key = options.opId ? JSON.stringify([target, options.opId]) : undefined;
    const fingerprint = JSON.stringify([version, options.overwrite ?? false, options.expectedVersion]);
    const receipt = key ? receipts.get(key) : undefined;
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw Object.assign(new Error("Operation ID was already used for different upload parameters"), {
          code: "OPERATION_CONFLICT",
        });
      return { ...receipt.result };
    }
    const result = await save();
    if (key) {
      while (receipts.size >= MAX_RECEIPTS) receipts.delete(receipts.keys().next().value!);
      receipts.set(key, { fingerprint, result: { ...result }, expiresAt: now + RECEIPT_TTL_MS });
    }
    return result;
  } finally {
    release();
    if (locks.get(target) === current) locks.delete(target);
  }
}
