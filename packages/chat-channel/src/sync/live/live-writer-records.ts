// packages/chat-channel/src/sync/live/live-writer-records.ts
// 实时写者的语义实体/终态描述符构造（从 live-writer.ts 拆出，纯函数）。

import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import type { BarrierKind } from "./live-writer-types";
import type { FinalEntityDescriptor, RuntimeEntityRecord } from "./runtime-doc";
import { requireObject, requireString } from "./writer-support";

const ENTITY_KINDS: ReadonlySet<string> = new Set(["tool", "permission", "error", "cancel"]);

function malformed(message: string): never {
  const code: SyncErrorCode = "MALFORMED_FRAME";
  throw new SyncProtocolError(code, { message });
}

function isEntityKind(value: unknown): value is FinalEntityDescriptor["kind"] {
  return typeof value === "string" && ENTITY_KINDS.has(value);
}

export function entityOf(kind: BarrierKind, payload: Record<string, unknown>): RuntimeEntityRecord {
  if (kind === "final" || !ENTITY_KINDS.has(kind)) malformed(`semantic kind ${kind} is not a runtime entity`);
  const toolCallId = payload.toolCallId;
  if (toolCallId !== undefined && typeof toolCallId !== "string") malformed("invalid toolCallId");
  const metadata = payload.metadata === undefined ? {} : requireObject(payload.metadata, "semantic metadata");
  const entity = { entityId: requireString(payload, "entityId"), kind, metadata, state: "open" as const };
  return toolCallId === undefined ? entity : { ...entity, toolCallId };
}

export function descriptorOf(payload: Record<string, unknown>, entityId: string): FinalEntityDescriptor {
  const { kind, contentRef, digest, byteLength, completedAt } = requireObject(payload.finalDescriptor, "descriptor");
  if (!isEntityKind(kind) || typeof contentRef !== "string" || typeof digest !== "string") malformed("bad descriptor");
  const size = typeof byteLength === "number" ? byteLength : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 0 || typeof completedAt !== "number") malformed("bad descriptor");
  if (!Number.isFinite(completedAt)) malformed("bad descriptor");
  return { entityId, kind, contentRef, digest, byteLength: size, completedAt };
}
