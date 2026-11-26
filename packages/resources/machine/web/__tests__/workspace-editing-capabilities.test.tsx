import { expect, test } from "bun:test";
import { type EditingClient, EditingError } from "@fenix/file-editing/contracts";
import { act } from "react";
import {
  button,
  client,
  deferred,
  edit,
  fileSizes,
  host,
  render,
  setEnvironment,
  setTreeDelay,
  settle,
  snapshot,
  startEditing,
  writes,
} from "./workspace-editing-fixture";

// 旧沙盒和未声明文本能力的服务只提供预览，不能进入必然失败的版本化读取。
test.each([false, undefined])("unsupported text capability %s keeps preview without editing", async (enabled) => {
  client.capabilities = async () => ({
    ...(enabled === undefined ? {} : { text: { enabled } }),
    textMaxBytes: 2097152,
    office: { enabled: false, extensions: [], maxBytes: 96468992 },
  });
  client.readText = async () => {
    throw new Error("Unsupported runtime must stay in preview");
  };
  render(["note.txt"], "note.txt");
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]'))).toBe(false);
  expect(host.querySelector('a[aria-label="Download"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

// 能力未确认时不得抢先开放文本入口，确认支持后继续原来的编辑保存。
test("text editing waits for confirmed runtime capabilities", async () => {
  const pending = deferred<Awaited<ReturnType<EditingClient["capabilities"]>>>();
  client.capabilities = () => pending.promise;
  render(["note.txt"], "note.txt");
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]:not(:disabled)'))).toBe(false);
  pending.resolve({
    text: { enabled: true },
    textMaxBytes: 2097152,
    office: { enabled: false, extensions: [], maxBytes: 96468992 },
  });
  await startEditing();
  expect(host.querySelector(".cm-editor")).not.toBeNull();
});

// 文件树已有尺寸超过文本限制时，应保留预览而不重复读取超大文件来尝试编辑。
test.each([2097152, 2097153, 96468992])("known text size %s determines preview edit availability", async (size) => {
  Object.assign(fileSizes, { "large.txt": size });
  render(["large.txt"], "large.txt");
  await settle();
  const edit = host.querySelector('button[aria-label="Edit"]:not(:disabled)');
  expect(Boolean(edit)).toBe(size <= 2097152);
  expect(host.querySelector('a[aria-label="Download"]')).not.toBeNull();
});

// 刷新取得新尺寸后立即重算入口；缺少单个文件的尺寸时仍保留加载阶段的大小保护。
test("tree refresh recomputes text editing availability without an extra file read", async () => {
  Object.assign(fileSizes, { "large.txt": 96468992 });
  render(["large.txt"], "large.txt");
  await settle();
  expect(button("Edit", host).disabled).toBe(true);
  Object.assign(fileSizes, { "large.txt": 8 });
  act(() => button("Refresh", host).click());
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]:not(:disabled)'))).toBe(true);
});

// 迟到的尺寸更新只影响新的编辑入口，不能销毁已经输入的草稿。
test("an oversized tree update cannot destroy an existing text draft", async () => {
  Object.assign(fileSizes, { "note.txt": 8 });
  render(["note.txt"], "note.txt");
  await startEditing();
  edit("unsaved draft");
  Object.assign(fileSizes, { "note.txt": 96468992 });
  act(() => button("Refresh", host).click());
  await settle();
  expect(host.querySelector(".cm-content")?.textContent).toBe("unsaved draft");
  expect(writes).toHaveLength(0);
});

// 文本能力请求临时失败时应提供当前文件可操作的重试入口。
test("text capability failure can retry in the current preview", async () => {
  let fail = true;
  client.capabilities = async () => {
    if (fail) throw new Error("Capabilities temporarily unavailable");
    return {
      text: { enabled: true },
      textMaxBytes: 2097152,
      office: { enabled: false, extensions: [], maxBytes: 96468992 },
    };
  };
  render(["note.txt"], "note.txt");
  await settle();
  expect(Boolean(host.querySelector('[role="alert"]'))).toBe(true);
  fail = false;
  act(() => button("Retry", host).click());
  await startEditing();
  expect(Boolean(host.querySelector(".cm-editor"))).toBe(true);
});

// A→B→A期间没有取得新树时，旧的尺寸不能重新开放可能已经增长的文件。
test("returning to an environment waits for a fresh size snapshot", async () => {
  Object.assign(fileSizes, { "note.txt": 8 });
  render(["note.txt"], "note.txt");
  await settle();
  const pending = deferred<void>();
  setTreeDelay(pending.promise);
  setEnvironment("env-2");
  render(["note.txt"], "note.txt");
  await settle();
  setEnvironment("env-1");
  render(["note.txt"], "note.txt");
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]:not(:disabled)'))).toBe(false);
  Object.assign(fileSizes, { "note.txt": 96468992 });
  pending.resolve();
  await settle();
  expect(button("Edit", host).disabled).toBe(true);
});

// 干净文件增长超限后真正返回预览，后续缩小也不应未经操作自动进入编辑。
test("a clean text editor returns to preview when its file grows beyond the limit", async () => {
  let grown = false;
  client.readText = async ({ path }) => {
    if (grown) throw new EditingError("too-large", "textTooLarge");
    return snapshot(path);
  };
  Object.assign(fileSizes, { "note.txt": 8 });
  render(["note.txt"], "note.txt");
  await startEditing();
  grown = true;
  Object.assign(fileSizes, { "note.txt": 96468992 });
  act(() => button("Refresh", host).click());
  await settle();
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(false);
  grown = false;
  Object.assign(fileSizes, { "note.txt": 8 });
  act(() => button("Refresh", host).click());
  await settle();
  expect(Boolean(host.querySelector(".cm-editor"))).toBe(false);
  expect(Boolean(host.querySelector('button[aria-label="Edit"]:not(:disabled)'))).toBe(true);
});
