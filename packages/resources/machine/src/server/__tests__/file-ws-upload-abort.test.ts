import { afterEach, beforeEach, expect, test } from "bun:test";
import { initializeMachineModuleConfig } from "../testing";
import { closeAllFileWsConnections, handleFileWsOpen, handleFileWsRegister } from "../transport/file-ws-handler";
import { pendingRequestCount, sendFileOpAndWait } from "../transport/file-ws-requests";

beforeEach(() => {
  initializeMachineModuleConfig();
});
afterEach(closeAllFileWsConnections);
function connect() {
  const frames: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    send(data: string | Uint8Array) {
      frames.push(JSON.parse(String(data)));
    },
    close() {},
  };
  handleFileWsOpen(ws, "upload-abort-ws");
  handleFileWsRegister("upload-abort-ws", { machine_id: "upload-abort-machine" });
  return frames;
}

// 取消调用方保存必须立刻通知机器端中止暂存覆盖，并释放当前 pending 槽位。
test("aborted upload emits file cancel and releases its pending request", async () => {
  const frames = connect();
  const controller = new AbortController();
  const pending = sendFileOpAndWait("upload-abort-machine", "upload", { environmentId: "env" }, 1000, {
    signal: controller.signal,
  });
  const requestId = frames.find((frame) => frame.type === "file_op")?.request_id;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(frames).toContainEqual({ type: "file_op_cancel", request_id: requestId });
  expect(pendingRequestCount()).toBe(0);
});

// 上传超时不得只停止等待回执，仍须用既有取消帧阻止机器端迟到落盘。
test("upload timeout emits a cancellation frame", async () => {
  const frames = connect();
  await expect(sendFileOpAndWait("upload-abort-machine", "upload", { environmentId: "env" }, 5)).rejects.toThrow(
    "file_op timeout",
  );
  const requestId = frames.find((frame) => frame.type === "file_op")?.request_id;
  expect(frames).toContainEqual({ type: "file_op_cancel", request_id: requestId });
  expect(pendingRequestCount()).toBe(0);
});
