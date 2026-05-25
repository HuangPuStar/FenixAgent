import { beforeEach, describe, expect, test } from "bun:test";

// Mock config

import Elysia from "elysia";
import { resetAllRepos } from "../repositories";
import { getAllEventBuses, getEventBus, removeEventBus } from "../transport/event-bus";
import { createSSEStream, createSSEWriter } from "../transport/sse-writer";

/** Read up to N bytes from a Response stream, then cancel */
async function readPartialStream(res: Response, maxBytes = 4096): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
      // Cancel after we have some data (first keepalive + any initial events)
      if (totalBytes > 0) break;
    }
  } finally {
    reader.cancel();
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

function elysiaRequest(app: Elysia, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("SSE Writer", () => {
  describe("createSSEWriter", () => {
    test("creates SSEWriter with send and close methods", () => {
      const app = new Elysia();
      let capturedWriter: ReturnType<typeof createSSEWriter> | null = null;

      app.get("/test", ({ request }) => {
        capturedWriter = createSSEWriter(request);
        return "ok";
      });

      elysiaRequest(app, "/test");
      expect(capturedWriter).not.toBeNull();
      expect(typeof capturedWriter!.send).toBe("function");
      expect(typeof capturedWriter!.close).toBe("function");
    });
  });

  describe("createSSEStream", () => {
    beforeEach(() => {
      resetAllRepos();
      for (const [key] of getAllEventBuses()) {
        removeEventBus(key);
      }
    });

    test("returns Response with correct SSE headers", async () => {
      const app = new Elysia();

      app.get("/stream/:sessionId", ({ request, params }) => {
        return createSSEStream(request, params.sessionId, 0);
      });

      const res = await elysiaRequest(app, "/stream/s1");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(res.headers.get("Connection")).toBe("keep-alive");
      expect(res.headers.get("X-Accel-Buffering")).toBe("no");

      // Cancel the stream
      res.body?.cancel();
    });

    test("sends initial keepalive", async () => {
      const app = new Elysia();

      app.get("/stream/:sessionId", ({ request, params }) => {
        return createSSEStream(request, params.sessionId, 0);
      });

      const res = await elysiaRequest(app, "/stream/s2");
      const text = await readPartialStream(res);
      expect(text).toContain(": keepalive");
    });

    test("sends historical events when fromSeqNum > 0", async () => {
      // Pre-populate event bus with events
      const bus = getEventBus("s3");
      bus.publish({ id: "e1", sessionId: "s3", type: "user", payload: { content: "hello" }, direction: "outbound" });
      bus.publish({ id: "e2", sessionId: "s3", type: "assistant", payload: { content: "hi" }, direction: "inbound" });

      const app = new Elysia();

      app.get("/stream/:sessionId", ({ request, params, query }) => {
        const fromSeq = parseInt((query as any)?.fromSeq || "0", 10);
        return createSSEStream(request, params.sessionId, fromSeq);
      });

      const res = await elysiaRequest(app, "/stream/s3?fromSeq=1");
      const text = await readPartialStream(res);
      // Should replay events since seq 1 (i.e., event 2)
      expect(text).toContain('"seqNum":2');
      expect(text).toContain("assistant");
    });

    test("no historical events when fromSeqNum is 0", async () => {
      const bus = getEventBus("s5");
      bus.publish({ id: "e1", sessionId: "s5", type: "user", payload: {}, direction: "outbound" });

      const app = new Elysia();

      app.get("/stream/:sessionId", ({ request, params }) => {
        return createSSEStream(request, params.sessionId, 0);
      });

      const res = await elysiaRequest(app, "/stream/s5");
      const text = await readPartialStream(res);
      // With fromSeqNum=0, no historical replay, just keepalive
      expect(text).toContain(": keepalive");
      // Should NOT contain event data (only keepalive)
      expect(text).not.toContain("event: message");
    });

    test("subscribes to new events and delivers them", async () => {
      const app = new Elysia();

      app.get("/stream/:sessionId", ({ request, params }) => {
        return createSSEStream(request, params.sessionId, 0);
      });

      const res = await elysiaRequest(app, "/stream/s6");

      // Read initial keepalive first
      const reader = res.body!.getReader();
      const { value: firstChunk } = await reader.read();
      const initialText = new TextDecoder().decode(firstChunk!);
      expect(initialText).toContain(": keepalive");

      // Now publish an event
      const bus = getEventBus("s6");
      bus.publish({
        id: "e1",
        sessionId: "s6",
        type: "user",
        payload: { content: "real-time" },
        direction: "outbound",
      });

      // Read the event
      const { value: secondChunk } = await reader.read();
      const eventText = new TextDecoder().decode(secondChunk!);
      expect(eventText).toContain("event: message");
      expect(eventText).toContain("real-time");

      reader.cancel();
    });
  });
});
