import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { DocManager } from "../state/doc-manager";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createBoundDocs, createClient, createRelayEvents, createSharedRelay } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";

describe("RelayEventHandler instance-level reclaim (SP-C2)", () => {
  // 回收关闭该实例名下全部会话的 Chat/Session Doc 与广播订阅，未绑定会话不受影响；
  // 登记删除后重复回收 no-op（幂等）。
  test("reclaimInstanceRealtimeResources closes docs and listeners for every bound session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const docManager = new DocManager();
    const chatA = (await docManager.openChat("rcs-a")).ydoc;
    const sessionA = (await docManager.openSession("user-1", "agent-1", "rcs-a")).ydoc;
    const chatB = (await docManager.openChat("rcs-b")).ydoc;
    await docManager.openSession("user-1", "agent-1", "rcs-b");
    // 未绑定到该实例的会话（其他实例名下）不得被误伤
    await docManager.openChat("rcs-other");
    const unregistered: string[] = [];
    const origUnregister = broadcaster.unregisterYjsDocListener.bind(broadcaster);
    broadcaster.unregisterYjsDocListener = (docName: string) => {
      unregistered.push(docName);
      origUnregister(docName);
    };
    broadcaster.registerYjsDocListener(chatA, "chat:rcs-a");
    broadcaster.registerYjsDocListener(sessionA, "session:rcs-a");
    broadcaster.registerYjsDocListener(chatB, "chat:rcs-b");

    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    handler.bindInstanceSession("instance-1", "rcs-a");
    handler.bindInstanceSession("instance-1", "rcs-b");
    expect(docManager.openedDocCount()).toEqual({ chat: 3, session: 2 });

    await handler.reclaimInstanceRealtimeResources("instance-1");

    expect(docManager.getChatYdoc("rcs-a")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-a")).toBeUndefined();
    expect(docManager.getChatYdoc("rcs-b")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-b")).toBeUndefined();
    expect(docManager.getChatYdoc("rcs-other")).toBeDefined();
    expect(unregistered).toContain("chat:rcs-a");
    expect(unregistered).toContain("session:rcs-a");
    expect(unregistered).toContain("chat:rcs-b");
    expect(unregistered).toContain("session:rcs-b");
    // 观测计数随回收下降（openedDocCount 是长期采集信号）
    expect(docManager.openedDocCount()).toEqual({ chat: 1, session: 0 });

    // 幂等：登记已随回收删除，重复调用 no-op，不影响其他实例的会话
    await handler.reclaimInstanceRealtimeResources("instance-1");
    expect(docManager.getChatYdoc("rcs-other")).toBeDefined();
  });

  // 未登记的实例（从未建立过 relay 或已被回收）调用回收必须安全 no-op
  test("reclaiming an unregistered instance is a no-op", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });

    await handler.reclaimInstanceRealtimeResources("instance-unknown");

    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeDefined();
  });

  // 后继实例接管竞态（回归，SP-C2）：旧实例停止窗口内（controller 已移出活跃表、
  // facade.stopInstance 尚在途）客户端重连 spawn 新实例并重绑同一 rcsSessionId。
  // bindInstanceSession 必须剥夺旧实例归属，旧实例停止完成后的回收随之跳过该会话
  // ——否则回收销毁新实例正在写入的实时 Doc，processNormalizedEvent 静默丢事件，
  // 前端连接保持打开但冻结（无错误帧、无 turn 收敛）。
  test("reclaim of a stopped instance skips sessions taken over by a successor instance", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const docManager = new DocManager();
    await docManager.openChat("rcs-1");
    await docManager.openSession("user-1", "agent-1", "rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });

    handler.bindInstanceSession("instance-old", "rcs-1");
    // 停止窗口内客户端重连：新实例重绑同一会话（Doc 按 rcsSessionId 复用内存实例）
    handler.bindInstanceSession("instance-new", "rcs-1");

    // 旧实例停止完成（stopInstanceViaController 末尾的 reclaimYjsDocs）
    await handler.reclaimInstanceRealtimeResources("instance-old");

    // 新实例的实时 Doc 存活，事件继续投影（实时流未被静默丢弃）
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeDefined();
    expect(docManager.openedDocCount()).toEqual({ chat: 1, session: 1 });
    docManager.processNormalizedEvent("rcs-1", {
      type: "session_updated",
      update: { sessionId: "ses-new", status: "ready" },
      content: null,
    });
    const session = docManager.getSessionYdoc("rcs-1")!.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("sessionId")).toBe("ses-new");

    // 归属最终移除：新实例停止后回收才关闭 Doc
    await handler.reclaimInstanceRealtimeResources("instance-new");
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeUndefined();
    expect(docManager.openedDocCount()).toEqual({ chat: 0, session: 0 });
  });

  // 旧实例的迟到 relay_closed 不得销毁后继实例已接管的实时 Doc：客户端已被
  // 1011 关闭并自动重连到后继实例，Doc 保留即可无缝续流（同一竞态窗口的断链侧）。
  test("relay_closed of a previous instance does not destroy a successor-owned doc", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const docManager = new DocManager();
    await docManager.openChat("rcs-1");
    await docManager.openSession("user-1", "agent-1", "rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
    });
    handler.bindInstanceSession("instance-old", "rcs-1");
    handler.bindInstanceSession("instance-new", "rcs-1");
    registry.addClient("ws-1", createClient());

    // 旧实例 relay 断链（后继实例已接管该会话）
    await handler.createMessageHandler(createSharedRelay({ instanceId: "instance-old", rcsSessionId: "rcs-1" }))({
      type: "relay_closed",
    } as unknown as RelayMessage);

    // 后继实例的实时 Doc 存活
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeDefined();
    expect(docManager.openedDocCount()).toEqual({ chat: 1, session: 1 });
  });
});
