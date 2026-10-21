import { describe, expect, test } from "bun:test";
import { createHarness, submit } from "./session-channel-round27-test-helpers";

const content = [{ type: "text", text: "属于旧会话的草稿" }];

describe("浏览器 prompt 会话前置条件", () => {
  // 外层队列可在切换后才把命令交给通道；收到时的 generation 不能替代浏览器原目标。
  test("切换完成后才进入通道的旧目标 prompt 不产生消息或工具副作用", async () => {
    const h = await createHarness();
    await submit(h, { action: "load_session", commandId: "load-b", sessionId: "ses-b" });
    const chatBefore = h.manager.getChatYdoc("rcs-1")?.toJSON();
    const sessionBefore = h.manager.getSessionYdoc("rcs-1")?.toJSON();
    const relayBefore = h.sent.length;
    await submit(h, { action: "send_prompt", commandId: "old-target", sessionId: "ses-1", content });
    expect(h.errors.at(-1)?.error.type).toBe("ACTION.VERSION_CONFLICT");
    expect(h.manager.getChatYdoc("rcs-1")?.toJSON()).toEqual(chatBefore);
    expect(h.manager.getSessionYdoc("rcs-1")?.toJSON()).toEqual(sessionBefore);
    expect(h.sent).toHaveLength(relayBefore);
    await submit(h, { action: "send_prompt", commandId: "confirmed-b", sessionId: "ses-b", content });
    expect(h.acks.at(-1)?.status).toBe("committed");
    expect(h.sent.at(-1)).toMatchObject({ method: "session/prompt", params: { sessionId: "ses-b", content } });
  });

  // 缺失目标不能隐式采用当前绑定，避免旧协议或畸形输入绕过会话归属校验。
  test.each([undefined, "", "ses-other"])("缺失或不同目标 %s 在 Doc 写入前拒绝", async (sessionId) => {
    const h = await createHarness();
    const before = h.manager.getChatYdoc("rcs-1")?.toJSON();
    await h.channel.handleAction(
      h.connection,
      { action: "send_prompt", commandId: "invalid", sessionId, content },
      {
        sendAck: (ack) => h.acks.push(ack),
        sendError: (error) => h.errors.push(error),
      },
    );
    expect(h.errors[0]?.error.type).toBe("ACTION.VERSION_CONFLICT");
    expect(h.sent).toEqual([]);
    expect(h.manager.getChatYdoc("rcs-1")?.toJSON()).toEqual(before);
  });
});
