import { expect, test } from "bun:test";
import { createEditingService, createMemoryEditingSessionStorage } from "../server";
import { saveCallback, scope, secret, services, setup } from "./editing-service-fixture";

// 新租约查询不能续期已失去持有者的提交，预算结束后只能释放占用并报告未知结果。
test("abandoned commits have a bounded phase and never become a successful receipt", async () => {
  const fixture = setup();
  let now = Date.now();
  const policy = { timeoutMs: 20, idleTtlMs: 100 };
  const storage = createMemoryEditingSessionStorage({ policy, now: () => now });
  const service = createEditingService({
    config: { publicUrl: "https://docs.example", baseUrl: "https://app.example", jwtSecret: secret },
    files: fixture.files,
    storage,
    policy,
    now: () => now,
  });
  services.push(service);
  const session = await service.open(scope, "a.docx");
  await storage.withLease(session.id, async (lease) => {
    const record = await storage.get(session.id);
    if (!record) throw new Error("Session missing");
    record.commitOwner = lease.owner;
    await storage.put(record, lease);
  });
  const deadline = (await storage.get(session.id))?.commitExpiresAt;
  if (!deadline) throw new Error("Commit deadline missing");
  expect(deadline - now).toBeGreaterThanOrEqual(120000);
  for (let index = 0; index < 5; index += 1) {
    now += 25;
    await service.status(scope, session.id);
    expect((await storage.get(session.id))?.commitExpiresAt).toBe(deadline);
  }
  now = deadline + 1;
  const status = await service.status(scope, session.id);
  expect(status.state).toBe("save-failed");
  expect(status.error?.code).toBe("unavailable");
  expect(status.lastSavedAt).toBeNull();
  await expect(service.discard(scope, session.id)).rejects.toMatchObject({ code: "unavailable" });
  expect((await service.open(scope, "a.docx")).state).toBe("editing");
});

// 服务关闭必须把取消信号传到已经开始的文件执行端口，不仅取消提供方 HTTP 下载。
test("dispose aborts the signal of a file commit already in progress", async () => {
  const fixture = setup();
  const session = await fixture.service.open(scope, "a.docx");
  const save = await fixture.service.save(scope, session.id, "op");
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  fixture.files.upload = async (_scope, _path, _bytes, options) =>
    new Promise((_resolve, reject) => {
      signal = options.signal;
      if (!signal) throw new Error("Missing commit signal");
      entered();
      signal.addEventListener("abort", () => reject(signal?.reason), { once: true });
    });
  const callback = saveCallback(fixture, session, save.saveId);
  await started;
  await fixture.service.dispose();
  expect(signal?.aborted).toBe(true);
  expect(await callback).toEqual({ error: 1 });
  expect(fixture.content()).toBe("original");
});

// 新建会话也必须回收已过安全窗口的失联提交，不能要求调用方先知道旧会话 ID 再查询。
test("new admission recovers a deadline-expired foreign commit without polling the old id", async () => {
  const fixture = setup();
  let now = Date.now();
  const policy = { timeoutMs: 20 };
  const storage = createMemoryEditingSessionStorage({ policy, now: () => now });
  const service = createEditingService({
    config: { publicUrl: "https://docs.example", baseUrl: "https://app.example", jwtSecret: secret },
    files: fixture.files,
    storage,
    policy,
    now: () => now,
  });
  services.push(service);
  const session = await service.open(scope, "a.docx");
  await storage.withLease(session.id, async (lease) => {
    const record = await storage.get(session.id);
    if (!record) throw new Error("Session missing");
    record.commitOwner = lease.owner;
    await storage.put(record, lease);
  });
  now = ((await storage.get(session.id))?.commitExpiresAt ?? now) + 1;
  expect((await service.open(scope, "a.docx")).state).toBe("editing");
  expect((await service.status(scope, session.id)).state).toBe("save-failed");
  expect((await service.status(scope, session.id)).lastSavedAt).toBeNull();
});

// 端口忽略取消时 HTTP 保存仍须有界返回未知结果，迟到成功或失败都不能补写成功状态。
test.each(["resolve", "reject"] as const)("ignored upload cancellation stays unknown after a late %s", async (late) => {
  const fixture = setup({ timeoutMs: 20 });
  const session = await fixture.service.open(scope, "a.docx");
  const save = await fixture.service.save(scope, session.id, "op");
  let complete = () => {};
  fixture.files.upload = async () =>
    new Promise((resolve, reject) => {
      complete = () =>
        late === "resolve"
          ? resolve({ path: "a.docx", size: 6, version: "late" })
          : reject(new Error("late transport rejection"));
    });
  const callback = saveCallback(fixture, session, save.saveId);
  const result = await Promise.race([callback, Bun.sleep(150).then(() => ({ error: 99 }))]);
  complete();
  await callback;
  await Bun.sleep(5);
  expect(result).toEqual({ error: 1 });
  const status = await fixture.service.status(scope, session.id);
  expect(status.state).toBe("save-failed");
  expect(status.lastSavedAt).toBeNull();
});

// 丢失回执后的读回也共享同一截止时间，不能把超时转移成另一次无界等待。
test("upload receipt recovery readback shares the same bounded deadline", async () => {
  const fixture = setup({ timeoutMs: 20 });
  const session = await fixture.service.open(scope, "a.docx");
  const save = await fixture.service.save(scope, session.id, "op");
  const read = fixture.files.readSnapshot;
  let complete = () => {};
  fixture.files.upload = async () => {
    throw new Error("transport receipt lost");
  };
  fixture.files.readSnapshot = async (...args) =>
    new Promise((resolve, reject) => {
      complete = () => {
        void read(...args).then(resolve, reject);
      };
    });
  const callback = saveCallback(fixture, session, save.saveId);
  const result = await Promise.race([callback, Bun.sleep(150).then(() => ({ error: 99 }))]);
  complete();
  await callback;
  expect(result).toEqual({ error: 1 });
  expect((await fixture.service.status(scope, session.id)).lastSavedAt).toBeNull();
});
