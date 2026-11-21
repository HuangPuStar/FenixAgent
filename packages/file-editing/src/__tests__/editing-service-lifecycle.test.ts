import { expect, test } from "bun:test";
import { EditingError } from "../../contracts";
import { saveCallback, scope, setup } from "./editing-service-fixture";

function gate() {
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    async wait() {
      entered();
      await blocked;
    },
  };
}

// 放弃成功必须等待已开始的写入收口，不能在返回成功后继续改变磁盘内容。
test("discard drains a commit already in progress before returning success", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  const paused = gate();
  const original = f.files.upload;
  f.files.upload = async (...args) => {
    await paused.wait();
    return original(...args);
  };
  const callback = saveCallback(f, session, save.saveId);
  await paused.started;
  let complete = false;
  const discarded = f.service.discard(scope, session.id).then(() => {
    complete = true;
  });
  await Bun.sleep(5);
  const returnedBeforeCommit = complete;
  paused.release();
  await Promise.all([callback, discarded]);
  expect(returnedBeforeCommit).toBe(false);
  const final = f.content();
  await Bun.sleep(5);
  expect(f.content()).toBe(final);
  expect((await f.service.status(scope, session.id)).state).toBe("closed");
});

// 无法在预算内确认写入已结束时，放弃必须返回 busy 而不是误报收口成功。
test("discard reports busy when an in-flight upload cannot be drained", async () => {
  const f = setup({ timeoutMs: 20 });
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  const paused = gate();
  const original = f.files.upload;
  f.files.upload = async (...args) => {
    await paused.wait();
    return original(...args);
  };
  const callback = saveCallback(f, session, save.saveId);
  await paused.started;
  try {
    await expect(f.service.discard(scope, session.id)).rejects.toMatchObject({ code: "busy" });
  } finally {
    paused.release();
    await callback;
  }
});

// 文件被外部删除后仍可凭当前环境授权放弃会话，重建路径不能被旧声明阻塞。
test("discard reauthorizes scope without requiring the file to still exist", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const stat = f.files.stat;
  f.files.stat = async () => {
    throw new EditingError("not-found", "File deleted");
  };
  await f.service.discard(scope, session.id);
  f.files.stat = stat;
  expect((await f.service.open(scope, "a.docx")).state).toBe("editing");
});

// 写入成功但回执丢失时，通过精确内容摘要读回确认落盘，不能永久误报版本冲突。
test("lost upload receipt is recovered by reading the exact committed digest", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  const upload = f.files.upload;
  let lost = true;
  f.files.upload = async (...args) => {
    const saved = await upload(...args);
    if (lost) {
      lost = false;
      throw new EditingError("unavailable", "Receipt lost");
    }
    return saved;
  };
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 0 });
  expect((await f.service.status(scope, session.id)).state).toBe("editing");
  expect(f.uploads).toHaveLength(1);
});

// 重复 URL 的内容也可能改变，已完成回执必须重新核对内容摘要。
test("duplicate callback rechecks digest even when provider URL is unchanged", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  await saveCallback(f, session, save.saveId);
  f.setOutput("different");
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 1 });
  expect(f.content()).toBe("edited");
});

// 回调活性要先写入共享控制存储，下载期间不能发出第二份可写文件声明。
test("callback activity persists its renewed claim before downloading results", async () => {
  const f = setup({ idleTtlMs: 100 });
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  f.advance(90);
  const paused = gate();
  f.setResponse(() => {
    void paused.wait();
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          await paused.wait();
          controller.enqueue(new TextEncoder().encode("edited"));
          controller.close();
        },
      }),
    );
  });
  const callback = saveCallback(f, session, save.saveId);
  await paused.started;
  f.advance(20);
  try {
    await expect(f.service.open(scope, "a.docx")).rejects.toMatchObject({ code: "busy" });
  } finally {
    paused.release();
    await callback;
  }
});

// 失败后新操作必须开启新代次，迟到的旧保存不能替代用户的新意图。
test("a new operation after failure fences the previous generation", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const first = await f.service.save(scope, session.id, "request-a");
  f.setResponse(() => new Response(null, { status: 503 }));
  await saveCallback(f, session, first.saveId);
  f.setResponse(() => new Response("new-result"));
  const second = await f.service.save(scope, session.id, "request-b");
  expect(second.saveId).not.toBe(first.saveId);
  expect(await saveCallback(f, session, first.saveId)).toEqual({ error: 1 });
  expect(await saveCallback(f, session, second.saveId)).toEqual({ error: 0 });
  expect(f.content()).toBe("new-result");
});

// 关闭窗口过期不能释放已经开始提交的文件占用，必须等真实 I/O 结束后才准入新会话。
test("an active final upload reserves its file beyond the closing deadline", async () => {
  const { urls, signed } = await import("./editing-service-fixture");
  const f = setup({ closingGraceMs: 20 });
  const session = await f.service.open(scope, "a.docx");
  await f.service.close(scope, session.id);
  const paused = gate();
  const original = f.files.upload;
  f.files.upload = async (...args) => {
    await paused.wait();
    return original(...args);
  };
  const target = urls(session);
  const callback = f.service.callback(
    target.callback,
    await signed({ key: target.key, status: 2, filetype: "docx", url: "https://docs.example/final.docx" }),
  );
  await paused.started;
  f.advance(21);
  try {
    await expect(f.service.open(scope, "a.docx")).rejects.toMatchObject({ code: "busy" });
  } finally {
    paused.release();
    expect(await callback).toEqual({ error: 0 });
  }
  expect((await f.service.open(scope, "a.docx")).state).toBe("editing");
});

// 首次读回也失效时仍可通过原操作重试，条件冲突后核对实际摘要恢复保存回执。
test("lost receipts can recover on a later callback without rewriting committed bytes", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  const upload = f.files.upload;
  const read = f.files.readSnapshot;
  let lost = true;
  let readFails = true;
  f.files.upload = async (...args) => {
    const saved = await upload(...args);
    if (lost) {
      lost = false;
      throw new EditingError("unavailable", "Receipt lost");
    }
    return saved;
  };
  f.files.readSnapshot = async (...args) => {
    if (readFails) {
      readFails = false;
      throw new EditingError("unavailable", "Readback unavailable");
    }
    return read(...args);
  };
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 1 });
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 0 });
  expect(f.uploads).toHaveLength(1);
});

// 无新修改回复不证明 iframe 输入已进入提供方缓存，不能把它当作工作区保存成功。
test("a no-change provider reply cannot acknowledge an unverified workspace save", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  f.setCommandError(4);
  await expect(f.service.save(scope, session.id, "unflushed")).rejects.toMatchObject({ code: "unavailable" });
  const status = await f.service.status(scope, session.id);
  expect(status.state).toBe("save-failed");
  expect(status.lastSavedAt).toBeNull();
});

// 传输超时只代表取消已请求，未读回精确结果前不能把未知写入当作已完成放弃。
test("unconfirmed upload cancellation exposes unknown outcome instead of discard success", async () => {
  const f = setup({ timeoutMs: 20 });
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  f.files.upload = async (_scope, _path, _bytes, options) =>
    new Promise((_resolve, reject) => {
      const signal = options.signal;
      if (!signal) throw new Error("Missing commit cancellation signal");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 1 });
  const status = await f.service.status(scope, session.id);
  expect(status.state).toBe("save-failed");
  expect(status.lastSavedAt).toBeNull();
  await expect(f.service.discard(scope, session.id)).rejects.toMatchObject({ code: "unavailable" });
  expect(f.content()).toBe("original");
});
