import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { remoteReadBinaryFile, remoteReadFile, remoteStat, remoteUploadFiles } from "../services/remote-file-service";
import { initializeMachineModuleConfig, stubFileWsTransport } from "../testing";
import {
  closeAllFileWsConnections,
  getFileCapabilities,
  handleFileWsClose,
  handleFileWsOpen,
  handleFileWsRegister,
} from "../transport/file-ws-handler";
import type { WsConnection } from "../transport/ws-types";

const VERSION = "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e";
beforeEach(() => {
  initializeMachineModuleConfig();
});
afterEach(() => {
  closeAllFileWsConnections();
  resetAllStubs();
});

// 声明只对当前活跃连接有效，旧机器或替换连接不能继承上一节点的覆盖能力。
test("file capabilities clear when a new old-runtime connection replaces the current node", () => {
  const ws: WsConnection = { readyState: 1, send() {}, close() {} };
  handleFileWsOpen(ws, "new");
  handleFileWsRegister("new", { machine_id: "machine", capabilities: { uploadOverwrite: true, contentVersion: true } });
  expect(getFileCapabilities("machine")).toEqual({ uploadOverwrite: true, contentVersion: true });
  handleFileWsOpen(ws, "old");
  handleFileWsRegister("old", { machine_id: "machine" });
  expect(getFileCapabilities("machine")).toEqual({ uploadOverwrite: false, contentVersion: false });
  handleFileWsClose(ws, "old");
  expect(getFileCapabilities("machine")).toEqual({ uploadOverwrite: false, contentVersion: false });
});

// 没有明确能力声明时必须拒绝覆盖，防止旧节点把保存操作降级成普通上传。
test("remote overwrite refuses nodes without explicit content-save capabilities", async () => {
  stubFileWsTransport({
    isFileWsConnected: () => true,
    sendFileOpAndWait: async () => {
      throw new Error("A legacy node must never receive conditional writes");
    },
  });
  await expect(
    remoteUploadFiles("machine", "env", "", [{ name: "a.txt", relativePath: "a.txt", content: "" }], {
      overwrite: true,
    }),
  ).rejects.toMatchObject({ statusCode: 503 });
});

// SHA-256 必须绑定回传内容，不能信任机器端传来的同大小旧版本。
test("remote snapshots reject a valid-looking hash for different returned bytes", async () => {
  stubFileWsTransport({
    isFileWsConnected: () => true,
    getFileCapabilities: () => ({ uploadOverwrite: true, contentVersion: true }),
    sendFileOpAndWait: async (_machine, _operation) => ({
      status: "ok",
      data: {
        name: "a.txt",
        path: "a.txt",
        size: 5,
        content: "other",
        data: Buffer.from("other").toString("base64"),
        version: VERSION,
        encoding: "utf-8",
        mimeType: "text/plain",
      },
    }),
  });
  await expect(remoteReadFile("machine", "env", "a.txt", { includeVersion: true })).rejects.toMatchObject({
    statusCode: 503,
  });
  await expect(remoteReadBinaryFile("machine", "env", "a.txt", { includeVersion: true })).rejects.toMatchObject({
    statusCode: 503,
  });
});

// 声称支持版本的节点必须实际提供合法版本，不能让编辑器在无条件下保存。
test("versioned remote stat rejects a response without a content version", async () => {
  stubFileWsTransport({
    isFileWsConnected: () => true,
    getFileCapabilities: () => ({ uploadOverwrite: true, contentVersion: true }),
    sendFileOpAndWait: async () => ({ status: "ok", data: { size: 5, isDirectory: false, modifiedAt: 1 } }),
  });
  await expect(remoteStat("machine", "env", "a.txt", { includeVersion: true })).rejects.toMatchObject({
    statusCode: 503,
  });
});
