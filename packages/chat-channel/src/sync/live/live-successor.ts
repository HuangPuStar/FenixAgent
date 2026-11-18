import { SyncProtocolError } from "../protocol/errors";
import { parseDocId, type SyncScope, scopeKey } from "../protocol/identity";
import type { ProjectionStore, WriterLease } from "../store/types";
import type { SealingMachine } from "./sealing";

/** 只沿已登记谱系恢复，交接发布成功后才交付 active 写入点。 */
export async function recoverLiveSuccessors(input: {
  readonly store: ProjectionStore;
  readonly scope: SyncScope;
  readonly lease: WriterLease;
  readonly sealing: SealingMachine;
  readonly startDocId: string;
  readonly admission?: AdmissionController;
  readonly onSuccessor: (previous: string, next: string) => Promise<void>;
}): Promise<string> {
  const key = scopeKey(input.scope);
  const identity = parseDocId(input.startDocId);
  const seen = new Set<string>();
  const held: Reservation[] = [];
  let docId = input.startDocId;
  try {
    for (;;) {
      if (seen.has(docId))
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "successor route contains a cycle" });
      if (input.admission) held.push(input.admission.reserve("controlIndex", 128 + docId.length * 2));
      seen.add(docId);
      const state = await input.store.readSuccessor(key, docId);
      if (!state)
        throw new SyncProtocolError("DOC_NOT_FOUND", { message: "successor lineage document is unavailable" });
      if (
        state.scopeKey !== key ||
        state.docId !== docId ||
        state.kind !== identity.kind ||
        state.generation !== identity.generation
      )
        throw new SyncProtocolError("GENERATION_MISMATCH", {
          message: "successor lineage crosses its scope, kind or generation",
        });
      const route = state.route;
      if (!route) {
        if (state.state !== "active")
          throw new SyncProtocolError("RESOURCE_RETIRED", { message: "successor lineage has no writable tail" });
        return docId;
      }
      const next = parseDocId(route.successorDocId);
      if (next.kind !== identity.kind || next.generation !== identity.generation)
        throw new SyncProtocolError("GENERATION_MISMATCH", {
          message: "successor identity differs from its predecessor",
        });
      if (seen.has(route.successorDocId))
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "successor route contains a cycle" });
      const target = await input.store.readSuccessor(key, route.successorDocId);
      if (!target) throw new SyncProtocolError("DOC_NOT_FOUND", { message: "registered successor is unavailable" });
      if (
        target.scopeKey !== key ||
        target.docId !== route.successorDocId ||
        target.kind !== identity.kind ||
        target.generation !== identity.generation
      )
        throw new SyncProtocolError("GENERATION_MISMATCH", { message: "registered successor crosses its lineage" });
      if (state.state === "sealing") {
        if (target.state !== "active")
          throw new SyncProtocolError("MALFORMED_FRAME", {
            message: "unfinished predecessor has a non-active successor",
          });
        const base = await input.store.readDocStateAt(route.successorDocId, 0);
        if (!base)
          throw new SyncProtocolError("DOC_NOT_FOUND", { message: "registered successor has no initial state" });
        await input.sealing.seal({
          scope: input.scope,
          oldDocId: docId,
          lease: input.lease,
          finalUpdateSeq: route.expectedLastSeq,
          successorDocId: route.successorDocId,
          successorInitialState: base.snapshot,
        });
      } else if (state.state !== "sealed") {
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "registered predecessor is not sealed or sealing" });
      }
      await input.onSuccessor(docId, route.successorDocId);
      docId = route.successorDocId;
    }
  } finally {
    for (const reservation of held) reservation.release();
  }
}

import type { AdmissionController, Reservation } from "../capacity/admission";
