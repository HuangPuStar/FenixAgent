import { afterEach, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { closeAllFileEventsClients, createWebFileEventsRoutes } from "../routes/web/file-events";
import { destroyEnvironmentQueue, publishFileEvent } from "../services/file-event-queue";
import { initializeMachineModuleConfig, stubFileWsTransport, stubMachineEnvironmentRecord } from "../testing";

const environmentId = "handshake-environment";
afterEach(() => {
  closeAllFileEventsClients();
  destroyEnvironmentQueue(environmentId);
  resetAllStubs();
});

// 真实客户端在 open 后立即订阅，首帧必须等待异步认证而不能静默丢失。
test("initial subscription waits for asynchronous WebSocket authentication", async () => {
  initializeMachineModuleConfig({ defaultMachineId: "handshake-machine" });
  stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "handshake-machine" }] }) }) }) });
  stubFileWsTransport({ isFileWsConnected: () => true });
  stubMachineEnvironmentRecord({ id: environmentId, organizationId: "org", userId: "user" });
  let authenticated = false;
  const app = createWebFileEventsRoutes({
    authenticateRequest: async () => {
      await Bun.sleep(30);
      authenticated = true;
      return { user: { id: "user" }, authContext: { organizationId: "org" } };
    },
  }).listen({ hostname: "127.0.0.1", port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server!.port}/file-events`);
  try {
    const event = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Initial subscription was lost")), 500);
      socket.onmessage = (message) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(message.data)));
      };
      socket.onerror = () => reject(new Error("WebSocket failed"));
    });
    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        expect(authenticated).toBe(false);
        socket.send(JSON.stringify({ type: "subscribe", environments: [environmentId] }));
        resolve();
      };
    });
    await Bun.sleep(100);
    publishFileEvent(environmentId, { type: "file_changed", path: "a.txt", kind: "write", source: "external" });
    expect(await event).toMatchObject({ environment_id: environmentId, path: "a.txt", type: "file_changed" });
  } finally {
    socket.close();
    await app.stop(true);
  }
});

// 认证未完成时断开的连接不能在迟到认证后占用客户端额度。
test("closing during authentication does not revive a connection", async () => {
  initializeMachineModuleConfig({ fileEventsMaxClients: 1 });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const app = createWebFileEventsRoutes({
    authenticateRequest: async () => {
      if (++calls === 1) await pending;
      return { user: { id: "user" }, authContext: { organizationId: "org" } };
    },
  }).listen({ hostname: "127.0.0.1", port: 0 });
  const address = `ws://127.0.0.1:${app.server!.port}/file-events`;
  const first = new WebSocket(address);
  let second: WebSocket | undefined;
  try {
    await new Promise<void>((resolve) => {
      first.onopen = () => {
        first.close();
      };
      first.onclose = () => resolve();
    });
    finish();
    await Bun.sleep(0);
    second = new WebSocket(address);
    await new Promise<void>((resolve) => {
      second!.onopen = () => resolve();
    });
    await Bun.sleep(30);
    expect(second.readyState).toBe(WebSocket.OPEN);
  } finally {
    finish();
    first.close();
    second?.close();
    await app.stop(true);
  }
});
