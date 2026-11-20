import { expect, spyOn, test } from "bun:test";
import { EditingError, type OfficeSession } from "../../contracts";
import { openOfficeSession } from "../hooks/office-operations";

const file = { environmentId: "environment-a", path: "report.docx" };
const session: OfficeSession = {
  id: "session-a",
  state: "editing",
  conflict: false,
  lastSavedAt: null,
  version: "v1",
  expiresAt: 100000,
  initialization: { scriptUrl: "/office/api.js", config: {} },
  maxBytes: 100,
};

// OnlyOffice 关闭回调释放占用后，快速重开应自动完成，而不是留下忙碌错误页。
test("reopens after a transient busy Office admission", async () => {
  let calls = 0;
  const opened = await openOfficeSession(
    {
      openOffice: async () => {
        if (++calls === 1) throw new EditingError("busy", "File already has an editing session");
        return session;
      },
    },
    file,
    new AbortController().signal,
  );
  expect(opened).toBe(session);
  expect(calls).toBe(2);
});

// 用户切走文件或环境后，应立即取消等待，不再发起打开请求。
test("cancels a pending Office retry without another request", async () => {
  let calls = 0;
  const abort = new AbortController();
  const reason = new DOMException("Cancelled", "AbortError");
  const opened = openOfficeSession(
    {
      openOffice: async () => {
        calls++;
        queueMicrotask(() => abort.abort(reason));
        throw new EditingError("busy", "Busy");
      },
    },
    file,
    abort.signal,
  );
  await expect(opened).rejects.toBe(reason);
  expect(calls).toBe(1);
});

// 权限、网络等失败不是确定拒绝的忙碌请求，必须原样暴露，不盲目重试。
test("preserves non-busy failures without retrying", async () => {
  let calls = 0;
  const failure = new EditingError("forbidden", "Access denied");
  await expect(
    openOfficeSession(
      {
        openOffice: async () => {
          calls++;
          throw failure;
        },
      },
      file,
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(1);
});

// 请求耗时也计入等待预算，预算耗尽后保留原始忙碌错误并停止重试。
test("stops retrying when the Office opening budget is exhausted", async () => {
  let now = 0;
  let calls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const failure = new EditingError("busy", "File already has an editing session");
  try {
    await expect(
      openOfficeSession(
        {
          openOffice: async () => {
            calls++;
            now += 6000;
            throw failure;
          },
        },
        file,
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(2);
  } finally {
    clock.mockRestore();
  }
});
