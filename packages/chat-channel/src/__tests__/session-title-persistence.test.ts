import { describe, expect, test } from "bun:test";
import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";
import { getSessionInfo, getSessionsMap } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { SessionTitleState, type SessionTitleStore } from "../state/session-title-store";

function createStore(): SessionTitleStore & { failWrites: boolean } {
  const rows = new Map<string, Map<string, string>>();
  return {
    failWrites: false,
    async read(rcsSessionId) {
      return Object.fromEntries(rows.get(rcsSessionId) ?? []);
    },
    async write(rcsSessionId, sessionId, title) {
      if (this.failWrites) throw new Error("storage unavailable");
      let titles = rows.get(rcsSessionId);
      if (!titles) {
        titles = new Map();
        rows.set(rcsSessionId, titles);
      }
      titles.set(sessionId, title);
    },
    async delete(rcsSessionId, sessionId) {
      rows.get(rcsSessionId)?.delete(sessionId);
    },
  };
}

async function open(store: SessionTitleStore, rcsSessionId: string) {
  const manager = new DocManager({ sessionTitleStore: store });
  await manager.openChat(rcsSessionId);
  await manager.openSession("user-1", "agent-1", rcsSessionId);
  return manager;
}

function list(manager: DocManager, rcsSessionId: string, title = "Agent title") {
  manager.processNormalizedEvent(rcsSessionId, {
    type: "session_list",
    update: { sessions: [{ sessionId: "ses-1", title }] },
    content: null,
  });
  return getSessionsMap(manager.getSessionYdoc(rcsSessionId)!).get("ses-1")?.get("title");
}

async function rename(manager: DocManager, rcsSessionId: string, title: string, sessionId = "ses-1") {
  const acks: ActionAck[] = [];
  const errors: ActionError[] = [];
  const channel = new SessionChannel({
    docManager: manager,
    replaceProjection() {},
    syncSessionId() {},
    reportError() {},
  });
  const sent: Record<string, unknown>[] = [];
  const connection: SessionConnection = {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: rcsSessionId,
    rcsSessionId,
    acpSessionId: "ses-1",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/trusted",
    sendToRelay(message) {
      sent.push(message);
    },
    getNextRpcId: () => 1,
  };
  await channel.handleAction(
    connection,
    { action: "rename_session", commandId: `rename-${title}`, sessionId, title },
    {
      sendAck: (ack) => {
        acks.push(ack);
      },
      sendError: (error) => {
        errors.push(error);
      },
    },
  );
  return { acks, errors, sent };
}

describe("Fenix 持久会话标题", () => {
  // 写入成功后必须刷新当前投影，Agent 后续列表仍显示 Fenix 标题。
  test("重命名不发送 ACP 方法且抵抗列表重新拉取", async () => {
    const store = createStore();
    const manager = await open(store, "rcs-user-1-instance-1");
    list(manager, "rcs-user-1-instance-1");
    getSessionInfo(manager.getSessionYdoc("rcs-user-1-instance-1")!).set("sessionId", "ses-1");
    const result = await rename(manager, "rcs-user-1-instance-1", "New title");
    expect(result.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
    expect(result.sent).toEqual([]);
    expect(list(manager, "rcs-user-1-instance-1")).toBe("New title");
    expect(getSessionInfo(manager.getSessionYdoc("rcs-user-1-instance-1")!).get("title")).toBe("New title");
    await manager.closeAll();
  });

  // 新进程从持久元数据回读，同一 ACP ID 在别的 RCS 会话仍显示自己的标题。
  test("重启回读且按 RCS 会话隔离", async () => {
    const store = createStore();
    const original = await open(store, "rcs-user-1-instance-1");
    list(original, "rcs-user-1-instance-1");
    await rename(original, "rcs-user-1-instance-1", "Saved title");
    await original.closeAll();

    const restored = await open(store, "rcs-user-1-instance-1");
    const other = await open(store, "rcs-user-2-instance-1");
    expect(list(restored, "rcs-user-1-instance-1")).toBe("Saved title");
    expect(list(other, "rcs-user-2-instance-1")).toBe("Agent title");
    await restored.closeAll();
    await other.closeAll();
  });

  // 同一 RCS 会话落在不同进程时，下一次 Agent 列表回读持久标题并收敛。
  test("跨进程列表重新拉取读取最新标题", async () => {
    const store = createStore();
    const first = await open(store, "rcs-user-1-instance-1");
    const second = await open(store, "rcs-user-1-instance-1");
    list(first, "rcs-user-1-instance-1");
    list(second, "rcs-user-1-instance-1");
    await rename(first, "rcs-user-1-instance-1", "Updated elsewhere");
    await second.refreshSessionTitles("rcs-user-1-instance-1");
    expect(list(second, "rcs-user-1-instance-1")).toBe("Updated elsewhere");
    await first.closeAll();
    await second.closeAll();
  });

  // Agent 过滤空标题当前会话时，服务端绑定仍允许重命名并让历史列表回显。
  test("当前会话被 Agent 列表过滤时仍可持久重命名", async () => {
    const store = createStore();
    const manager = await open(store, "rcs-user-1-instance-1");
    getSessionInfo(manager.getSessionYdoc("rcs-user-1-instance-1")!).set("sessionId", "ses-1");
    manager.processNormalizedEvent("rcs-user-1-instance-1", {
      type: "session_list",
      update: { sessions: [] },
      content: null,
    });
    const result = await rename(manager, "rcs-user-1-instance-1", "Recovered title");
    expect(result.acks.at(-1)?.status).toBe("committed");
    manager.processNormalizedEvent("rcs-user-1-instance-1", {
      type: "session_list",
      update: { sessions: [] },
      content: null,
    });
    expect(getSessionsMap(manager.getSessionYdoc("rcs-user-1-instance-1")!).get("ses-1")?.get("title")).toBe(
      "Recovered title",
    );
    manager.processNormalizedEvent("rcs-user-1-instance-1", {
      type: "session_updated",
      update: { sessionId: "ses-1", title: "Agent title" },
      content: null,
    });
    expect(getSessionInfo(manager.getSessionYdoc("rcs-user-1-instance-1")!).get("title")).toBe("Recovered title");
    await manager.closeAll();
  });

  // 持久写入失败或目标不在已确认列表时，只能返回错误，不能假成功。
  test("持久写入失败和未知会话均不提交", async () => {
    const store = createStore();
    const manager = await open(store, "rcs-user-1-instance-1");
    const unknown = await rename(manager, "rcs-user-1-instance-1", "Unknown", "ses-other");
    expect(unknown.errors.at(-1)?.error.type).toBe("ACTION.AGENT_UNAVAILABLE");
    list(manager, "rcs-user-1-instance-1");
    store.failWrites = true;
    const failed = await rename(manager, "rcs-user-1-instance-1", "Failed");
    expect(failed.errors.at(-1)?.error.type).toBe("ACTION.AGENT_UNAVAILABLE");
    expect(list(manager, "rcs-user-1-instance-1")).toBe("Agent title");
    await manager.closeAll();
  });

  // Agent 确认删除后立即清掉元数据，并拒绝列表刷新前对旧绑定再重命名。
  test("删除会话清理标题且阻止旧绑定重命名", async () => {
    const store = createStore();
    const manager = await open(store, "rcs-1");
    list(manager, "rcs-1");
    await rename(manager, "rcs-1", "Saved");
    await manager.removeSessionTitle("rcs-1", "ses-1");
    expect(await store.read("rcs-1")).toEqual({});
    const stale = await rename(manager, "rcs-1", "Stale");
    expect(stale.errors.at(-1)?.error.type).toBe("ACTION.AGENT_UNAVAILABLE");
    await manager.closeAll();
  });

  // 旧列表慢读不得在新列表之后回填旧标题，也不得更新可重命名目标集合。
  test("乱序列表回读只接受最新一次", async () => {
    let releaseOldRead: () => void = () => {};
    const oldRead = new Promise<void>((resolve) => {
      releaseOldRead = resolve;
    });
    let reads = 0;
    const state = new SessionTitleState({
      async read() {
        reads++;
        if (reads === 1) {
          await oldRead;
          return { "ses-1": "Old" };
        }
        return { "ses-1": "New" };
      },
      async write() {},
      async delete() {},
    });
    const first = state.refresh("rcs-1");
    expect(await state.refresh("rcs-1")).toBe(true);
    releaseOldRead();
    expect(await first).toBe(false);
    expect(state.get("rcs-1", "ses-1")).toBe("New");
  });

  // close 等待持久写入结束再销毁旧 Doc，新一代打开后读到已提交标题。
  test("关闭与重开等待在途重命名", async () => {
    const base = createStore();
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const store: SessionTitleStore = {
      read: (rcsSessionId) => base.read(rcsSessionId),
      write: async (rcsSessionId, sessionId, title) => {
        await writeGate;
        await base.write(rcsSessionId, sessionId, title);
      },
      delete: (rcsSessionId, sessionId) => base.delete(rcsSessionId, sessionId),
    };
    const manager = await open(store, "rcs-1");
    list(manager, "rcs-1");
    const pendingRename = rename(manager, "rcs-1", "Saved during close");
    await Bun.sleep(0);
    const closing = manager.closeSession("rcs-1");
    const reopening = manager.openSession("user-1", "agent-1", "rcs-1");
    releaseWrite();
    expect((await pendingRename).acks.at(-1)?.status).toBe("committed");
    await closing;
    await reopening;
    expect(list(manager, "rcs-1")).toBe("Saved during close");
    await manager.closeAll();
  });

  // 打开期间的慢读若跨越关闭边界，旧世代必须失败且不能覆盖后继 Doc。
  test("关闭拦截旧世代慢读并允许重开", async () => {
    const base = createStore();
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    const store: SessionTitleStore = {
      read: async (rcsSessionId) => {
        reads++;
        if (reads === 1) await readGate;
        return base.read(rcsSessionId);
      },
      write: (rcsSessionId, sessionId, title) => base.write(rcsSessionId, sessionId, title),
      delete: (rcsSessionId, sessionId) => base.delete(rcsSessionId, sessionId),
    };
    const manager = new DocManager({ sessionTitleStore: store });
    await manager.openChat("rcs-1");
    const staleOpen = manager.openSession("user-1", "agent-1", "rcs-1");
    await Bun.sleep(0);
    await manager.closeSession("rcs-1");
    releaseRead();
    await expect(staleOpen).rejects.toThrow("superseded");
    await manager.openSession("user-1", "agent-1", "rcs-1");
    expect(list(manager, "rcs-1")).toBe("Agent title");
    await manager.closeAll();
  });
});
