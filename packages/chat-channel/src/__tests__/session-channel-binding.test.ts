import { describe, expect, test } from "bun:test";
import { getSessionInfo } from "../state/chat-writer";
import { committed, createHarness, submit } from "./session-channel-round27-test-helpers";

describe("SessionChannel 内存协议与状态边界", () => {
  // commandId 的去重仅在 dispose 前生效。
  test("dispose 后新 commandId 仍能正常提交", async () => {
    const harness = await createHarness();
    harness.channel.disposeRcsSession("rcs-1");
    await submit(harness, { action: "list_sessions", commandId: "new-after-dispose" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.errors).toEqual([]);
  });

  // null workspace 是合法绑定，不能由浏览器的 cwd 覆盖。
  test("空 workspace 不接受浏览器 cwd", async () => {
    const harness = await createHarness({ workspacePath: null });
    await submit(harness, { action: "list_sessions", commandId: "null-workspace", cwd: "/browser" });
    expect(harness.sent[0]).toMatchObject({ method: "session/list", params: { cwd: null } });
  });

  // 命令完成 ack 必须携带当前投影版本，供客户端进行乐观并发校验。
  test("committed ack 携带投影版本", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "ack-version" });
    expect(committed(harness)?.committedProjectionVersion).toBeTypeOf("number");
  });

  // load_session 注册回调必须只收到该会话同步请求的 RPC id。
  test("create_session 登记会话同步 RPC id", async () => {
    const ids: Array<number | string> = [];
    const harness = await createHarness({ registerSessionSyncRpcId: (id) => ids.push(id) });
    await submit(harness, { action: "create_session", commandId: "create-register" });
    expect(ids).toEqual([1]);
  });

  // 已完成命令的 duplicate ack 应保留原始投影版本。
  test("duplicate ack 复用已提交结果", async () => {
    const harness = await createHarness();
    const action = { action: "list_sessions", commandId: "duplicate-result" };
    await submit(harness, action);
    const original = committed(harness);
    await submit(harness, action);
    expect(harness.acks.at(-1)).toEqual({ ...original, status: "duplicate" });
  });

  // 空字符串 sessionId 同样属于非法 load 输入。
  test("load_session 空 sessionId 返回 INVALID_STATE", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "load-empty", sessionId: "" });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.INVALID_STATE" } }]);
  });

  // 非数值 expectedProjectionVersion 不应进入并发校验。
  test("非数值投影版本被忽略", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "version-string", expectedProjectionVersion: "0" });
    expect(harness.errors).toEqual([]);
    expect(harness.sent).toHaveLength(1);
  });

  // cancel 的请求 id 必须随连接计数器单调递增。
  test("连续 cancel 使用递增 RPC id", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "cancel", commandId: "cancel-one" });
    await submit(harness, { action: "cancel", commandId: "cancel-two" });
    expect(harness.sent.map((message) => message.id)).toEqual([1, 2]);
  });

  // resume_session 切换 ACP 会话时同样必须换代，不能把目标会话历史写进旧投影。
  test("resume_session 切换会话时替换投影", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "resume_session", commandId: "resume-replace", sessionId: "ses-2" });
    expect(harness.replacements).toHaveLength(1);
    expect(harness.synced).toEqual(["ses-2"]);
  });

  // 取消前没有活动 turn 时依旧只发送取消协议请求。
  test("无活动 turn 的 cancel 不创建投影状态", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "cancel", commandId: "cancel-no-turn" });
    expect(getSessionInfo(harness.manager.getSessionYdoc("rcs-1")!).get("activeTurnId")).toBeUndefined();
    expect(harness.sent).toHaveLength(1);
  });

  // create_session 不应擅自修改旧连接的 acpSessionId。
  test("create_session 保留旧会话绑定直到响应到达", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "create_session", commandId: "create-keep-binding" });
    expect(harness.connection.acpSessionId).toBe("ses-1");
  });

  // 多段文本 content 应合并为同一个用户消息 turn。
  test("多段文本 prompt 合并为一个 turn", async () => {
    const harness = await createHarness();
    await submit(harness, {
      action: "send_prompt",
      commandId: "multi-text",
      content: [
        { type: "text", text: "第一段" },
        { type: "image", data: "ignored" },
        { type: "text", text: "第二段" },
      ],
    });
    expect(committed(harness)?.turnId).toBeDefined();
    expect(harness.sent).toHaveLength(1);
  });

  // reload 后重复同一绑定会话仍不得产生额外 relay 调用。
  test("切换后同会话 load 保持静默", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "load-first", sessionId: "ses-2" });
    await submit(harness, { action: "load_session", commandId: "load-second", sessionId: "ses-2" });
    expect(harness.sent).toHaveLength(1);
  });

  // relay 发送错误不得泄露其内部错误文本给客户端。
  test("relay 错误响应不泄露内部信息", async () => {
    const harness = await createHarness({ sendToRelay: () => Promise.reject(new Error("credential=secret")) });
    await submit(harness, { action: "list_sessions", commandId: "sanitized-error" });
    expect(harness.errors[0]?.error).toMatchObject({
      type: "ACTION.AGENT_UNAVAILABLE",
      message: "The Agent is unavailable for the action.",
    });
    expect(JSON.stringify(harness.errors[0])).not.toContain("credential=secret");
    expect(JSON.stringify(harness.errors)).not.toContain("credential=secret");
  });

  // dispose 仅清理指定 RCS session，其他会话的命令仍可执行。
  test("dispose 隔离其他 RCS session", async () => {
    const harness = await createHarness();
    harness.channel.disposeRcsSession("rcs-other");
    await submit(harness, { action: "list_sessions", commandId: "other-dispose" });
    expect(harness.sent).toHaveLength(1);
  });
});
