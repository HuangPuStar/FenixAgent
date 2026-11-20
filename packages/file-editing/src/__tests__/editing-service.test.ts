import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { jwtVerify } from "jose";
import { createEditingService, createMemoryEditingSessionStorage } from "../server";
import { saveCallback, scope, secret, services, setup, signed, urls } from "./editing-service-fixture";

// 默认不显示拼写标记，且编辑器收到的默认配置必须与 JWT 内签名内容一致。
test("Office initialization signs spellcheck disabled without disabling editing", async () => {
  const f = setup();
  for (const extension of ["docx", "xlsx", "pptx"]) {
    const session = await f.service.open(scope, `spelling.${extension}`);
    const config = session.initialization.config;
    expect(config).toMatchObject({
      document: { permissions: { edit: true } },
      editorConfig: { mode: "edit", customization: { features: { spellcheck: false } } },
    });
    const { payload } = await jwtVerify(String(config.token), new TextEncoder().encode(secret));
    expect(payload.editorConfig).toEqual(config.editorConfig);
  }
});

// 保存回执必须等到文件条件写入完成，重复回调不能重复落盘。
test("forcesave correlates saveId and only reports committed bytes", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  expect((await f.service.document(urls(session).document)).version).toBe(session.version);
  const requested = await f.service.save(scope, session.id, "save-op");
  expect(await f.service.save(scope, session.id, "save-op")).toEqual(requested);
  expect((await f.service.status(scope, session.id)).lastSavedAt).toBeNull();
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]).toMatchObject({ c: "forcesave", key: urls(session).key, userdata: requested.saveId });
  expect(await saveCallback(f, session, requested.saveId)).toEqual({ error: 0 });
  expect(f.content()).toBe("edited");
  expect(f.uploads).toEqual([{ expectedVersion: session.version, opId: "save-op" }]);
  expect((await f.service.status(scope, session.id)).state).toBe("editing");
  expect((await f.service.status(scope, session.id)).lastSavedAt).not.toBeNull();
  expect(await saveCallback(f, session, requested.saveId)).toEqual({ error: 0 });
  expect(f.uploads).toHaveLength(1);
});

// 未知代次、错误身份及用途混用不能获取或覆盖工作区文件。
test("tokens, ownership and unknown save generations fail closed", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const target = urls(session);
  await expect(f.service.status({ ...scope, userId: "other" }, session.id)).rejects.toMatchObject({
    code: "not-found",
  });
  await expect(f.service.document(target.callback)).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.service.document(`${target.document.slice(0, -5)}xxxxx`)).rejects.toMatchObject({ code: "forbidden" });
  expect(await saveCallback(f, session, "unknown")).toEqual({ error: 1 });
  const save = await f.service.save(scope, session.id, "op");
  expect(await saveCallback(f, session, save.saveId, { key: "other" })).toEqual({ error: 1 });
  expect(await saveCallback(f, session, save.saveId, { filetype: "xlsx" })).toEqual({ error: 1 });
  expect(f.content()).toBe("original");
});

// 文件发生外部变更后保留冲突结果，用户裁决也只能执行一次新版本条件覆盖。
test("conflict overwrite uses fresh version and verified cached result", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  f.change("external");
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 0 });
  expect((await f.service.status(scope, session.id)).state).toBe("conflict");
  expect(f.content()).toBe("external");
  expect((await f.service.overwrite(scope, session.id)).state).toBe("editing");
  expect(f.content()).toBe("edited");
  expect(f.uploads[0]?.expectedVersion).toBe(createHash("sha256").update("external").digest("hex"));
});

// 覆盖前重新下载的内容变动不能借原冲突结果授权落盘。
test("overwrite rejects changed provider result", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  f.change("external");
  await saveCallback(f, session, save.saveId);
  f.setOutput("different");
  await expect(f.service.overwrite(scope, session.id)).rejects.toMatchObject({ code: "conflict" });
  expect(f.content()).toBe("external");
});

// 关闭是终止保存代次，迟到的普通保存不能再次写回。
test("final close callback rejects late ordinary saves", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  await f.service.close(scope, session.id);
  const target = urls(session);
  expect(
    await f.service.callback(
      target.callback,
      await signed({ key: target.key, status: 2, filetype: "docx", url: "https://docs.example/cache/final.docx" }),
    ),
  ).toEqual({ error: 0 });
  expect((await f.service.status(scope, session.id)).state).toBe("closed");
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 1 });
  expect(f.uploads).toHaveLength(1);
});

// 放弃、过期、撤权及无共享会话均不能走无版本写入兜底。
test("discarded expired revoked and missing sessions never write", async () => {
  for (const mode of ["discard", "expire", "revoke", "missing"]) {
    const f = setup({ idleTtlMs: 100 });
    const session = await f.service.open(scope, "a.docx");
    const save = await f.service.save(scope, session.id, "op");
    if (mode === "discard") await f.service.discard(scope, session.id);
    if (mode === "expire") f.advance(101);
    if (mode === "revoke") f.revoke();
    if (mode === "missing") {
      await f.service.dispose();
    }
    expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 1 });
    expect(f.content()).toBe("original");
  }
});

// 只有配置的 origin 可以下载，流式超限和 HTTP 重定向都要显式失败。
test("provider download enforces origin redirects and byte limits", async () => {
  for (const mode of ["origin", "userinfo", "redirect", "size"]) {
    const f = setup({ maxFileBytes: 12 });
    const session = await f.service.open(scope, "a.docx");
    const save = await f.service.save(scope, session.id, "op");
    if (mode === "redirect")
      f.setResponse(() => new Response(null, { status: 302, headers: { Location: "https://evil.example" } }));
    if (mode === "size") f.setOutput("a".repeat(13));
    const url =
      mode === "origin"
        ? "https://evil.example/file"
        : mode === "userinfo"
          ? "https://user:pass@docs.example/file"
          : "https://docs.example/file";
    expect(await saveCallback(f, session, save.saveId, { url })).toEqual({ error: 1 });
    expect(f.content()).toBe("original");
    expect((await f.service.status(scope, session.id)).state).toBe("save-failed");
  }
});

// 提供方无修改响应仍须检查磁盘版本，不能误报外部改动已保存。
test("no-change command detects external changes", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  f.setCommandError(4);
  f.change("external");
  await f.service.save(scope, session.id, "op");
  expect((await f.service.status(scope, session.id)).state).toBe("conflict");
  expect((await f.service.status(scope, session.id)).lastSavedAt).toBeNull();
});

// 同一文件的可写会话与用户限额在共享存储下仍要原子生效。
test("shared storage reserves scoped files and enforces quota", async () => {
  const f = setup();
  const storage = createMemoryEditingSessionStorage({ policy: { maxUserSessions: 1 } });
  const another = createEditingService({
    config: { publicUrl: "https://docs.example", baseUrl: "https://app.example", jwtSecret: secret },
    files: f.files,
    storage,
  });
  services.push(another);
  const session = await another.open(scope, "a.docx");
  await expect(another.open(scope, "a.docx")).rejects.toMatchObject({ code: "busy" });
  await expect(another.open(scope, "b.docx")).rejects.toMatchObject({ code: "busy" });
  await another.discard(scope, session.id);
  expect((await another.open(scope, "a.docx")).state).toBe("editing");
});

// 终止回调失败后可重试同一关闭代次，但已完成的普通代次不能在终止后复写。
test("final generation can retry failure and permanently fences previous saves", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const saved = await f.service.save(scope, session.id, "first");
  await saveCallback(f, session, saved.saveId);
  const target = urls(session);
  const final = await signed({
    key: target.key,
    status: 2,
    filetype: "docx",
    url: "https://docs.example/cache/final.docx",
  });
  f.setResponse(() => new Response(null, { status: 503 }));
  expect(await f.service.callback(target.callback, final)).toEqual({ error: 1 });
  f.setResponse(() => new Response("final"));
  expect(await f.service.callback(target.callback, final)).toEqual({ error: 0 });
  expect(f.content()).toBe("final");
  expect(await saveCallback(f, session, saved.saveId)).toEqual({ error: 1 });
});

// 下载仍在进行时主动放弃必须立即撤销写入权，不能等下载后再放弃。
test("discard revokes a callback while its download is still in flight", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  let resolve = (_value: Response) => {};
  let entered = () => {};
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const response = new Promise<Response>((done) => {
    resolve = done;
  });
  f.setResponse(() => {
    entered();
    return response as unknown as Response;
  });
  const callback = saveCallback(f, session, save.saveId);
  await started;
  await f.service.discard(scope, session.id);
  resolve(new Response("late"));
  expect(await callback).toEqual({ error: 1 });
  expect(f.content()).toBe("original");
});

// 回调只信 JWT 中的字段，未签名字段和回源时已变更的磁盘内容不能混入会话。
test("unsigned duplicate fields are ignored and baseline reads reject external changes", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const target = urls(session);
  const save = await f.service.save(scope, session.id, "op");
  const signedBody = await signed({
    key: target.key,
    status: 6,
    userdata: save.saveId,
    filetype: "docx",
    url: "https://evil.example/result",
  });
  expect(
    await f.service.callback(target.callback, { ...signedBody, url: "https://docs.example/result", status: 1 }),
  ).toEqual({ error: 1 });
  f.change("external");
  await expect(f.service.document(target.document)).rejects.toMatchObject({ code: "conflict" });
  expect(f.content()).toBe("external");
});

// 保存命令失败必须暴露类型化错误，并允许同一操作重试而不是永久停在失败状态。
test("failed commands can retry the same registered save generation", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  f.setCommandError(1);
  await expect(f.service.save(scope, session.id, "retry-op")).rejects.toMatchObject({ code: "unavailable" });
  expect((await f.service.status(scope, session.id)).state).toBe("save-failed");
  f.setCommandError(0);
  const retry = await f.service.save(scope, session.id, "retry-op");
  expect((await f.service.status(scope, session.id)).state).toBe("saving");
  expect(f.commands).toHaveLength(2);
  expect(await saveCallback(f, session, retry.saveId)).toEqual({ error: 0 });
  expect(f.content()).toBe("edited");
});

// 下载超时必须取消响应流，失败后不能留下在途下载配额。
test("stream timeout cancels provider response and releases capacity", async () => {
  const f = setup({ timeoutMs: 20, maxDownloads: 1 });
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "timeout-op");
  let cancelled = false;
  f.setResponse(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 1 });
  expect(cancelled).toBe(true);
  f.setResponse(() => new Response("retried"));
  expect(await saveCallback(f, session, save.saveId)).toEqual({ error: 0 });
  expect(f.content()).toBe("retried");
});

// 查询可延长空闲时间，但不能绕过最长寿命或关闭收尾窗口。
test("idle activity cannot extend hard age or closing grace", async () => {
  const f = setup({ idleTtlMs: 100, maxSessionAgeMs: 250, closingGraceMs: 30 });
  const session = await f.service.open(scope, "a.docx");
  f.advance(90);
  expect((await f.service.status(scope, session.id)).state).toBe("editing");
  f.advance(90);
  expect((await f.service.status(scope, session.id)).state).toBe("editing");
  f.advance(71);
  expect((await f.service.status(scope, session.id)).state).toBe("expired");
  const second = await f.service.open(scope, "b.docx");
  await f.service.close(scope, second.id);
  f.advance(31);
  expect((await f.service.status(scope, second.id)).state).toBe("expired");
});

// 同一服务的在途下载受统一上限约束，拒绝的结果不会占用保存回执。
test("concurrent callback downloads respect the service-wide capacity", async () => {
  const f = setup({ maxDownloads: 1 });
  const first = await f.service.open(scope, "a.docx");
  const second = await f.service.open(scope, "b.docx");
  const a = await f.service.save(scope, first.id, "a");
  const b = await f.service.save(scope, second.id, "b");
  let resolve = (_value: Response) => {};
  let entered = () => {};
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const response = new Promise<Response>((done) => {
    resolve = done;
  });
  f.setResponse(() => {
    entered();
    return response as unknown as Response;
  });
  const pending = saveCallback(f, first, a.saveId);
  await started;
  expect(await saveCallback(f, second, b.saveId)).toEqual({ error: 1 });
  expect((await f.service.status(scope, second.id)).error?.code).toBe("busy");
  resolve(new Response("result"));
  expect(await pending).toEqual({ error: 0 });
});

// 重复保存回执只承认同一内容与格式，不能把相同 saveId 当作任意结果的成功回执。
test("duplicate callback receipts require matching content and format", async () => {
  const f = setup();
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  await saveCallback(f, session, save.saveId);
  expect(await saveCallback(f, session, save.saveId, { filetype: "xlsx" })).toEqual({ error: 1 });
  f.setOutput("changed-result");
  expect(await saveCallback(f, session, save.saveId, { url: "https://docs.example/cache/other.docx" })).toEqual({
    error: 1,
  });
  expect(f.content()).toBe("edited");
  expect(f.uploads).toHaveLength(1);
});

// 已关闭会话只消耗有界回执空间，不能令用户反复关闭后永久失去新建额度。
test("closed session receipts do not block future active admissions", async () => {
  const f = setup({ maxSessions: 1 });
  for (let index = 0; index < 5; index += 1) {
    const session = await f.service.open(scope, "a.docx");
    await f.service.discard(scope, session.id);
  }
  expect((await f.service.open(scope, "a.docx")).state).toBe("editing");
});

// 命令已受理而回调缺失时，轮询必须显示超时失败并允许原代次重试。
test("accepted saves time out without a callback and remain retryable", async () => {
  const f = setup({ timeoutMs: 25 });
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "missing-callback");
  f.advance(26);
  expect((await f.service.status(scope, session.id)).state).toBe("save-failed");
  expect(await f.service.save(scope, session.id, "missing-callback")).toEqual(save);
  expect((await f.service.status(scope, session.id)).state).toBe("saving");
});

// 服务关闭必须主动取消仍在读取的文档流，不能留下最长两分钟的后台下载。
test("dispose cancels owned provider downloads", async () => {
  const f = setup({ timeoutMs: 200 });
  const session = await f.service.open(scope, "a.docx");
  const save = await f.service.save(scope, session.id, "op");
  let entered = () => {};
  let cancelled = false;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setResponse(() => {
    entered();
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const callback = saveCallback(f, session, save.saveId);
  await started;
  await f.service.dispose();
  await Bun.sleep(5);
  expect(cancelled).toBe(true);
  expect(await callback).toEqual({ error: 1 });
  expect(f.content()).toBe("original");
});
