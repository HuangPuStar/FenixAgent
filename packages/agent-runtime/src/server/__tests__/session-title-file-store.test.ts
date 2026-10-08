import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DocManager,
  getSessionInfo,
  getSessionsMap,
  SessionChannel,
  type SessionConnection,
} from "@fenix/chat-channel/server";
import { createFileSessionTitleStore } from "../repositories/session-title-store";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "fenix-session-title-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Fenix 会话标题文件持久化", () => {
  // 无 Redis 的真实 Chat 控制面重命名后，新 DocManager 必须从文件读取而非继承内存状态。
  test("无 Redis 的控制面重建后保留标题且不向 ACP 伪造重命名", async () => {
    const root = await createRoot();
    const rcsSessionId = "rcs-user-a-instance-a";
    const original = new DocManager({ sessionTitleStore: createFileSessionTitleStore(() => root) });
    await original.openChat(rcsSessionId);
    await original.openSession("user-a", "agent-a", rcsSessionId);
    const session = original.getSessionYdoc(rcsSessionId);
    if (!session) throw new Error("Missing test session projection");
    getSessionInfo(session).set("sessionId", "ses-a");
    const sent: Record<string, unknown>[] = [];
    const connection: SessionConnection = {
      userId: "user-a",
      agentId: "agent-a",
      instanceId: "instance-a",
      rcsSessionId,
      acpSessionId: "ses-a",
      agentStatusReceived: true,
      sessionLoaded: true,
      workspacePath: root,
      sendToRelay(message) {
        sent.push(message);
      },
      getNextRpcId: () => 1,
    };
    const channel = new SessionChannel({
      docManager: original,
      replaceProjection() {},
      syncSessionId() {},
      reportError() {},
    });
    const statuses: string[] = [];
    const errors: unknown[] = [];
    await channel.handleAction(
      connection,
      { action: "rename_session", commandId: "rename-file-backed", sessionId: "ses-a", title: "持久标题" },
      {
        sendAck: (ack) => {
          statuses.push(ack.status);
        },
        sendError: (error) => {
          errors.push(error);
        },
      },
    );
    expect(statuses).toEqual(["accepted", "committed"]);
    expect(errors).toEqual([]);
    expect(sent).toEqual([]);
    channel.disposeRcsSession(rcsSessionId);
    await original.closeAll();

    const restored = new DocManager({ sessionTitleStore: createFileSessionTitleStore(() => root) });
    await restored.openChat(rcsSessionId);
    await restored.openSession("user-a", "agent-a", rcsSessionId);
    restored.processNormalizedEvent(rcsSessionId, {
      type: "session_list",
      update: { sessions: [{ sessionId: "ses-a", title: "Agent 原标题" }] },
      content: null,
    });
    const restoredSession = restored.getSessionYdoc(rcsSessionId);
    if (!restoredSession) throw new Error("Missing restored test session projection");
    expect(getSessionsMap(restoredSession).get("ses-a")?.get("title")).toBe("持久标题");
    await restored.closeAll();
  });

  // 新建仓库实例必须读回标题，且不同用户或实例的相同 ACP ID 不能互相覆盖。
  test("重启后读回并隔离 RCS 会话", async () => {
    const root = await createRoot();
    const original = createFileSessionTitleStore(() => root);
    await original.write("rcs-user-a-instance-a", "ses-1", "保存的标题");
    await original.write("rcs-user-b-instance-a", "ses-1", "其他用户标题");
    const restored = createFileSessionTitleStore(() => root);
    expect(await restored.read("rcs-user-a-instance-a")).toEqual({ "ses-1": "保存的标题" });
    expect(await restored.read("rcs-user-b-instance-a")).toEqual({ "ses-1": "其他用户标题" });
    expect(await restored.read("rcs-user-a-instance-b")).toEqual({});
  });

  // 并发更新分别写入独立记录，任意会话的更新不得丢失同组其他会话标题。
  test("跨仓库并发写入保持所有会话标题", async () => {
    const root = await createRoot();
    const first = createFileSessionTitleStore(() => root);
    const second = createFileSessionTitleStore(() => root);
    await Promise.all([first.write("rcs-1", "ses-a", "会话 A"), second.write("rcs-1", "ses-b", "会话 B")]);
    expect(await first.read("rcs-1")).toEqual({ "ses-a": "会话 A", "ses-b": "会话 B" });
    await first.write("rcs-1", "ses-a", "新标题");
    expect(await second.read("rcs-1")).toEqual({ "ses-a": "新标题", "ses-b": "会话 B" });
  });

  // 标识作为内容和散列处理，即使包含路径分隔符也不能逃离平台专属目录。
  test("不将会话标识用于文件路径并限制访问权限", async () => {
    const root = await createRoot();
    const store = createFileSessionTitleStore(() => root);
    await store.write("../../foreign", "../outside", "路径不能逃逸");
    expect(await readdir(root)).toEqual([".fenix-session-titles"]);
    const metadataRoot = join(root, ".fenix-session-titles");
    const [group] = await readdir(metadataRoot);
    const directory = join(metadataRoot, group);
    const [record] = await readdir(directory);
    expect(record).toMatch(/^[a-f0-9]{64}\.json$/);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, record))).mode & 0o777).toBe(0o600);
    }
    expect(await store.read("../../foreign")).toEqual({ "../outside": "路径不能逃逸" });
  });

  // 删除不存在记录可以重试，删除一个会话不能删除另一会话或另一用户的数据。
  test("幂等删除只清理目标会话", async () => {
    const root = await createRoot();
    const store = createFileSessionTitleStore(() => root);
    await store.write("rcs-1", "ses-a", "A");
    await store.write("rcs-1", "ses-b", "B");
    await store.delete("rcs-1", "ses-a");
    await store.delete("rcs-1", "ses-a");
    await store.delete("rcs-missing", "ses-a");
    expect(await store.read("rcs-1")).toEqual({ "ses-b": "B" });
  });

  // 未完成写入的临时文件不进入回读结果，非法已提交记录必须明确报错。
  test("忽略临时记录并拒绝损坏的已提交数据", async () => {
    const root = await createRoot();
    const store = createFileSessionTitleStore(() => root);
    await store.write("rcs-1", "ses-a", "已提交");
    const metadataRoot = join(root, ".fenix-session-titles");
    const [group] = await readdir(metadataRoot);
    const directory = join(metadataRoot, group);
    const [record] = await readdir(directory);
    await writeFile(join(directory, ".tmp-interrupted"), "invalid json");
    expect(await store.read("rcs-1")).toEqual({ "ses-a": "已提交" });
    await writeFile(join(directory, record), JSON.stringify({ sessionId: "ses-b", title: "错配" }));
    await expect(store.read("rcs-1")).rejects.toThrow("Invalid session title record identifier");
  });

  // 无效标题及持久目录不可写时不能制造成功，也不能覆盖原有标题。
  test("验证失败及文件系统错误保持明确失败", async () => {
    const root = await createRoot();
    const store = createFileSessionTitleStore(() => root);
    await store.write("rcs-1", "ses-a", "原值");
    await expect(store.write("rcs-1", "ses-a", " ")).rejects.toBeDefined();
    expect(await store.read("rcs-1")).toEqual({ "ses-a": "原值" });
    const blockedRoot = join(root, "regular-file");
    await writeFile(blockedRoot, "not a directory");
    await expect(createFileSessionTitleStore(() => blockedRoot).write("rcs-1", "ses-a", "新值")).rejects.toBeDefined();
  });
});
