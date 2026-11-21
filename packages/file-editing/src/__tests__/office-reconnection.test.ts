import { expect, test } from "bun:test";
import { saveCallback, scope, setup, signed, urls } from "./editing-service-fixture";

async function notify(
  fixture: ReturnType<typeof setup>,
  session: Awaited<ReturnType<typeof fixture.service.open>>,
  status: number,
) {
  const target = urls(session);
  return fixture.service.callback(target.callback, await signed({ key: target.key, status }));
}

// 提供方短暂断线的 4→1 回调不能终止仍然打开的会话，恢复后必须可以保存。
test("an unchanged Office editor reconnects and remains saveable", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  expect(await notify(f, session, 4)).toEqual({ error: 0 });
  f.advance(90000);
  expect(await notify(f, session, 1)).toEqual({ error: 0 });
  const save = await f.service.save(scope, session.id, "after-reconnect");
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 0 });
  expect(f.content()).toBe("edited");
});

// 状态轮询不能把无人连接的 Office 会话无限续期。
test("polling cannot extend the bounded Office reconnection window", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  await notify(f, session, 4);
  const deadline = (await f.service.status(scope, session.id)).expiresAt;
  f.advance(90000);
  expect((await f.service.status(scope, session.id)).expiresAt).toBe(deadline);
  f.advance(11000);
  expect(await notify(f, session, 1)).toEqual({ error: 1 });
  expect((await f.service.status(scope, session.id)).state).toBe("expired");
  expect((await f.service.open(scope, "a.docx")).state).toBe("editing");
});

// 用户主动关闭仍立即处理最终的无修改回调，不能被后来的重连重新打开。
test("explicit close remains terminal and immediately releases the file", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  await f.service.close(scope, session.id);
  expect(await notify(f, session, 4)).toEqual({ error: 0 });
  expect((await f.service.status(scope, session.id)).state).toBe("closed");
  expect(await notify(f, session, 1)).toEqual({ error: 1 });
  expect((await f.service.open(scope, "a.docx")).state).toBe("editing");
});

// 放弃已撤销的会话不能通过提供方的重连回调恢复写入权限。
test("discarded sessions cannot reconnect", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  await f.service.discard(scope, session.id);
  expect(await notify(f, session, 1)).toEqual({ error: 1 });
});
