import type { SessionEvent } from "../types";
import { getUuid } from "./helpers";

let currentEventSource: EventSource | null = null;

export function connectSSE(sessionId: string, onEvent: (event: SessionEvent) => void, fromSeqNum = 0): void {
  disconnectSSE();

  const uuid = getUuid();
  const activeOrgId = localStorage.getItem("active_org_id");
  const params = new URLSearchParams({ uuid: uuid });
  if (activeOrgId) params.set("activeOrganizationId", activeOrgId);
  const url = `/web/sessions/${sessionId}/events?${params}`;
  const es = new EventSource(url);
  currentEventSource = es;

  let lastSeenSeq = fromSeqNum;

  es.addEventListener("message", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as SessionEvent;
      if (data.seqNum !== undefined && data.seqNum <= lastSeenSeq) return;
      if (data.seqNum !== undefined) lastSeenSeq = data.seqNum;
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  });

  es.addEventListener("error", () => {
    // EventSource auto-reconnects
  });
}

export function disconnectSSE(): void {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}
