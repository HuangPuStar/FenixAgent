import type { ChatDoc, SessionDoc } from "../types";
import type { YjsBroadcaster } from "./broadcaster";
import type { WsConnection } from "./connection-types";

const YJS_SYNC_TIMEOUT_MS = 500;

export interface PendingInitialSync {
  expected: Set<string>;
  received: Set<string>;
  resolve: () => void;
}

export async function synchronizeInitialDocs(
  pendingSyncs: Map<string, PendingInitialSync>,
  broadcaster: YjsBroadcaster,
  ws: WsConnection,
  wsId: string,
  rcsSessionId: string,
  chatDoc: ChatDoc,
  sessionDoc: SessionDoc,
): Promise<void> {
  const docNames = [`chat:${rcsSessionId}`, `session:${rcsSessionId}`];
  let syncTimedOut = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      syncTimedOut = true;
      pendingSyncs.delete(wsId);
      resolve();
    }, YJS_SYNC_TIMEOUT_MS);
    pendingSyncs.set(wsId, {
      expected: new Set(docNames),
      received: new Set(),
      resolve: () => {
        clearTimeout(timer);
        pendingSyncs.delete(wsId);
        resolve();
      },
    });
    broadcaster.sendToYjsWs(ws, {
      type: "yjs:sync-request",
      docs: docNames.map((docName) => ({ docName, generation: chatDoc.generation })),
    });
  });
  if (!syncTimedOut) return;
  broadcaster.sendSnapshot(ws, chatDoc.ydoc, docNames[0], chatDoc.generation);
  broadcaster.sendSnapshot(ws, sessionDoc.ydoc, docNames[1], sessionDoc.generation);
}
