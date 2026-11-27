import { afterEach, beforeEach, expect, test } from "bun:test";
import { NotFoundError } from "@fenix/platform-sdk";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { createStubSessionAuthGuardPlugin, setTestAuth } from "../../__tests__/guard-stubs";
import { createWebFsRoutes } from "../routes/web/fs";
import {
  initializeMachineModuleConfig,
  stubFileWsTransport,
  stubMachineEnvironment,
  stubMachineEnvironmentRecord,
} from "../testing";

const ENV_ID = "env-preview-etag";
const MACHINE_ID = "machine-preview-etag";
const FILE_PATH = "user/note.txt";
const HELLO_VERSION = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const routes = createWebFsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });
let content: string;
let modifiedAt: number | undefined;
let onRead: (() => void) | undefined;
let operations: string[];
let statFailureAt: number;
let statCount: number;
let textReadFails: boolean;
let versioned: boolean;
let reportedSize: number | undefined;

/** 请求真实文件路由，仅替换其外部认证、环境和 file-ws 依赖。 */
function read(query = "?preview=true", etag?: string): Promise<Response> {
  return routes.handle(
    new Request(`http://localhost/environments/${ENV_ID}/fs/${FILE_PATH}${query}`, {
      headers: etag ? { "If-None-Match": etag } : {},
    }),
  );
}

beforeEach(() => {
  content = "版本一";
  modifiedAt = 1000;
  onRead = undefined;
  operations = [];
  statFailureAt = 0;
  statCount = 0;
  textReadFails = false;
  versioned = false;
  reportedSize = undefined;
  initializeMachineModuleConfig({ defaultMachineId: MACHINE_ID });
  stubMachineEnvironmentRecord({ id: ENV_ID, organizationId: "org-preview", userId: "user-preview" });
  stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: MACHINE_ID }] }) }) }) });
  setTestAuth({
    user: { id: "user-preview", email: "preview@example.test", name: "preview" },
    authContext: { organizationId: "org-preview", userId: "user-preview", role: "member" },
  });
  stubFileWsTransport({
    isFileWsConnected: () => true,
    getFileCapabilities: () => ({ contentVersion: versioned, uploadOverwrite: versioned }),
    sendFileOpAndWait: async (machineId, operation, params) => {
      expect(machineId).toBe(MACHINE_ID);
      expect(params.environmentId).toBe(ENV_ID);
      expect(params.path).toBe(FILE_PATH);
      operations.push(operation);
      if (operation === "stat") {
        expect(params.includeVersion).toBeUndefined();
        if (++statCount === statFailureAt) throw new Error("injected file stat failure");
        return {
          status: "ok",
          data: { size: reportedSize ?? Buffer.byteLength(content), modifiedAt, isDirectory: false },
        };
      }
      if (operation === "read" && textReadFails) return { status: "error", error: "not a text file" };
      if (operation !== "read" && operation !== "read_binary") throw new Error(`Unexpected operation: ${operation}`);
      const snapshot = {
        name: "note.txt",
        path: FILE_PATH,
        size: reportedSize ?? Buffer.byteLength(content),
        ...(operation === "read"
          ? { content, encoding: "utf-8" }
          : { data: Buffer.from(content).toString("base64"), mimeType: "text/plain" }),
        ...(params.includeVersion === true ? { version: HELLO_VERSION } : {}),
      };
      onRead?.();
      return { status: "ok", data: snapshot };
    },
  });
});

afterEach(resetAllStubs);

// 新标签页和已有刷新地址都必须识别同大小保存，未变文件仍可使用条件缓存。
test.each([
  "?preview=true",
  "?mode=text",
  "?mode=binary",
  "?mode=auto",
])("远程读取 %s 用修改时间区分同大小内容", async (query) => {
  const first = await read(query);
  expect(first.status).toBe(200);
  expect(first.headers.get("etag")).toBe('"9-1000"');
  await first.text();
  content = "版本三";
  modifiedAt = 3000;
  const changed = await read(query, '"9-1000"');
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).toBe('"9-3000"');
  expect(changed.headers.get("cache-control")).toBe("no-cache");
  if (query === "?mode=text" || query === "?mode=auto") expect((await changed.json()).data.content).toBe("版本三");
  else expect(await changed.text()).toBe("版本三");
  const unchanged = await read(query, '"9-3000"');
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
});

// 升级前浏览器已经缓存的 size-only ETag 必须失效，避免仍显示旧正文。
test("旧 size-only ETag 不再命中远程预览", async () => {
  const response = await read("?preview=true", '"9"');
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toBe('"9-1000"');
  expect(await response.text()).toBe("版本一");
});

// 旧运行时可能在读取后采集到另一份文件的大小，不能用报告大小替代实际正文字节数。
test.each(["?mode=text", "?preview=true"])("%s 的正文大小与远端元数据不一致时不缓存", async (query) => {
  content = "版本一加长";
  reportedSize = 9;
  const response = await read(query, '"9-1000"');
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  if (query === "?mode=text") expect((await response.json()).data).toMatchObject({ content, size: 15 });
  else expect(await response.text()).toBe(content);
});

// 手动刷新必须绕过条件命中，即使修改时间被外部工具保留且 retry 地址重复使用。
test("重复 retry 地址的预览刷新始终读取新内容", async () => {
  const response = await read("?preview=true&retry=1", '"9-1000"');
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(await response.text()).toBe("版本一");
  content = "版本三";
  const refreshed = await read("?preview=true&retry=1", '"9-1000"');
  expect(refreshed.status).toBe(200);
  expect(refreshed.headers.get("cache-control")).toBe("no-store");
  expect(await refreshed.text()).toBe("版本三");
  expect(operations).toEqual(["read_binary", "read_binary"]);
});

// 并发写入时不能将旧正文标记为新版本，也不能错误返回 304 丢弃本次正文。
test.each(["mtime", "size"])("读取期间 %s 变化时不缓存正文", async (change) => {
  onRead = () => {
    content = change === "size" ? "版本一加长" : "版本二";
    if (change === "mtime") modifiedAt = 2000;
  };
  const response = await read("?preview=true", '"9-1000"');
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("版本一");
  onRead = undefined;
  const next = await read();
  expect(await next.text()).toBe(content);
  expect(next.headers.get("etag")).toBe(change === "mtime" ? '"9-2000"' : '"15-1000"');
});

// 缺失或无效的修改时间不能退回 size-only 缓存，必须返回正文并禁止存储。
test.each([undefined, 0, Number.NaN, -1])("修改时间 %s 不可靠时跳过条件缓存", async (mtime) => {
  modifiedAt = mtime;
  const response = await read("?preview=true", '"9"');
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("版本一");
});

// 元数据失败必须暴露文件服务错误，不能回退到可能过期的正文缓存。
test.each([1, 2])("第 %s 次 stat 失败返回文件服务错误", async (failureAt) => {
  statFailureAt = failureAt;
  const response = await read("?preview=true", '"9"');
  expect(response.status).toBe(503);
  expect((await response.json()).error.type).toBe("file_service_unavailable");
});

// auto 文本探测失败后的二进制回退同样受读取前后元数据校验保护。
test("auto 回退二进制仍使用修改时间校验", async () => {
  textReadFails = true;
  const response = await read("?mode=auto", '"9-1000"');
  expect(response.status).toBe(304);
  expect(operations).toEqual(["stat", "read", "read_binary", "stat"]);
});

// 显式内容版本已绑定正文，不应新增 stat 往返，也不能改变编辑保存的版本协议。
test("显式内容版本请求保留 SHA-256 ETag 且不额外查询 stat", async () => {
  content = "hello";
  versioned = true;
  const response = await read("?preview=true&includeVersion=true", `"${HELLO_VERSION}"`);
  expect(response.status).toBe(304);
  expect(response.headers.get("etag")).toBe(`"${HELLO_VERSION}"`);
  expect(operations).toEqual(["read_binary"]);
});

// 环境不可见时必须在任何远程文件查询之前拒绝，stat 不能绕过现有授权。
test("环境授权失败时不发送远程文件操作", async () => {
  stubMachineEnvironment({
    getOwnedEnvironment: async () => {
      throw new NotFoundError("环境不存在");
    },
  });
  const response = await read();
  expect(response.status).toBe(404);
  expect(operations).toEqual([]);
});
