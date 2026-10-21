import { expect, test } from "bun:test";
import { decodeYjsSyncFrame, encodeYjsStateVectorFrame } from "@fenix/chat-channel";
import * as Y from "yjs";
import { createYjsRouteFixture, eventually } from "./acp-yjs-route-fixture";

// 真实 Elysia 回调会重建 WS 包装对象；同步回复和动作必须仍进入同一条连接的队列。
test("真实 WebSocket 能完成差量握手、加载会话并发送消息", async () => {
  const h = await createYjsRouteFixture(true);
  const frames: Array<Record<string, unknown>> = [];
  const histories = new Map<string, Y.Doc>();
  const errors: unknown[] = [];
  let socket: WebSocket | undefined;
  try {
    h.app.listen({ hostname: "127.0.0.1", port: 0 });
    const port = h.app.server?.port;
    if (!port) throw new Error("Missing live test server port");
    socket = new WebSocket(
      `ws://127.0.0.1:${port}/acp/yjs/env-route?instanceUid=instance-route&rcsSessionId=${h.rcsSessionId}&acpSessionId=ses-a`,
    );
    socket.binaryType = "arraybuffer";
    socket.onerror = (error) => errors.push(error);
    socket.onmessage = ({ data }) => {
      if (typeof data !== "string") {
        const frame = decodeYjsSyncFrame(new Uint8Array(data));
        if (frame?.type !== "update") return;
        let doc = histories.get(frame.docName);
        if (!doc) {
          doc = new Y.Doc();
          const cached = h.cached.get(frame.docName);
          if (cached) Y.applyUpdate(doc, Y.encodeStateAsUpdate(cached));
          histories.set(frame.docName, doc);
        }
        Y.applyUpdate(doc, frame.update);
        return;
      }
      const message = JSON.parse(data) as Record<string, unknown>;
      frames.push(message);
      if (message.type !== "yjs:sync-request") return;
      const docs = message.docs as Array<{ docName: string; generation: string }>;
      for (const { docName, generation } of docs) {
        const cached = h.cached.get(docName);
        if (cached) socket?.send(encodeYjsStateVectorFrame(docName, generation, Y.encodeStateVector(cached)));
      }
    };
    await eventually(() => frames.some((frame) => frame.type === "yjs:sync-complete"));
    expect(frames.some((frame) => frame.type === "yjs:history-incomplete")).toBe(false);
    expect(histories.get(`chat:${h.rcsSessionId}`)?.getText("history").toString()).toBe(
      h.chat.ydoc.getText("history").toString(),
    );
    const epoch = frames.find((frame) => frame.type === "yjs:command-epoch")?.epoch;
    const loadId = `${epoch}.${crypto.randomUUID()}`;
    socket.send(JSON.stringify({ action: "load_session", commandId: loadId, sessionId: "ses-a" }));
    await eventually(() => h.sent.some((rpc) => rpc.method === "session/load"));
    await h.respond(h.sent.find((rpc) => rpc.method === "session/load")?.id, { sessionId: "ses-a" });
    await eventually(() => frames.some((frame) => frame.commandId === loadId && frame.status === "committed"));
    const promptId = `${epoch}.${crypto.randomUUID()}`;
    socket.send(
      JSON.stringify({
        action: "send_prompt",
        commandId: promptId,
        sessionId: "ses-a",
        content: [{ type: "text", text: "live socket prompt" }],
      }),
    );
    await eventually(() => frames.some((frame) => frame.commandId === promptId && frame.status === "committed"));
    expect(h.sent.filter((rpc) => rpc.method === "session/prompt")).toHaveLength(1);
    expect(errors).toEqual([]);
    socket.close();
    await eventually(() => h.controller.registry.clientCount === 0);
  } finally {
    socket?.close();
    await h.app.stop(true);
    await h.dispose();
    for (const doc of histories.values()) doc.destroy();
  }
});

// 新投影依赖真实入站 HELLO 和订阅；包装对象变化不能让聊天区永远等不到目录基线。
test("真实同步 WebSocket 在 open 期间发送 HELLO 后可订阅目录", async () => {
  const h = await createYjsRouteFixture(false, true);
  const frames: Array<Record<string, unknown>> = [];
  let socket: WebSocket | undefined;
  try {
    h.app.listen({ hostname: "127.0.0.1", port: 0 });
    const port = h.app.server?.port;
    if (!port) throw new Error("Missing live test server port");
    socket = new WebSocket(
      `ws://127.0.0.1:${port}/acp/yjs/env-route?instanceUid=instance-route&rcsSessionId=${h.rcsSessionId}&chatSync=1`,
    );
    socket.binaryType = "arraybuffer";
    const send = (frame: Record<string, unknown>) => socket?.send(new TextEncoder().encode(JSON.stringify(frame)));
    socket.onopen = () =>
      send({
        type: "HELLO",
        protocolVersion: 1,
        scope: { organizationId: "org-route", rcsSessionId: h.rcsSessionId },
        loadedDocs: [],
        stateful: false,
      });
    socket.onmessage = ({ data }) => {
      if (typeof data === "string") return;
      frames.push(JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>);
    };
    await eventually(() => frames.some((frame) => frame.type === "MANIFEST"));
    const manifest = frames.find((frame) => frame.type === "MANIFEST");
    send({ type: "SUBSCRIBE", protocolVersion: 1, docIds: [manifest?.directoryDocId], priority: "live" });
    await eventually(() => frames.some((frame) => frame.type === "DOC_BASE"));
    expect(frames.find((frame) => frame.type === "DOC_BASE")).toMatchObject({ docId: manifest?.directoryDocId });
    expect(frames.some((frame) => frame.type === "ERROR")).toBe(false);
    socket.close();
    await eventually(() => h.controller.registry.clientCount === 0);
  } finally {
    socket?.close();
    await h.app.stop(true);
    await h.dispose();
  }
});
