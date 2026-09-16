import { describe, expect, test } from "bun:test";
import { formatFileWsCloseLog } from "../transport/file-ws-close-log";

describe("file-ws close logging", () => {
  // 文件 WebSocket 关闭时必须保留连接标识、关闭码和关闭原因，便于定位底层断链。
  test("formats close code and reason", () => {
    expect(formatFileWsCloseLog("file_ws_test", 1009, "message too large")).toBe(
      "[File-WS] Connection closed: wsId=file_ws_test code=1009 reason=message too large",
    );
  });
});
