// packages/chat-channel/src/channel/legacy-generation-sync.test.ts
// 跨进程会话换代的 legacy 连接收敛：节点 A 直接推进 Redis active generation 后，
// 节点 B 的 legacy 连接必须被重载并收到 replace 帧；轮询窗口内的用户消息不得落进旧代次。
//
// 两个 DocManager 共享同一份假 Redis（真实现 provider / CAS），因此能观察跨进程事实；
// 断言落在最终 Doc 内容与连接收到的帧上，不依赖内部调用计数。

import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { ProdRedis, SNAPSHOT_CONFIG } from "../__tests__/helpers/doc-manager-fixtures";
import { decodeYjsSyncFrame, encodeYjsStateVectorFrame } from "../protocol/update-frame";
import { getEntriesMap, getEntryOrder } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { readEntryText } from "../state/doc-manager-projection";
import { createWs, type MockWs } from "./connection-test-helpers";
import { ChatChannelController } from "./controller";

const RCS = "rcs-cross-process";
const WS_ID = "ws-b";
const LOCATOR = { instanceUid: "instance-b", rcsSessionId: RCS };

function createManager(redis: ProdRedis): DocManager {
  const manager = new DocManager({ getRedis: () => redis as never, onError: () => {}, onLog: () => {} });
  manager.setSnapshotPersistConfigSource(() => SNAPSHOT_CONFIG);
  return manager;
}

/** 真实控制器装配：只替换宿主能力；同步协议关闭，使连接保持 legacy 路径。 */
function createController(docManager: DocManager): ChatChannelController {
  return new ChatChannelController({
    docManager,
    getEnvironment: async () => ({ userId: "user-1", organizationId: "org-1" }),
    authorizeEnvironment: () => true,
    resolveWorkspacePath: () => "/workspace",
    ensureRunning: async () => LOCATOR.instanceUid,
    connectAgentRelay: async () => ({ state: "open", send() {}, close() {} }),
    refreshInstanceEnvironment: async () => {},
    markRelayAttached() {},
    markRelayDetached() {},
    touchInstanceActivity() {},
    terminateLocalDeadInstance() {},
    isMachineOffline: () => false,
    classifyPermanentSpawnFailure: () => null,
    maxClients: () => 8,
    chatSyncProtocol: { enabled: false, sealGraceMs: 2_000, retireGraceMs: 30_000 },
    snapshotPersist: () => SNAPSHOT_CONFIG,
    log() {},
    reportError() {},
  });
}

/** 客户端语义的 legacy 视图：自动回应 state-vector 握手，其余帧只记录。 */
function createLegacyClient(controller: ChatChannelController): MockWs {
  const ws = createWs();
  const rawSend = ws.send.bind(ws);
  ws.send = (data: string | Uint8Array) => {
    rawSend(data);
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as { type?: string; docs?: Array<{ docName: string; generation: string }> };
    if (message.type !== "yjs:sync-request") return;
    for (const doc of message.docs ?? []) {
      void controller.gateway.handleMessage(
        ws,
        WS_ID,
        encodeYjsStateVectorFrame(doc.docName, doc.generation, new Uint8Array()),
      );
    }
  };
  return ws;
}

/** 时间线上用户可见文本（换代断言不依赖内部条目 id）。 */
function userTexts(ydoc: Y.Doc): string[] {
  const entries = getEntriesMap(ydoc);
  const texts: string[] = [];
  for (const entryId of getEntryOrder(ydoc).toArray()) {
    const entry = entries.get(entryId);
    if (entry?.get("role") === "user") texts.push(readEntryText(entry));
  }
  return texts;
}

function replaceFrames(ws: MockWs): Array<{ docName: string; generation: string }> {
  const frames: Array<{ docName: string; generation: string }> = [];
  for (const message of ws.messages) {
    if (!(message instanceof Uint8Array)) continue;
    const frame = decodeYjsSyncFrame(message);
    if (frame?.type === "replace") frames.push({ docName: frame.docName, generation: frame.generation });
  }
  return frames;
}

/** 等待异步写入/广播排空（用户消息代次复核跨多个微任务）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("跨进程 legacy 投影换代", () => {
  // A 换代后 B 的 legacy 连接必须收敛到新代次：收到成对 replace 帧、不关闭动作 socket，后续写入落新 Doc。
  test("节点 A 换代后节点 B 的 legacy 连接重载投影并收到 replace 帧", async () => {
    const redis = new ProdRedis();
    const managerB = createManager(redis);
    const controllerB = createController(managerB);
    controllerB.legacyGenerationWatcher.stop();
    const ws = createLegacyClient(controllerB);
    await controllerB.gateway.handleOpen(ws, WS_ID, "user-1", "agent-1", LOCATOR);
    const oldChat = managerB.getChat(RCS);
    expect(oldChat).toBeDefined();

    // 节点 A 独立打开同一代次后整体换代：Redis active generation 推进，B 的内存 Doc 不知情。
    const managerA = createManager(redis);
    await managerA.openChat(RCS);
    await managerA.openSession("user-1", "agent-1", RCS);
    const replaced = await managerA.replaceProjection(RCS, "ses-B");

    await controllerB.legacyGenerationWatcher.checkNow();

    const currentChat = managerB.getChat(RCS);
    expect(currentChat).not.toBe(oldChat);
    expect(currentChat?.generation).toBe(replaced.generation);
    expect(managerB.getSession(RCS)?.generation).toBe(replaced.generation);
    expect(oldChat?.ydoc.isDestroyed).toBe(true);
    expect(ws.closed).toEqual([]);
    expect(
      replaceFrames(ws)
        .map((frame) => `${frame.docName}:${frame.generation}`)
        .sort(),
    ).toEqual([`chat:${RCS}:${replaced.generation}`, `session:${RCS}:${replaced.generation}`].sort());

    // 换代后的 legacy 写入只能出现在新代次，旧 Doc 不再接收数据。
    managerB.registerUserMessage(RCS, "after-reload");
    await settle();
    expect(userTexts(currentChat!.ydoc)).toContain("after-reload");
    expect(userTexts(oldChat!.ydoc)).not.toContain("after-reload");

    controllerB.gateway.handleClose(WS_ID);
    await managerB.closeAll();
    await managerA.closeAll();
  });

  // 2 秒 watcher 窗口内到达的用户消息必须先复核 Redis：既不写旧代次，也不能在重载后补进新会话。
  test("轮询窗口内的用户消息不写旧代次，重载后也不补写", async () => {
    const redis = new ProdRedis();
    const managerB = createManager(redis);
    const controllerB = createController(managerB);
    controllerB.legacyGenerationWatcher.stop();
    const ws = createLegacyClient(controllerB);
    await controllerB.gateway.handleOpen(ws, WS_ID, "user-1", "agent-1", LOCATOR);
    const oldChat = managerB.getChat(RCS);
    expect(oldChat).toBeDefined();

    const managerA = createManager(redis);
    await managerA.openChat(RCS);
    await managerA.openSession("user-1", "agent-1", RCS);
    const replaced = await managerA.replaceProjection(RCS, "ses-B");

    // 不触发 watcher：模拟 2 秒轮询窗口内用户先发出消息。
    managerB.registerUserMessage(RCS, "window-write");
    await settle();

    expect(managerB.getChat(RCS)?.generation).toBe(oldChat!.generation);
    expect(userTexts(oldChat!.ydoc)).not.toContain("window-write");

    await controllerB.legacyGenerationWatcher.checkNow();
    const currentChat = managerB.getChat(RCS);
    expect(currentChat?.generation).toBe(replaced.generation);
    // 消息属于旧 ACP 会话，重载后不得被补写进新会话。
    expect(userTexts(currentChat!.ydoc)).not.toContain("window-write");

    controllerB.gateway.handleClose(WS_ID);
    await managerB.closeAll();
    await managerA.closeAll();
  });
});
