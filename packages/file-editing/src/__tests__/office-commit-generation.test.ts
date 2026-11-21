import { expect, test } from "bun:test";
import { EditingError } from "../../contracts";
import { saveCallback, scope, setup } from "./editing-service-fixture";

// 未确认的旧上传不能被新保存恰好匹配当前磁盘的内容误认为已经结束。
test("an unknown upload blocks a different save generation until its own result is confirmed", async () => {
  const f = setup({ timeoutMs: 20 });
  const session = await f.service.open(scope, "a.docx");
  const first = await f.service.save(scope, session.id, "save-a");
  const original = f.files.upload;
  let complete!: () => void;
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.files.upload = (...args) =>
    new Promise((resolve, reject) => {
      complete = () => void original(...args).then(resolve, reject);
      entered();
    });
  const uploadA = saveCallback(f, session, first.saveId);
  await started;
  expect(await uploadA).toEqual({ error: 1 });
  f.setOutput("original");
  await expect(f.service.save(scope, session.id, "save-b")).rejects.toMatchObject({ code: "unavailable" });
  expect((await f.service.status(scope, session.id)).lastSavedAt).toBeNull();
  complete();
  await Bun.sleep(0);
  f.files.upload = original;
  f.setOutput("edited");
  expect(await saveCallback(f, session, first.saveId)).toEqual({ error: 0 });
  f.setOutput("original");
  const second = await f.service.save(scope, session.id, "save-b");
  expect(await saveCallback(f, session, second.saveId)).toEqual({ error: 0 });
  expect(f.content()).toBe("original");
});

// 相同保存编号也不能用另一份内容清除旧上传的占用。
test("a retried save cannot reconcile an earlier upload using different bytes", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "same-save");
  const original = f.files.upload;
  let fail = true;
  f.files.upload = async (...args) => {
    if (fail) throw new EditingError("unavailable", "Unknown remote outcome");
    return original(...args);
  };
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 1 });
  f.setOutput("original");
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 1 });
  expect((await f.service.status(scope, session.id)).lastSavedAt).toBeNull();
  fail = false;
  f.change("edited");
  f.setOutput("edited");
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 0 });
});
