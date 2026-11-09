import type { YjsWsOptions } from "@fenix/chat-channel";
import { useCallback, useState } from "react";
import type * as Y from "yjs";
import { createSessionDocBinding, getDocHubGenerations, getDocHubReplacementVersion } from "../yjs/doc-hub";
import { createLegacyBaselineProof, type LegacyBaselineProof } from "./chat-error-presentation";

type SyncComplete = Parameters<NonNullable<YjsWsOptions["onSyncComplete"]>>[0];

/** 在已有完成通知上记录展示证明；连接重建须显式撤销，换代通过 scope 自然失效。 */
export function useLegacyFallbackPresentation() {
  const [proof, setProof] = useState<LegacyBaselineProof | null>(null);
  const resetBaseline = useCallback(() => setProof(null), []);
  const recordBaseline = useCallback((key: string, organizationId: string | null, info: SyncComplete) => {
    const binding = createSessionDocBinding(key);
    try {
      const session = binding.ydoc.getMap("root").get("session") as Y.Map<unknown> | undefined;
      const sessionId = session?.get("sessionId");
      const next = createLegacyBaselineProof({
        scope: JSON.stringify([organizationId, key, getDocHubReplacementVersion(key)]),
        sessionId: typeof sessionId === "string" ? sessionId : "",
        rcsSessionId: key,
        docs: info.docs,
        generation: info.generation,
        generations: getDocHubGenerations(key),
      });
      if (next) setProof(next);
      return next;
    } finally {
      binding.cleanup();
    }
  }, []);
  return { proof, resetBaseline, recordBaseline };
}
