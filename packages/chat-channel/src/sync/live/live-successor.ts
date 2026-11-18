import type { AdmissionController } from "../capacity/admission";
import { SyncProtocolError } from "../protocol/errors";
import { parseDocId, type SyncScope, scopeKey } from "../protocol/identity";
import type { ProjectionStore, SyncSuccessorState, WriterLease } from "../store/types";
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

  /** 谱系读边界在预检与交接阶段使用同一套身份和生命周期校验。 */
  async function readState(docId: string): Promise<SyncSuccessorState> {
    const state = await input.store.readSuccessor(key, docId);
    if (!state) throw new SyncProtocolError("DOC_NOT_FOUND", { message: "successor lineage document is unavailable" });
    if (
      state.scopeKey !== key ||
      state.docId !== docId ||
      state.kind !== identity.kind ||
      state.generation !== identity.generation
    )
      throw new SyncProtocolError("GENERATION_MISMATCH", {
        message: "successor lineage crosses its scope, kind or generation",
      });
    if (!state.route) {
      if (state.state !== "active")
        throw new SyncProtocolError("RESOURCE_RETIRED", { message: "successor lineage has no writable tail" });
    } else {
      const next = parseDocId(state.route.successorDocId);
      if (next.kind !== identity.kind || next.generation !== identity.generation)
        throw new SyncProtocolError("GENERATION_MISMATCH", {
          message: "successor identity differs from its predecessor",
        });
      if (state.state !== "sealed" && state.state !== "sealing")
        throw new SyncProtocolError("MALFORMED_FRAME", {
          message: "registered predecessor is not sealed or sealing",
        });
    }
    return state;
  }

  /** 一次访问独占一份额度，读取、封口或交接失败均在离开该访问时归还。 */
  async function visit<T>(docId: string, action: (state: SyncSuccessorState) => Promise<T>): Promise<T> {
    const reservation = input.admission?.reserve("controlIndex", 128 + docId.length * 2);
    try {
      return await action(await readState(docId));
    } finally {
      reservation?.release();
    }
  }

  /** Brent 预检只保留固定游标；先排除整条链的损坏，再执行任何交接副作用。 */
  async function inspect(): Promise<{ tailDocId: string; hops: number }> {
    let docId = input.startDocId;
    let checkpoint = docId;
    let power = 1;
    let distance = 0;
    let hops = 0;
    let previousWasSealing = false;
    for (;;) {
      const next = await visit(docId, async (state) => {
        if (previousWasSealing && state.state !== "active")
          throw new SyncProtocolError("MALFORMED_FRAME", {
            message: "unfinished predecessor has a non-active successor",
          });
        return state.route ? { docId: state.route.successorDocId, sealing: state.state === "sealing" } : null;
      });
      if (!next) return { tailDocId: docId, hops };
      hops++;
      distance++;
      if (next.docId === checkpoint)
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "successor route contains a cycle" });
      if (distance === power) {
        checkpoint = next.docId;
        power *= 2;
        distance = 0;
      }
      previousWasSealing = next.sealing;
      docId = next.docId;
    }
  }

  const checked = await inspect();
  let docId = input.startDocId;
  for (let index = 0; ; index++) {
    const nextDocId = await visit(docId, async (state) => {
      const route = state.route;
      // 已登记路由在单写租约内不可改写；尾部意外延伸时拒绝本次恢复，不追随未预检的链。
      if (index === checked.hops) {
        if (docId !== checked.tailDocId || route)
          throw new SyncProtocolError("MALFORMED_FRAME", { message: "successor lineage changed during recovery" });
        return null;
      }
      if (!route)
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "successor lineage changed during recovery" });
      const target = await readState(route.successorDocId);
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
      }
      await input.onSuccessor(docId, route.successorDocId);
      return route.successorDocId;
    });
    if (nextDocId === null) return docId;
    docId = nextDocId;
  }
}
