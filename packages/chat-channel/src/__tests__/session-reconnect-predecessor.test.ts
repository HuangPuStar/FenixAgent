import { expect, test } from "bun:test";
import { createHarness, submit } from "./session-channel-round27-test-helpers";

// 新身份只能恢复新连接，不能越过尚未退场的旧 load/resume 执行器。
test.each(["load_session", "resume_session"])("%s 重连恢复等待旧执行器退场", async (action) => {
  let finish = (_value: boolean) => {};
  const oldReceipt = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const h = await createHarness({
    sessionLoaded: false,
    awaitSessionMutation: () => ({
      completed: h.sent.length === 0 ? oldReceipt : Promise.resolve(true),
      cancel: () => {},
    }),
  });
  const pending: Promise<void>[] = [];
  try {
    pending.push(submit(h, { action, commandId: "old-restore", sessionId: "ses-existing" }));
    for (let attempt = 0; attempt < 100 && h.sent.length === 0; attempt++) await Bun.sleep(1);
    expect(h.sent).toHaveLength(1);
    h.channel.disposeRcsSession("rcs-1");
    const next = { ...h.connection, sessionLoaded: false };
    pending.push(
      h.channel.handleAction(
        next,
        { action, commandId: "new-restore", sessionId: "ses-existing" },
        {
          sendAck: (ack) => {
            h.acks.push(ack);
          },
          sendError: (error) => {
            h.errors.push(error);
          },
        },
      ),
    );
    await Bun.sleep(1);
    expect(h.acks.at(-1)).toMatchObject({ commandId: "new-restore", status: "accepted" });
    expect(h.sent).toHaveLength(1);
    expect(next.sessionLoaded).toBe(false);
    finish(true);
    await Promise.all(pending);
    expect(next.sessionLoaded).toBe(true);
    expect(h.sent).toHaveLength(2);
    expect(h.acks.at(-1)).toMatchObject({ commandId: "new-restore", status: "committed" });
    expect(h.errors).toEqual([]);
    await h.channel.handleAction(
      next,
      { action, commandId: "old-restore", sessionId: "ses-existing" },
      {
        sendAck: (ack) => {
          h.acks.push(ack);
        },
        sendError: (error) => {
          h.errors.push(error);
        },
      },
    );
    expect(h.errors).toMatchObject([{ commandId: "old-restore", error: { type: "ACTION.OUTCOME_UNKNOWN" } }]);
    expect(h.sent).toHaveLength(2);
  } finally {
    finish(false);
    await Promise.all(pending);
    h.channel.disposeRcsSession("rcs-1");
    await h.manager.closeAll();
  }
});
