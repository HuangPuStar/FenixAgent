import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  applyDocHubUpdate,
  createChatDocBinding,
  createSessionDocBinding,
  getDocHubReplacementVersion,
  getDocHubStateVectors,
  replaceDocHubUpdate,
  setDocHubGeneration,
  subscribeDocHubReplacement,
} from "../yjs/doc-hub";

function updateWithMarker(marker: string): Uint8Array {
  return updateWithRootValue("marker", marker);
}

function updateWithRootValue(key: string, value: string): Uint8Array {
  const source = new Y.Doc();
  source.getMap("root").set(key, value);
  return Y.encodeStateAsUpdate(source);
}

function markersFromVectors(vectors: Array<{ stateVector: Uint8Array }>): number[] {
  return vectors.map((vector) => Y.decodeStateVector(vector.stateVector).size);
}

describe("DocHub 文档替换纯逻辑", () => {
  // 未登记会话的替换版本应从零开始，便于调用方安全比较版本变化。
  test("未替换会话的版本为零", () => {
    expect(getDocHubReplacementVersion("replacement-version-missing")).toBe(0);
  });

  // 未登记会话没有 Y.Doc，因此不能返回可用于同步的状态向量。
  test("未登记会话返回空状态向量", () => {
    expect(getDocHubStateVectors("replacement-vectors-missing")).toEqual([]);
  });

  // 对未绑定会话设置 generation 应静默忽略，不能隐式创建文档副本。
  test("未绑定会话设置 generation 不创建状态向量", () => {
    setDocHubGeneration("generation-missing", "chat:generation-missing", "g1");
    expect(getDocHubStateVectors("generation-missing")).toEqual([]);
  });

  // 同一会话的 chat 与 session 绑定必须分别持有不同类型的共享文档。
  test("chat 与 session 绑定使用不同文档", () => {
    const chat = createChatDocBinding("separate-doc-types");
    const session = createSessionDocBinding("separate-doc-types");
    expect(chat.ydoc).not.toBe(session.ydoc);
    chat.cleanup();
    session.cleanup();
  });

  // 同一会话的 session 多次绑定应复用同一个 session 文档。
  test("重复 session 绑定复用文档", () => {
    const first = createSessionDocBinding("shared-session-doc");
    const second = createSessionDocBinding("shared-session-doc");
    expect(first.ydoc).toBe(second.ydoc);
    first.cleanup();
    second.cleanup();
  });

  // 订阅但尚未创建绑定时，取消订阅不应留下可见状态。
  test("空会话订阅可安全取消", () => {
    const unsubscribe = subscribeDocHubReplacement("listener-without-entry", () => {});
    unsubscribe();
    expect(getDocHubReplacementVersion("listener-without-entry")).toBe(0);
  });

  // 监听器存在时，即使所有绑定释放，旧文档也必须保留到监听器取消。
  test("监听器延后文档销毁", () => {
    const binding = createChatDocBinding("listener-retains-doc");
    const unsubscribe = subscribeDocHubReplacement("listener-retains-doc", () => {});
    binding.cleanup();
    expect(binding.ydoc.isDestroyed).toBe(false);
    unsubscribe();
    expect(binding.ydoc.isDestroyed).toBe(true);
  });

  // 单独收到 chat 快照不能替换半套投影，避免 chat/session generation 不一致。
  test("仅 chat 快照不会提交替换", () => {
    const chat = createChatDocBinding("chat-stage-only");
    replaceDocHubUpdate("chat-stage-only", "chat:chat-stage-only", "g1", updateWithMarker("chat"));
    expect(chat.ydoc.getMap("root").get("marker")).toBeUndefined();
    expect(getDocHubReplacementVersion("chat-stage-only")).toBe(0);
    chat.cleanup();
  });

  // 单独收到 session 快照同样必须保持在暂存区，不能部分覆盖现有投影。
  test("仅 session 快照不会提交替换", () => {
    const session = createSessionDocBinding("session-stage-only");
    replaceDocHubUpdate("session-stage-only", "session:session-stage-only", "g1", updateWithMarker("session"));
    expect(session.ydoc.getMap("root").get("marker")).toBeUndefined();
    expect(getDocHubReplacementVersion("session-stage-only")).toBe(0);
    session.cleanup();
  });

  // 同 generation 的 chat 与 session 快照齐备后，应原子替换两份文档。
  test("成对快照提交替换并保留内容", () => {
    const chat = createChatDocBinding("paired-replacement");
    const session = createSessionDocBinding("paired-replacement");
    replaceDocHubUpdate("paired-replacement", "chat:paired-replacement", "g1", updateWithMarker("chat-g1"));
    replaceDocHubUpdate("paired-replacement", "session:paired-replacement", "g1", updateWithMarker("session-g1"));
    const nextChat = createChatDocBinding("paired-replacement");
    const nextSession = createSessionDocBinding("paired-replacement");
    expect(nextChat.ydoc.getMap("root").get("marker")).toBe("chat-g1");
    expect(nextSession.ydoc.getMap("root").get("marker")).toBe("session-g1");
    chat.cleanup();
    session.cleanup();
    nextChat.cleanup();
    nextSession.cleanup();
  });

  // 成功提交一次完整替换后，版本号必须恰好递增一次。
  test("完整替换递增版本", () => {
    const chat = createChatDocBinding("replacement-version-increment");
    const session = createSessionDocBinding("replacement-version-increment");
    replaceDocHubUpdate(
      "replacement-version-increment",
      "chat:replacement-version-increment",
      "g1",
      updateWithMarker("chat"),
    );
    replaceDocHubUpdate(
      "replacement-version-increment",
      "session:replacement-version-increment",
      "g1",
      updateWithMarker("session"),
    );
    expect(getDocHubReplacementVersion("replacement-version-increment")).toBe(1);
    chat.cleanup();
    session.cleanup();
  });

  // 每一轮完整替换都应产生新的版本，供 store 触发重新绑定。
  test("连续完整替换连续递增版本", () => {
    const chat = createChatDocBinding("replacement-version-twice");
    const session = createSessionDocBinding("replacement-version-twice");
    replaceDocHubUpdate(
      "replacement-version-twice",
      "chat:replacement-version-twice",
      "g1",
      updateWithMarker("chat-1"),
    );
    replaceDocHubUpdate(
      "replacement-version-twice",
      "session:replacement-version-twice",
      "g1",
      updateWithMarker("session-1"),
    );
    replaceDocHubUpdate(
      "replacement-version-twice",
      "chat:replacement-version-twice",
      "g2",
      updateWithMarker("chat-2"),
    );
    replaceDocHubUpdate(
      "replacement-version-twice",
      "session:replacement-version-twice",
      "g2",
      updateWithMarker("session-2"),
    );
    expect(getDocHubReplacementVersion("replacement-version-twice")).toBe(2);
    chat.cleanup();
    session.cleanup();
  });

  // 替换完成必须通知已订阅方一次，使其重新取得新文档绑定。
  test("完整替换通知订阅方", () => {
    const chat = createChatDocBinding("replacement-notifies");
    const session = createSessionDocBinding("replacement-notifies");
    let notifications = 0;
    const unsubscribe = subscribeDocHubReplacement("replacement-notifies", () => {
      notifications++;
    });
    replaceDocHubUpdate("replacement-notifies", "chat:replacement-notifies", "g1", updateWithMarker("chat"));
    replaceDocHubUpdate("replacement-notifies", "session:replacement-notifies", "g1", updateWithMarker("session"));
    expect(notifications).toBe(1);
    unsubscribe();
    chat.cleanup();
    session.cleanup();
  });

  // 已取消的订阅者不应接收之后替换产生的通知。
  test("取消订阅后不再通知", () => {
    const chat = createChatDocBinding("replacement-unsubscribed");
    const session = createSessionDocBinding("replacement-unsubscribed");
    let notifications = 0;
    const unsubscribe = subscribeDocHubReplacement("replacement-unsubscribed", () => {
      notifications++;
    });
    unsubscribe();
    replaceDocHubUpdate("replacement-unsubscribed", "chat:replacement-unsubscribed", "g1", updateWithMarker("chat"));
    replaceDocHubUpdate(
      "replacement-unsubscribed",
      "session:replacement-unsubscribed",
      "g1",
      updateWithMarker("session"),
    );
    expect(notifications).toBe(0);
    chat.cleanup();
    session.cleanup();
  });

  // 替换旧文档后，旧绑定持有的文档必须销毁，防止副本继续接收或占用资源。
  test("完整替换销毁旧文档", () => {
    const chat = createChatDocBinding("replacement-destroys-old");
    const session = createSessionDocBinding("replacement-destroys-old");
    replaceDocHubUpdate("replacement-destroys-old", "chat:replacement-destroys-old", "g1", updateWithMarker("chat"));
    replaceDocHubUpdate(
      "replacement-destroys-old",
      "session:replacement-destroys-old",
      "g1",
      updateWithMarker("session"),
    );
    expect(chat.ydoc.isDestroyed).toBe(true);
    expect(session.ydoc.isDestroyed).toBe(true);
    createChatDocBinding("replacement-destroys-old").cleanup();
    createSessionDocBinding("replacement-destroys-old").cleanup();
  });

  // 替换后新建绑定必须获取新文档而不是已经销毁的旧文档。
  test("替换后绑定获取新文档", () => {
    const chat = createChatDocBinding("replacement-new-binding");
    const session = createSessionDocBinding("replacement-new-binding");
    replaceDocHubUpdate("replacement-new-binding", "chat:replacement-new-binding", "g1", updateWithMarker("chat"));
    replaceDocHubUpdate(
      "replacement-new-binding",
      "session:replacement-new-binding",
      "g1",
      updateWithMarker("session"),
    );
    const replacement = createChatDocBinding("replacement-new-binding");
    expect(replacement.ydoc).not.toBe(chat.ydoc);
    expect(replacement.ydoc.isDestroyed).toBe(false);
    chat.cleanup();
    session.cleanup();
    replacement.cleanup();
  });

  // 未知 docName 不能提交替换、增加版本或覆盖现有文档。
  test("未知 docName 忽略替换", () => {
    const chat = createChatDocBinding("replacement-unknown-name");
    replaceDocHubUpdate(
      "replacement-unknown-name",
      "other:replacement-unknown-name",
      "g1",
      updateWithMarker("ignored"),
    );
    expect(chat.ydoc.getMap("root").get("marker")).toBeUndefined();
    expect(getDocHubReplacementVersion("replacement-unknown-name")).toBe(0);
    chat.cleanup();
  });

  // 同一 generation 内后到的 chat 快照应覆盖早到的暂存 chat 快照。
  test("同 generation 的最新 chat 快照获胜", () => {
    const chat = createChatDocBinding("replacement-latest-chat");
    const session = createSessionDocBinding("replacement-latest-chat");
    replaceDocHubUpdate("replacement-latest-chat", "chat:replacement-latest-chat", "g1", updateWithMarker("old-chat"));
    replaceDocHubUpdate("replacement-latest-chat", "chat:replacement-latest-chat", "g1", updateWithMarker("new-chat"));
    replaceDocHubUpdate(
      "replacement-latest-chat",
      "session:replacement-latest-chat",
      "g1",
      updateWithMarker("session"),
    );
    const replacement = createChatDocBinding("replacement-latest-chat");
    expect(replacement.ydoc.getMap("root").get("marker")).toBe("new-chat");
    chat.cleanup();
    session.cleanup();
    replacement.cleanup();
  });

  // generation 改变时，旧 generation 的半套暂存数据必须丢弃。
  test("新 generation 丢弃旧暂存数据", () => {
    const chat = createChatDocBinding("replacement-new-generation");
    const session = createSessionDocBinding("replacement-new-generation");
    replaceDocHubUpdate(
      "replacement-new-generation",
      "chat:replacement-new-generation",
      "g1",
      updateWithMarker("old-chat"),
    );
    replaceDocHubUpdate(
      "replacement-new-generation",
      "chat:replacement-new-generation",
      "g2",
      updateWithMarker("new-chat"),
    );
    replaceDocHubUpdate(
      "replacement-new-generation",
      "session:replacement-new-generation",
      "g2",
      updateWithMarker("new-session"),
    );
    const nextChat = createChatDocBinding("replacement-new-generation");
    const nextSession = createSessionDocBinding("replacement-new-generation");
    expect(nextChat.ydoc.getMap("root").get("marker")).toBe("new-chat");
    expect(nextSession.ydoc.getMap("root").get("marker")).toBe("new-session");
    chat.cleanup();
    session.cleanup();
    nextChat.cleanup();
    nextSession.cleanup();
  });

  // session 快照先到时，后续 chat 快照也应完成同一代替换。
  test("session 快照可先于 chat 快照到达", () => {
    const chat = createChatDocBinding("replacement-session-first");
    const session = createSessionDocBinding("replacement-session-first");
    replaceDocHubUpdate(
      "replacement-session-first",
      "session:replacement-session-first",
      "g1",
      updateWithMarker("session"),
    );
    replaceDocHubUpdate("replacement-session-first", "chat:replacement-session-first", "g1", updateWithMarker("chat"));
    const nextSession = createSessionDocBinding("replacement-session-first");
    expect(nextSession.ydoc.getMap("root").get("marker")).toBe("session");
    chat.cleanup();
    session.cleanup();
    nextSession.cleanup();
  });

  // chat generation 设置后只应生成 chat 的同步向量，不得伪造 session generation。
  test("仅设置 chat generation 返回一个向量", () => {
    const chat = createChatDocBinding("vectors-chat-only");
    setDocHubGeneration("vectors-chat-only", "chat:vectors-chat-only", "g-chat");
    const vectors = getDocHubStateVectors("vectors-chat-only");
    expect(vectors.map((vector) => [vector.docName, vector.generation])).toEqual([
      ["chat:vectors-chat-only", "g-chat"],
    ]);
    expect(markersFromVectors(vectors)).toEqual([0]);
    chat.cleanup();
  });

  // session generation 设置后只应生成 session 的同步向量。
  test("仅设置 session generation 返回一个向量", () => {
    const session = createSessionDocBinding("vectors-session-only");
    setDocHubGeneration("vectors-session-only", "session:vectors-session-only", "g-session");
    const vectors = getDocHubStateVectors("vectors-session-only");
    expect(vectors.map((vector) => [vector.docName, vector.generation])).toEqual([
      ["session:vectors-session-only", "g-session"],
    ]);
    expect(markersFromVectors(vectors)).toEqual([0]);
    session.cleanup();
  });

  // 两种 generation 均设置时，状态向量的输出顺序必须稳定为 chat 后 session。
  test("双 generation 状态向量按 chat session 排序", () => {
    const chat = createChatDocBinding("vectors-both");
    const session = createSessionDocBinding("vectors-both");
    setDocHubGeneration("vectors-both", "session:vectors-both", "g-session");
    setDocHubGeneration("vectors-both", "chat:vectors-both", "g-chat");
    expect(getDocHubStateVectors("vectors-both").map((vector) => vector.docName)).toEqual([
      "chat:vectors-both",
      "session:vectors-both",
    ]);
    chat.cleanup();
    session.cleanup();
  });

  // 重复设置同一文档的 generation 时，应以最新值覆盖旧值。
  test("重复设置 generation 使用最新值", () => {
    const chat = createChatDocBinding("vectors-generation-overwrite");
    setDocHubGeneration("vectors-generation-overwrite", "chat:vectors-generation-overwrite", "g1");
    setDocHubGeneration("vectors-generation-overwrite", "chat:vectors-generation-overwrite", "g2");
    expect(getDocHubStateVectors("vectors-generation-overwrite")[0]?.generation).toBe("g2");
    chat.cleanup();
  });

  // 未知前缀不能意外写入任何 generation。
  test("未知 generation 前缀被忽略", () => {
    const chat = createChatDocBinding("vectors-unknown-prefix");
    setDocHubGeneration("vectors-unknown-prefix", "other:vectors-unknown-prefix", "ignored");
    expect(getDocHubStateVectors("vectors-unknown-prefix")).toEqual([]);
    chat.cleanup();
  });

  // 完整替换应自动携带本轮 generation，供重连差量同步直接使用。
  test("完整替换写入两种 generation", () => {
    const chat = createChatDocBinding("replacement-generations");
    const session = createSessionDocBinding("replacement-generations");
    replaceDocHubUpdate("replacement-generations", "chat:replacement-generations", "g9", updateWithMarker("chat"));
    replaceDocHubUpdate(
      "replacement-generations",
      "session:replacement-generations",
      "g9",
      updateWithMarker("session"),
    );
    expect(getDocHubStateVectors("replacement-generations").map((vector) => vector.generation)).toEqual(["g9", "g9"]);
    chat.cleanup();
    session.cleanup();
  });

  // 替换后的 state vector 应包含快照内容对应的 Yjs 客户端状态。
  test("替换后的状态向量反映文档内容", () => {
    const chat = createChatDocBinding("replacement-vector-content");
    const session = createSessionDocBinding("replacement-vector-content");
    replaceDocHubUpdate(
      "replacement-vector-content",
      "chat:replacement-vector-content",
      "g1",
      updateWithMarker("chat"),
    );
    replaceDocHubUpdate(
      "replacement-vector-content",
      "session:replacement-vector-content",
      "g1",
      updateWithMarker("session"),
    );
    expect(markersFromVectors(getDocHubStateVectors("replacement-vector-content"))).toEqual([1, 1]);
    chat.cleanup();
    session.cleanup();
  });

  // 调用方修改返回数组不能污染 hub 内部后续查询结果。
  test("状态向量返回独立数组", () => {
    const chat = createChatDocBinding("vectors-independent-array");
    setDocHubGeneration("vectors-independent-array", "chat:vectors-independent-array", "g1");
    const first = getDocHubStateVectors("vectors-independent-array");
    first.pop();
    expect(getDocHubStateVectors("vectors-independent-array")).toHaveLength(1);
    chat.cleanup();
  });

  // 替换一个会话不得影响另一个会话的文档内容或版本号。
  test("不同会话的替换相互隔离", () => {
    const chatA = createChatDocBinding("replacement-isolated-a");
    const sessionA = createSessionDocBinding("replacement-isolated-a");
    const chatB = createChatDocBinding("replacement-isolated-b");
    const sessionB = createSessionDocBinding("replacement-isolated-b");
    replaceDocHubUpdate("replacement-isolated-a", "chat:replacement-isolated-a", "g1", updateWithMarker("chat-a"));
    replaceDocHubUpdate(
      "replacement-isolated-a",
      "session:replacement-isolated-a",
      "g1",
      updateWithMarker("session-a"),
    );
    const nextA = createChatDocBinding("replacement-isolated-a");
    expect(nextA.ydoc.getMap("root").get("marker")).toBe("chat-a");
    expect(chatB.ydoc.getMap("root").get("marker")).toBeUndefined();
    expect(getDocHubReplacementVersion("replacement-isolated-b")).toBe(0);
    chatA.cleanup();
    sessionA.cleanup();
    chatB.cleanup();
    sessionB.cleanup();
    nextA.cleanup();
  });

  // 替换后的 chat 文档继续接收不冲突字段的增量更新。
  test("替换后的 chat 文档继续接收增量", () => {
    const chat = createChatDocBinding("replacement-then-update");
    const session = createSessionDocBinding("replacement-then-update");
    replaceDocHubUpdate("replacement-then-update", "chat:replacement-then-update", "g1", updateWithMarker("snapshot"));
    replaceDocHubUpdate(
      "replacement-then-update",
      "session:replacement-then-update",
      "g1",
      updateWithMarker("session"),
    );
    const nextChat = createChatDocBinding("replacement-then-update");
    applyDocHubUpdate(
      "replacement-then-update",
      "chat:replacement-then-update",
      updateWithRootValue("incremental", "value"),
    );
    expect(nextChat.ydoc.getMap("root").get("marker")).toBe("snapshot");
    expect(nextChat.ydoc.getMap("root").get("incremental")).toBe("value");
    chat.cleanup();
    session.cleanup();
    nextChat.cleanup();
  });
});
